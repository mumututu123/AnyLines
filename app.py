#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AnyLine —— 在线事务管理网站 (Flask + SQLite)"""
import json
import os
import sqlite3
from io import BytesIO
from datetime import date

from flask import Flask, g, jsonify, request, send_file, send_from_directory
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from werkzeug.exceptions import HTTPException

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anyline.db")
DEFAULT_STATUS_ENUM = ["未启动", "进行中", "有风险", "等待中", "已暂停", "已闭环", "已取消"]
PRIORITY_ENUM = ["低", "中", "高", "紧急"]
TASK_EXPORT_COLUMNS = (
    ("事务ID", "id", 12),
    ("线名", "line_name", 20),
    ("线类型", "line_type", 12),
    ("父线", "parent_name", 20),
    ("事务名", "name", 24),
    ("事务内容", "content", 36),
    ("闭环目标", "goal", 28),
    ("下一步动作", "next_action", 28),
    ("风险原因", "risk_reason", 28),
    ("优先级", "priority", 12),
    ("责任人", "owner", 16),
    ("进展状态", "status", 14),
    ("起始日期", "start_date", 14),
    ("结束日期", "end_date", 14),
    ("状态起始日期", "status_since", 16),
    ("更新日期", "updated_at", 14),
)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["DATABASE"] = os.environ.get("ANYLINE_DB_PATH", DB_PATH)


# ---------------------------------------------------------------- db helpers
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(db_path=None):
    db = sqlite3.connect(db_path or app.config["DATABASE"])
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS lines (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            description TEXT DEFAULT '',
            color      TEXT,
            parent_id  INTEGER,                 -- NULL = 主线
            fork_date  TEXT NOT NULL,           -- 线的起点(支线=分叉日)
            merge_date TEXT,                    -- 反合回父线的日期, NULL=未反合
            deleted    INTEGER NOT NULL DEFAULT 0,
            del_batch  INTEGER,
            deleted_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            line_id      INTEGER NOT NULL,
            name         TEXT NOT NULL,
            content      TEXT DEFAULT '',
            goal         TEXT DEFAULT '',
            owner        TEXT DEFAULT '',
            priority     TEXT NOT NULL DEFAULT '中',
            next_action  TEXT DEFAULT '',
            risk_reason  TEXT DEFAULT '',
            status       TEXT NOT NULL DEFAULT '未启动',
            start_date   TEXT NOT NULL,
            end_date     TEXT,
            status_since TEXT NOT NULL,         -- 当前进展状态的开始日, 用于计算停留时长
            deleted      INTEGER NOT NULL DEFAULT 0,
            del_batch    INTEGER,
            deleted_at   TEXT,
            updated_at   TEXT
        );
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    ensure_column(db, "lines", "description", "TEXT DEFAULT ''")
    ensure_column(db, "lines", "color", "TEXT")
    ensure_column(db, "lines", "deleted_at", "TEXT")
    ensure_column(db, "lines", "updated_at", "TEXT")
    ensure_column(db, "tasks", "priority", "TEXT NOT NULL DEFAULT '中'")
    ensure_column(db, "tasks", "next_action", "TEXT DEFAULT ''")
    ensure_column(db, "tasks", "risk_reason", "TEXT DEFAULT ''")
    ensure_column(db, "tasks", "deleted_at", "TEXT")
    ensure_column(db, "tasks", "updated_at", "TEXT")
    today = date.today().isoformat()
    db.execute("UPDATE lines SET updated_at=? WHERE updated_at IS NULL", (today,))
    db.execute("UPDATE tasks SET updated_at=? WHERE updated_at IS NULL", (today,))
    db.commit()
    db.close()


def ensure_column(db, table, column, ddl):
    cols = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


class ApiError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def json_object():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("请求体必须是 JSON 对象")
    return data


def required_id(value, field):
    if not isinstance(value, int) or isinstance(value, bool):
        raise ApiError(f"{field} 必须是整数")
    return value


