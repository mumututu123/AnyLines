#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AnyLine —— 在线事务管理网站 (Flask + SQLite)"""
import json
import os
import sqlite3
from datetime import date

from flask import Flask, g, jsonify, request, send_from_directory

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anyline.db")
STATUS_ENUM = ["未启动", "进行中", "有风险", "已闭环"]

app = Flask(__name__, static_folder="static", static_url_path="/static")


# ---------------------------------------------------------------- db helpers
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS lines (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            parent_id  INTEGER,                 -- NULL = 主线
            fork_date  TEXT NOT NULL,           -- 线的起点(支线=分叉日)
            merge_date TEXT,                    -- 反合回父线的日期, NULL=未反合
            deleted    INTEGER NOT NULL DEFAULT 0,
            del_batch  INTEGER
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            line_id      INTEGER NOT NULL,
            name         TEXT NOT NULL,
            content      TEXT DEFAULT '',
            goal         TEXT DEFAULT '',
            owner        TEXT DEFAULT '',
            status       TEXT NOT NULL DEFAULT '未启动',
            start_date   TEXT NOT NULL,
            end_date     TEXT,
            status_since TEXT NOT NULL,         -- 当前进展状态的开始日, 用于计算停留时长
            deleted      INTEGER NOT NULL DEFAULT 0,
            del_batch    INTEGER
        );
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    db.commit()
    db.close()


# ------------------------------------------------------------- undo helpers
def get_meta(db, key):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(db, key, value):
    if value is None:
        db.execute("DELETE FROM meta WHERE key=?", (key,))
    else:
        db.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )


def purge_deleted(db):
    """物理删除所有软删除的行, 并清空撤销批次。"""
    db.execute("DELETE FROM tasks WHERE deleted=1")
    db.execute("DELETE FROM lines WHERE deleted=1")
    set_meta(db, "undo_batch", None)


def on_edit(db):
    """任何非删除的编辑操作 -> 之前的删除不再可撤销。"""
    purge_deleted(db)


def new_batch(db):
    """新的删除操作: 之前批次永久化, 返回新批次号。"""
    purge_deleted(db)
    batch = int(get_meta(db, "batch_seq") or 0) + 1
    set_meta(db, "batch_seq", batch)
    set_meta(db, "undo_batch", batch)
    return batch


# ------------------------------------------------------------------- routes
@app.route("/")
def index():
    return send_from_directory(str(app.static_folder), "index.html")


@app.route("/api/state")
def api_state():
    db = get_db()
    lines = [dict(r) for r in db.execute(
        "SELECT id,name,parent_id,fork_date,merge_date FROM lines "
        "WHERE deleted=0 ORDER BY id")]
    tasks = [dict(r) for r in db.execute(
        "SELECT id,line_id,name,content,goal,owner,status,start_date,"
        "end_date,status_since FROM tasks WHERE deleted=0 "
        "ORDER BY start_date,id")]
    return jsonify({
        "lines": lines,
        "tasks": tasks,
        "can_undo": get_meta(db, "undo_batch") is not None,
        "status_enum": STATUS_ENUM,
        "owners": get_owners(db),
        "today": date.today().isoformat(),
    })


# ----- owners (责任人名单)
def get_owners(db):
    raw = get_meta(db, "owners")
    if not raw:
        return []
    try:
        return json.loads(raw)
    except ValueError:
        return []


@app.route("/api/owners", methods=["GET"])
def api_get_owners():
    return jsonify({"owners": get_owners(get_db())})


@app.route("/api/owners", methods=["PUT"])
def api_set_owners():
    d = request.get_json(force=True)
    owners = d.get("owners")
    if not isinstance(owners, list) or \
            not all(isinstance(o, str) for o in owners):
        return jsonify({"error": "owners 必须是字符串数组"}), 400
    # 去空白、去重（保持顺序）
    cleaned, seen = [], set()
    for o in owners:
        o = o.strip()
        if o and o not in seen:
            seen.add(o)
            cleaned.append(o)
    db = get_db()
    set_meta(db, "owners", json.dumps(cleaned, ensure_ascii=False))
    db.commit()
    return jsonify({"ok": True, "owners": cleaned})