def text_field(data, key, label, default="", nullable=False):
    value = data.get(key, default)
    if nullable and value is None:
        return None
    if not isinstance(value, str):
        raise ApiError(f"{label} 必须是字符串")
    return value


def line_color(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#" or \
            any(char not in "0123456789abcdefABCDEF" for char in value[1:]):
        raise ApiError("颜色必须是 #RRGGBB 格式")
    return value.lower()


def task_export_workbook(rows):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "事务"
    headers = [column[0] for column in TASK_EXPORT_COLUMNS]
    sheet.append(headers)

    header_fill = PatternFill("solid", fgColor="DDEBF7")
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    date_keys = {"start_date", "end_date", "status_since", "updated_at"}
    for row in rows:
        sheet.append([None] * len(TASK_EXPORT_COLUMNS))
        row_index = sheet.max_row
        for column_index, (_, key, _) in enumerate(TASK_EXPORT_COLUMNS, 1):
            value = row[key]
            cell = sheet.cell(row_index, column_index)
            if key in date_keys and value:
                try:
                    cell.value = date.fromisoformat(value)
                    cell.number_format = "yyyy-mm-dd"
                    continue
                except ValueError:
                    pass
            cell.value = "" if value is None else value
            if isinstance(cell.value, str):
                # 避免以 =、+、-、@ 开头的用户内容被 Excel 当作公式执行。
                cell.data_type = "s"

    last_column = get_column_letter(len(TASK_EXPORT_COLUMNS))
    sheet.auto_filter.ref = f"A1:{last_column}{sheet.max_row}"
    sheet.freeze_panes = "A2"
    sheet.row_dimensions[1].height = 22
    for index, (_, _, width) in enumerate(TASK_EXPORT_COLUMNS, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output


@app.errorhandler(ApiError)
def handle_api_error(exc):
    return jsonify({"error": str(exc)}), exc.status


@app.errorhandler(HTTPException)
def handle_http_error(exc):
    if request.path.startswith("/api/"):
        return jsonify({"error": exc.description}), exc.code
    return exc


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    app.logger.exception("Unhandled application error", exc_info=exc)
    if request.path.startswith("/api/"):
        return jsonify({"error": "服务器处理请求失败"}), 500
    return "Internal Server Error", 500


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
    """编辑操作不再清空回收站，仅保留最近删除批次的快捷撤销能力。"""
    return None


def new_batch(db):
    """新的删除操作: 返回新批次号, 回收站历史批次继续保留。"""
    batch = int(get_meta(db, "batch_seq") or 0) + 1
    set_meta(db, "batch_seq", batch)
    set_meta(db, "undo_batch", batch)
    return batch


def parse_iso_date(value, field):
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式")
    if parsed.isoformat() != value:
        raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式")
    return parsed


def validate_date_range(start, end):
    s = parse_iso_date(start, "起始日期")
    e = parse_iso_date(end, "结束日期")
    if s and e and e < s:
        raise ValueError("结束日期不能早于起始日期")


def get_statuses(db):
    raw = get_meta(db, "statuses")
    statuses = None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and all(isinstance(s, str) for s in parsed):
                statuses = [s.strip() for s in parsed if s.strip()]
        except ValueError:
            statuses = None
    statuses = statuses or list(DEFAULT_STATUS_ENUM)
    # 保留历史数据中的状态, 避免配置变更后老事务无法编辑。
    rows = db.execute(
        "SELECT DISTINCT status FROM tasks WHERE status IS NOT NULL ORDER BY status"
    ).fetchall()
    for r in rows:
        if r["status"] and r["status"] not in statuses:
            statuses.append(r["status"])
    return statuses


# ------------------------------------------------------------------- routes
@app.route("/")
def index():
    return send_from_directory(str(app.static_folder), "index.html")


@app.route("/api/state")
def api_state():
    db = get_db()
    lines = [dict(r) for r in db.execute(
        "SELECT id,name,description,color,parent_id,fork_date,merge_date,updated_at "
        "FROM lines "
        "WHERE deleted=0 ORDER BY id")]
    tasks = [dict(r) for r in db.execute(
        "SELECT t.id,t.line_id,t.name,t.content,t.goal,t.owner,t.priority,"
        "t.next_action,t.risk_reason,t.status,t.start_date,t.end_date,"
        "t.status_since,t.updated_at FROM tasks t "
        "JOIN lines l ON l.id=t.line_id "
        "WHERE t.deleted=0 AND l.deleted=0 ORDER BY t.start_date,t.id")]
    return jsonify({
        "lines": lines,
        "tasks": tasks,
        "can_undo": get_meta(db, "undo_batch") is not None,
        "status_enum": get_statuses(db),
        "priority_enum": PRIORITY_ENUM,
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
    d = json_object()
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


# ----- statuses (进展状态配置)
@app.route("/api/statuses", methods=["GET"])
def api_get_statuses():
    return jsonify({"statuses": get_statuses(get_db())})


@app.route("/api/statuses", methods=["PUT"])
def api_set_statuses():
    d = json_object()
    statuses = d.get("statuses")
    if not isinstance(statuses, list) or \
            not all(isinstance(s, str) for s in statuses):
        return jsonify({"error": "statuses 必须是字符串数组"}), 400
    cleaned, seen = [], set()
    for s in statuses:
        s = s.strip()
        if s and s not in seen:
            seen.add(s)
            cleaned.append(s)
    if not cleaned:
        return jsonify({"error": "进展状态不能为空"}), 400
    db = get_db()
    set_meta(db, "statuses", json.dumps(cleaned, ensure_ascii=False))
    db.commit()
    return jsonify({"ok": True, "statuses": get_statuses(db)})


# ----- lines
@app.route("/api/lines", methods=["POST"])
def create_line():
    d = json_object()
    name = text_field(d, "name", "线名").strip()
    description = text_field(d, "description", "描述").strip()
    color = line_color(d.get("color"))
    if not name:
        return jsonify({"error": "线名不能为空"}), 400
    parent_id = d.get("parent_id")
    if parent_id is not None:
        required_id(parent_id, "parent_id")
    fork_date = text_field(
        d, "fork_date", "起始日期", date.today().isoformat()
    ) or date.today().isoformat()
    if not fork_date:
        return jsonify({"error": "起始日期不能为空"}), 400
    try:
        parse_iso_date(fork_date, "起始日期")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    db = get_db()
    if parent_id is not None:
        p = db.execute(
            "SELECT id,fork_date FROM lines WHERE id=? AND deleted=0", (parent_id,)
        ).fetchone()
        if not p:
            return jsonify({"error": "父线不存在"}), 404
        if fork_date < p["fork_date"]:
            return jsonify({"error": "支线起始日期不能早于父线起始日期"}), 400
    on_edit(db)
    cur = db.execute(
        "INSERT INTO lines(name,description,color,parent_id,fork_date,updated_at) "
        "VALUES(?,?,?,?,?,?)",
        (name, description, color, parent_id, fork_date, date.today().isoformat()),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/lines/<int:lid>", methods=["PATCH"])
def update_line(lid):
    d = json_object()
    if d.get("merge_date") == "":
        d["merge_date"] = None
    db = get_db()
    row = db.execute(
        "SELECT * FROM lines WHERE id=? AND deleted=0", (lid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "线不存在"}), 404
    new_name = text_field(d, "name", "线名", row["name"])
    new_description = text_field(
        d, "description", "描述", row["description"] or ""
    )
    new_color = line_color(d.get("color", row["color"]))
    new_fork = text_field(d, "fork_date", "起始日期", row["fork_date"])
    new_merge = text_field(
        d, "merge_date", "反合日期", row["merge_date"], nullable=True
    )
    if "name" in d and not (new_name or "").strip():
        return jsonify({"error": "线名不能为空"}), 400
    if "name" in d:
        d["name"] = new_name.strip()
    if "description" in d:
        d["description"] = new_description.strip()
    if "color" in d:
        d["color"] = new_color
    if not new_fork:
        return jsonify({"error": "起始日期不能为空"}), 400
    try:
        parse_iso_date(new_fork, "起始日期")
        parse_iso_date(new_merge, "反合日期")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if new_merge is not None and row["parent_id"] is None:
        return jsonify({"error": "主线不能反合"}), 400
    if new_merge is not None and new_merge < new_fork:
        return jsonify({"error": "反合日期不能早于支线起始日期"}), 400
    if row["parent_id"] is not None:
        parent = db.execute(
            "SELECT fork_date FROM lines WHERE id=? AND deleted=0",
            (row["parent_id"],),
        ).fetchone()
        if parent and new_fork < parent["fork_date"]:
            return jsonify({"error": "支线起始日期不能早于父线起始日期"}), 400
    child = db.execute(
        "SELECT MIN(fork_date) AS first_date FROM lines "
        "WHERE parent_id=? AND deleted=0", (lid,)
    ).fetchone()
    if child["first_date"] and child["first_date"] < new_fork:
        return jsonify({"error": "起始日期不能晚于子支线的起始日期"}), 400
    task = db.execute(
        "SELECT MIN(start_date) AS first_date FROM tasks "
        "WHERE line_id=? AND deleted=0", (lid,)
    ).fetchone()
    if task["first_date"] and task["first_date"] < new_fork:
        return jsonify({"error": "起始日期不能晚于线上已有事务的起始日期"}), 400

    fields, vals = [], []
    for k in ("name", "description", "color", "fork_date", "merge_date"):
        if k in d:
            fields.append(f"{k}=?")
            vals.append(d[k])
    if fields:
        on_edit(db)
        fields.append("updated_at=?")
        vals.append(date.today().isoformat())
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
    today = date.today().isoformat()
    db.execute(
        f"UPDATE lines SET deleted=1, del_batch=?, deleted_at=? WHERE id IN ({marks})",
        [batch, today] + ids,
    )
    db.execute(
        f"UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? WHERE deleted=0 "
        f"AND line_id IN ({marks})",
        [batch, today] + ids,
    )
    db.commit()
    return jsonify({"ok": True, "can_undo": True})


# ----- tasks
@app.route("/api/tasks", methods=["POST"])
def create_task():
    d = json_object()
    name = text_field(d, "name", "事务名").strip()
    if not name:
        return jsonify({"error": "事务名不能为空"}), 400
    db = get_db()
    line_id = required_id(d.get("line_id"), "line_id")
    line = db.execute(
        "SELECT id,fork_date FROM lines WHERE id=? AND deleted=0", (line_id,)
    ).fetchone()
    if not line:
        return jsonify({"error": "所属线不存在"}), 404
    status = text_field(d, "status", "进展状态", "未启动") or "未启动"
    if status not in get_statuses(db):
        return jsonify({"error": "非法的进展状态"}), 400
    priority = text_field(d, "priority", "优先级", "中") or "中"
    if priority not in PRIORITY_ENUM:
        return jsonify({"error": "非法的优先级"}), 400
    today = date.today().isoformat()
    start_date = text_field(d, "start_date", "起始日期", today) or today
    end_date = text_field(d, "end_date", "结束日期", None, nullable=True) or None
    content = text_field(d, "content", "事务内容")
    goal = text_field(d, "goal", "闭环目标")
    owner = text_field(d, "owner", "责任人")
    next_action = text_field(d, "next_action", "下一步动作")
    risk_reason = text_field(d, "risk_reason", "风险原因")
    try:
        validate_date_range(start_date, end_date)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if start_date < line["fork_date"]:
        return jsonify({"error": "事务起始日期不能早于所属线起始日期"}), 400
    on_edit(db)
    cur = db.execute(
        "INSERT INTO tasks(line_id,name,content,goal,owner,priority,next_action,"
        "risk_reason,status,start_date,end_date,status_since,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            line_id, name, content, goal, owner, priority,
            next_action, risk_reason,
            status, start_date, end_date, today,
            today,
        ),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/tasks/<int:tid>", methods=["PATCH"])
def update_task(tid):
    d = json_object()
    if d.get("end_date") == "":
        d["end_date"] = None
    db = get_db()
    row = db.execute(
        "SELECT * FROM tasks WHERE id=? AND deleted=0", (tid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "事务不存在"}), 404
    new_start = text_field(d, "start_date", "起始日期", row["start_date"])
    new_end = text_field(
        d, "end_date", "结束日期", row["end_date"], nullable=True
    )
    new_line_id = d.get("line_id", row["line_id"])
    required_id(new_line_id, "line_id")
    if not new_start:
        return jsonify({"error": "起始日期不能为空"}), 400
    try:
        validate_date_range(new_start, new_end)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    target_line = db.execute(
        "SELECT fork_date FROM lines WHERE id=? AND deleted=0", (new_line_id,)
    ).fetchone()
    if not target_line:
        return jsonify({"error": "所属线不存在"}), 404
    if new_start < target_line["fork_date"]:
        return jsonify({"error": "事务起始日期不能早于所属线起始日期"}), 400

    fields, vals = [], []
    for k in ("line_id", "name", "content", "goal", "owner", "priority",
              "next_action", "risk_reason", "status", "start_date", "end_date"):
        if k not in d:
            continue
        if k == "line_id":
            required_id(d[k], "line_id")
        else:
            d[k] = text_field(
                d, k,
                {"name": "事务名", "content": "事务内容", "goal": "闭环目标",
                 "owner": "责任人", "priority": "优先级", "next_action": "下一步动作",
                 "risk_reason": "风险原因", "status": "进展状态",
                 "start_date": "起始日期", "end_date": "结束日期"}[k],
                nullable=(k == "end_date"),
            )
        if k == "name" and not (d[k] or "").strip():
            return jsonify({"error": "事务名不能为空"}), 400
        if k == "name":
            d[k] = d[k].strip()
        if k == "priority" and d[k] not in PRIORITY_ENUM:
            return jsonify({"error": "非法的优先级"}), 400
        if k == "status":
            if d[k] not in get_statuses(db):
                return jsonify({"error": "非法的进展状态"}), 400
            if d[k] != row["status"]:   # 状态变化 -> 重新计时
                fields.append("status_since=?")
                vals.append(date.today().isoformat())
        fields.append(f"{k}=?")
        vals.append(d[k])
    if fields:
        on_edit(db)
        fields.append("updated_at=?")
        vals.append(date.today().isoformat())
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
    db.execute(
        "UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? WHERE id=?",
        (batch, date.today().isoformat(), tid),
    )
    db.commit()
    return jsonify({"ok": True, "can_undo": True})


@app.route("/api/tasks/export", methods=["POST"])
def export_tasks():
    d = json_object()
    scope = d.get("scope")
    params = []
    id_clause = ""
    if scope == "selected":
        ids = d.get("ids")
        if not isinstance(ids, list) or not ids or \
                not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
            return jsonify({"error": "ids 必须是非空整数数组"}), 400
        if len(ids) != len(set(ids)):
            return jsonify({"error": "ids 不能包含重复项"}), 400
        marks = ",".join("?" * len(ids))
        id_clause = f" AND t.id IN ({marks})"
        params = ids
    elif scope != "all":
        return jsonify({"error": "scope 必须是 all 或 selected"}), 400

    db = get_db()
    rows = [dict(row) for row in db.execute(
        "SELECT t.id,l.name AS line_name,"
        "CASE WHEN l.parent_id IS NULL THEN '主线' ELSE '支线' END AS line_type,"
        "p.name AS parent_name,t.name,t.content,t.goal,t.next_action,"
        "t.risk_reason,t.priority,t.owner,t.status,t.start_date,t.end_date,"
        "t.status_since,t.updated_at FROM tasks t "
        "JOIN lines l ON l.id=t.line_id "
        "LEFT JOIN lines p ON p.id=l.parent_id "
        "WHERE t.deleted=0 AND l.deleted=0" + id_clause +
        " ORDER BY t.start_date,t.id",
        params,
    ).fetchall()]
    if scope == "selected" and len(rows) != len(params):
        return jsonify({"error": "部分事务不存在或已删除"}), 404

    output = task_export_workbook(rows)
    scope_name = "全部事务" if scope == "all" else "选中事务"
    filename = f"AnyLine-{scope_name}-{date.today():%Y%m%d}.xlsx"
    return send_file(
        output,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=filename,
    )


@app.route("/api/tasks/bulk", methods=["PATCH", "DELETE"])
def bulk_tasks():
    d = json_object()
    ids = d.get("ids")
    if not isinstance(ids, list) or not ids or \
            not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        return jsonify({"error": "ids 必须是非空整数数组"}), 400
    if len(ids) != len(set(ids)):
        return jsonify({"error": "ids 不能包含重复项"}), 400
    db = get_db()
    marks = ",".join("?" * len(ids))
    existing = db.execute(
        f"SELECT id FROM tasks WHERE deleted=0 AND id IN ({marks})", ids
    ).fetchall()
    if len(existing) != len(set(ids)):
        return jsonify({"error": "部分事务不存在或已删除"}), 404

    if request.method == "DELETE":
        batch = new_batch(db)
        db.execute(
            f"UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? "
            f"WHERE id IN ({marks})",
            [batch, date.today().isoformat()] + ids,
        )
        db.commit()
        return jsonify({"ok": True, "count": len(ids), "can_undo": True})

    patch = d.get("patch")
    if not isinstance(patch, dict) or not patch:
        return jsonify({"error": "patch 不能为空"}), 400
    allowed = {"line_id", "owner", "priority", "status"}
    unknown = set(patch) - allowed
    if unknown:
        return jsonify({"error": "批量更新不支持该字段"}), 400
    if "priority" in patch and patch["priority"] not in PRIORITY_ENUM:
        return jsonify({"error": "非法的优先级"}), 400
    if "status" in patch and patch["status"] not in get_statuses(db):
        return jsonify({"error": "非法的进展状态"}), 400
    if "owner" in patch and not isinstance(patch["owner"], str):
        return jsonify({"error": "责任人必须是字符串"}), 400
    if "line_id" in patch:
        required_id(patch["line_id"], "line_id")
        ln = db.execute(
            "SELECT id,fork_date FROM lines WHERE id=? AND deleted=0",
            (patch["line_id"],)
        ).fetchone()
        if not ln:
            return jsonify({"error": "所属线不存在"}), 404
        first_task = db.execute(
            f"SELECT MIN(start_date) AS first_date FROM tasks "
            f"WHERE deleted=0 AND id IN ({marks})", ids
        ).fetchone()
        if first_task["first_date"] < ln["fork_date"]:
            return jsonify({"error": "部分事务的起始日期早于目标线起始日期"}), 400

    fields, vals = [], []
    for k, v in patch.items():
        fields.append(f"{k}=?")
        vals.append(v)
        if k == "status":
            fields.append("status_since=?")
            vals.append(date.today().isoformat())
    fields.append("updated_at=?")
    vals.append(date.today().isoformat())
    db.execute(
        f"UPDATE tasks SET {','.join(fields)} WHERE id IN ({marks})",
        vals + ids,
    )
    db.commit()
    return jsonify({"ok": True, "count": len(ids)})


# ----- undo
@app.route("/api/undo", methods=["POST"])
def undo():
    db = get_db()
    batch = get_meta(db, "undo_batch")
    if batch is None:
        return jsonify({"error": "没有可撤销的删除"}), 400
    db.execute(
        "UPDATE lines SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE del_batch=?", (batch,)
    )
    db.execute(
        "UPDATE tasks SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE del_batch=?", (batch,)
    )
    set_meta(db, "undo_batch", None)
    db.commit()
    return jsonify({"ok": True})


# ----- trash
@app.route("/api/trash", methods=["GET"])
def trash():
    db = get_db()
    line_rows = [dict(r) for r in db.execute(
        "SELECT id,name,parent_id,fork_date,merge_date,del_batch,deleted_at "
        "FROM lines WHERE deleted=1 ORDER BY deleted_at DESC,id DESC"
    )]
    task_rows = [dict(r) for r in db.execute(
        "SELECT id,line_id,name,status,owner,priority,start_date,end_date,"
        "del_batch,deleted_at FROM tasks WHERE deleted=1 "
        "ORDER BY deleted_at DESC,id DESC"
    )]
    batches = {}
    for row in line_rows:
        b = str(row["del_batch"])
        batches.setdefault(b, {
            "batch": row["del_batch"], "deleted_at": row["deleted_at"],
            "line_count": 0, "task_count": 0, "names": [],
        })
        batches[b]["line_count"] += 1
        batches[b]["names"].append(row["name"])
    for row in task_rows:
        b = str(row["del_batch"])
        batches.setdefault(b, {
            "batch": row["del_batch"], "deleted_at": row["deleted_at"],
            "line_count": 0, "task_count": 0, "names": [],
        })
        batches[b]["task_count"] += 1
        batches[b]["names"].append(row["name"])
    return jsonify({
        "batches": sorted(
            batches.values(),
            key=lambda x: (x["deleted_at"] or "", x["batch"] or 0),
            reverse=True,
        ),
        "lines": line_rows,
        "tasks": task_rows,
    })


@app.route("/api/trash/restore", methods=["POST"])
def restore_trash():
    d = json_object()
    batch = d.get("batch")
    if batch is None:
        return jsonify({"error": "batch 不能为空"}), 400
    required_id(batch, "batch")
    db = get_db()
    found = db.execute(
        "SELECT 1 FROM lines WHERE del_batch=? AND deleted=1 "
        "UNION SELECT 1 FROM tasks WHERE del_batch=? AND deleted=1",
        (batch, batch),
    ).fetchone()
    if not found:
        return jsonify({"error": "未找到该删除批次"}), 404
    blocked_line = db.execute(
        "SELECT child.id FROM lines child JOIN lines parent "
        "ON parent.id=child.parent_id WHERE child.del_batch=? AND child.deleted=1 "
        "AND parent.deleted=1 AND parent.del_batch<>? LIMIT 1", (batch, batch)
    ).fetchone()
    blocked_task = db.execute(
        "SELECT task.id FROM tasks task JOIN lines line ON line.id=task.line_id "
        "WHERE task.del_batch=? AND task.deleted=1 AND line.deleted=1 "
        "AND line.del_batch<>? LIMIT 1", (batch, batch)
    ).fetchone()
    if blocked_line or blocked_task:
        return jsonify({"error": "请先恢复该批次所依赖的所属线"}), 409
    db.execute(
        "UPDATE lines SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE del_batch=?", (batch,)
    )
    db.execute(
        "UPDATE tasks SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE del_batch=?", (batch,)
    )
    if str(get_meta(db, "undo_batch")) == str(batch):
        set_meta(db, "undo_batch", None)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/trash/purge", methods=["POST"])
def purge_trash():
    db = get_db()
    purge_deleted(db)
    db.commit()
    return jsonify({"ok": True})


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80, debug=False)