# ----- lines
@app.route("/api/lines", methods=["POST"])
def create_line():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "线名不能为空"}), 400
    parent_id = d.get("parent_id")
    fork_date = d.get("fork_date") or date.today().isoformat()
    db = get_db()
    if parent_id is not None:
        p = db.execute(
            "SELECT id FROM lines WHERE id=? AND deleted=0", (parent_id,)
        ).fetchone()
        if not p:
            return jsonify({"error": "父线不存在"}), 404
    on_edit(db)
    cur = db.execute(
        "INSERT INTO lines(name,parent_id,fork_date) VALUES(?,?,?)",
        (name, parent_id, fork_date),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/lines/<int:lid>", methods=["PATCH"])
def update_line(lid):
    d = request.get_json(force=True)
    db = get_db()
    row = db.execute(
        "SELECT * FROM lines WHERE id=? AND deleted=0", (lid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "线不存在"}), 404
    fields, vals = [], []
    for k in ("name", "fork_date", "merge_date"):
        if k in d:
            if k == "name" and not (d[k] or "").strip():
                return jsonify({"error": "线名不能为空"}), 400
            if k == "merge_date" and d[k] is not None and row["parent_id"] is None:
                return jsonify({"error": "主线不能反合"}), 400
            fields.append(f"{k}=?")
            vals.append(d[k])
    if fields:
        on_edit(db)
        vals.append(lid)
        db.execute(f"UPDATE lines SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
    return jsonify({"ok": True})


def collect_descendants(db, lid):
    ids = [lid]
    i = 0
    while i < len(ids):
        rows = db.execute(
            "SELECT id FROM lines WHERE parent_id=? AND deleted=0", (ids[i],)
        ).fetchall()
        ids.extend(r["id"] for r in rows)
        i += 1
    return ids


@app.route("/api/lines/<int:lid>", methods=["DELETE"])
def delete_line(lid):
    db = get_db()
    row = db.execute(
        "SELECT id FROM lines WHERE id=? AND deleted=0", (lid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "线不存在"}), 404
    batch = new_batch(db)
    ids = collect_descendants(db, lid)
    marks = ",".join("?" * len(ids))
    db.execute(
        f"UPDATE lines SET deleted=1, del_batch=? WHERE id IN ({marks})",
        [batch] + ids,
    )
    db.execute(
        f"UPDATE tasks SET deleted=1, del_batch=? WHERE deleted=0 "
        f"AND line_id IN ({marks})",
        [batch] + ids,
    )
    db.commit()
    return jsonify({"ok": True, "can_undo": True})


# ----- tasks
@app.route("/api/tasks", methods=["POST"])
def create_task():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "事务名不能为空"}), 400
    db = get_db()
    line = db.execute(
        "SELECT id FROM lines WHERE id=? AND deleted=0", (d.get("line_id"),)
    ).fetchone()
    if not line:
        return jsonify({"error": "所属线不存在"}), 404
    status = d.get("status") or "未启动"
    if status not in STATUS_ENUM:
        return jsonify({"error": "非法的进展状态"}), 400
    today = date.today().isoformat()
    on_edit(db)
    cur = db.execute(
        "INSERT INTO tasks(line_id,name,content,goal,owner,status,"
        "start_date,end_date,status_since) VALUES(?,?,?,?,?,?,?,?,?)",
        (
            d["line_id"], name,
            d.get("content") or "", d.get("goal") or "",
            d.get("owner") or "", status,
            d.get("start_date") or today,   # 起始日期默认当天
            d.get("end_date") or None, today,
        ),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/tasks/<int:tid>", methods=["PATCH"])
def update_task(tid):
    d = request.get_json(force=True)
    db = get_db()
    row = db.execute(
        "SELECT * FROM tasks WHERE id=? AND deleted=0", (tid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "事务不存在"}), 404
    fields, vals = [], []
    for k in ("line_id", "name", "content", "goal", "owner",
              "status", "start_date", "end_date"):
        if k not in d:
            continue
        if k == "name" and not (d[k] or "").strip():
            return jsonify({"error": "事务名不能为空"}), 400
        if k == "status":
            if d[k] not in STATUS_ENUM:
                return jsonify({"error": "非法的进展状态"}), 400
            if d[k] != row["status"]:   # 状态变化 -> 重新计时
                fields.append("status_since=?")
                vals.append(date.today().isoformat())
        if k == "line_id":
            ln = db.execute(
                "SELECT id FROM lines WHERE id=? AND deleted=0", (d[k],)
            ).fetchone()
            if not ln:
                return jsonify({"error": "所属线不存在"}), 404
        fields.append(f"{k}=?")
        vals.append(d[k])
    if fields:
        on_edit(db)
        vals.append(tid)
        db.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:tid>", methods=["DELETE"])
def delete_task(tid):
    db = get_db()
    row = db.execute(
        "SELECT id FROM tasks WHERE id=? AND deleted=0", (tid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "事务不存在"}), 404
    batch = new_batch(db)
    db.execute("UPDATE tasks SET deleted=1, del_batch=? WHERE id=?", (batch, tid))
    db.commit()
    return jsonify({"ok": True, "can_undo": True})


# ----- undo
@app.route("/api/undo", methods=["POST"])
def undo():
    db = get_db()
    batch = get_meta(db, "undo_batch")
    if batch is None:
        return jsonify({"error": "没有可撤销的删除"}), 400
    db.execute(
        "UPDATE lines SET deleted=0, del_batch=NULL WHERE del_batch=?", (batch,)
    )
    db.execute(
        "UPDATE tasks SET deleted=0, del_batch=NULL WHERE del_batch=?", (batch,)
    )
    set_meta(db, "undo_batch", None)
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=80, debug=False)
