#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AnyLine —— 在线事务管理网站 (Flask + SQLite)"""
import json
import os
import sqlite3
from io import BytesIO
from datetime import date

from flask import (
    Flask, g, jsonify, request, send_file, send_from_directory, session,
)
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anyline.db")
DEFAULT_STATUS_ENUM = ["未启动", "进行中", "有风险", "等待中", "已暂停", "已闭环", "已取消"]
DEFAULT_STATUS_COLORS = {
    "未启动": "#8c959f",
    "进行中": "#0969da",
    "有风险": "#d4a72c",
    "等待中": "#0e7490",
    "已暂停": "#8250df",
    "已闭环": "#1a7f37",
    "已取消": "#57606a",
}
FALLBACK_STATUS_COLOR = "#6e7781"
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
app.config.update(
    DATABASE=os.environ.get("ANYLINE_DB_PATH", DB_PATH),
    SECRET_KEY=os.environ.get(
        "ANYLINE_SECRET_KEY", "anyline-local-secret-change-in-production"
    ),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)


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
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
            display_name  TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            managed_by    INTEGER,
            active        INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_by  INTEGER NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INTEGER NOT NULL,
            user_id      INTEGER NOT NULL,
            role         TEXT NOT NULL CHECK(role IN ('admin','member')),
            joined_at    TEXT NOT NULL,
            PRIMARY KEY(workspace_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_meta (
            workspace_id INTEGER NOT NULL,
            key          TEXT NOT NULL,
            value        TEXT,
            PRIMARY KEY(workspace_id,key)
        );
        """
    )
    ensure_column(db, "lines", "description", "TEXT DEFAULT ''")
    ensure_column(db, "lines", "color", "TEXT")
    ensure_column(db, "lines", "deleted_at", "TEXT")
    ensure_column(db, "lines", "updated_at", "TEXT")
    ensure_column(db, "lines", "workspace_id", "INTEGER")
    ensure_column(db, "tasks", "priority", "TEXT NOT NULL DEFAULT '中'")
    ensure_column(db, "tasks", "next_action", "TEXT DEFAULT ''")
    ensure_column(db, "tasks", "risk_reason", "TEXT DEFAULT ''")
    ensure_column(db, "tasks", "deleted_at", "TEXT")
    ensure_column(db, "tasks", "updated_at", "TEXT")
    ensure_column(db, "tasks", "workspace_id", "INTEGER")
    ensure_column(db, "users", "managed_by", "INTEGER")
    today = date.today().isoformat()

    admin_username = os.environ.get("ANYLINE_ADMIN_USERNAME", "admin").strip() or "admin"
    admin_password = os.environ.get("ANYLINE_ADMIN_PASSWORD", "admin123")
    admin = db.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
    if not admin:
        cur = db.execute(
            "INSERT INTO users(username,display_name,password_hash,created_at,updated_at) "
            "VALUES(?,?,?,?,?)",
            (
                admin_username, "系统管理员", generate_password_hash(admin_password),
                today, today,
            ),
        )
        admin_id = cur.lastrowid
    else:
        admin_id = admin["id"]
    db.execute(
        "UPDATE users SET managed_by=id WHERE managed_by IS NULL AND id=?", (admin_id,)
    )

    workspace = db.execute("SELECT id FROM workspaces ORDER BY id LIMIT 1").fetchone()
    if not workspace:
        cur = db.execute(
            "INSERT INTO workspaces(name,description,created_by,created_at,updated_at) "
            "VALUES(?,?,?,?,?)",
            ("默认项目", "由原有 AnyLine 数据自动迁移", admin_id, today, today),
        )
        workspace_id = cur.lastrowid
    else:
        workspace_id = workspace["id"]
    db.execute(
        "INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,joined_at) "
        "VALUES(?,?,?,?)", (workspace_id, admin_id, "admin", today),
    )
    db.execute(
        "UPDATE lines SET workspace_id=? WHERE workspace_id IS NULL", (workspace_id,)
    )
    db.execute(
        "UPDATE tasks SET workspace_id=(SELECT workspace_id FROM lines "
        "WHERE lines.id=tasks.line_id) WHERE workspace_id IS NULL"
    )
    db.execute(
        "UPDATE tasks SET workspace_id=? WHERE workspace_id IS NULL", (workspace_id,)
    )
    db.execute(
        "INSERT OR IGNORE INTO workspace_meta(workspace_id,key,value) "
        "SELECT ?,key,value FROM meta", (workspace_id,)
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_lines_workspace_deleted "
        "ON lines(workspace_id,deleted)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_workspace_deleted "
        "ON tasks(workspace_id,deleted)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id)"
    )
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


# ------------------------------------------------------------- auth helpers
def user_workspaces(db, user_id):
    return [dict(row) for row in db.execute(
        "SELECT w.id,w.name,w.description,m.role FROM workspaces w "
        "JOIN workspace_members m ON m.workspace_id=w.id "
        "WHERE m.user_id=? ORDER BY w.name,w.id", (user_id,)
    )]


def current_workspace_id():
    return g.workspace["id"]


def require_workspace_admin(workspace_id=None):
    workspace_id = workspace_id or current_workspace_id()
    row = get_db().execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?",
        (workspace_id, g.user["id"]),
    ).fetchone()
    if not row or row["role"] != "admin":
        raise ApiError("仅项目空间管理员可执行此操作", 403)
    return row


def validate_username(value):
    if not isinstance(value, str):
        raise ApiError("账号必须是字符串")
    value = value.strip()
    if len(value) < 2 or len(value) > 40 or any(c.isspace() for c in value):
        raise ApiError("账号长度应为 2-40 个字符且不能包含空格")
    return value


def validate_password(value, required=True):
    if value in (None, "") and not required:
        return None
    if not isinstance(value, str) or len(value) < 6 or len(value) > 128:
        raise ApiError("密码长度应为 6-128 个字符")
    return value


@app.before_request
def load_authenticated_context():
    if not request.path.startswith("/api/"):
        return None
    if request.endpoint in {"auth_login", "auth_session"}:
        return None
    user_id = session.get("user_id")
    if not user_id:
        raise ApiError("请先登录", 401)
    db = get_db()
    user = db.execute(
        "SELECT id,username,display_name,active FROM users WHERE id=?", (user_id,)
    ).fetchone()
    if not user or not user["active"]:
        session.clear()
        raise ApiError("账号不可用，请重新登录", 401)
    g.user = user
    workspaces = user_workspaces(db, user["id"])
    if not workspaces:
        raise ApiError("账号尚未加入任何项目空间", 403)
    workspace_id = session.get("workspace_id")
    current = next((w for w in workspaces if w["id"] == workspace_id), None)
    if current is None:
        current = workspaces[0]
        session["workspace_id"] = current["id"]
    g.workspace = current
    return None


# ------------------------------------------------------------- undo helpers
def get_meta(db, key):
    row = db.execute(
        "SELECT value FROM workspace_meta WHERE workspace_id=? AND key=?",
        (current_workspace_id(), key),
    ).fetchone()
    return row["value"] if row else None


def set_meta(db, key, value):
    if value is None:
        db.execute(
            "DELETE FROM workspace_meta WHERE workspace_id=? AND key=?",
            (current_workspace_id(), key),
        )
    else:
        db.execute(
            "INSERT INTO workspace_meta(workspace_id,key,value) VALUES(?,?,?) "
            "ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value",
            (current_workspace_id(), key, str(value)),
        )


def purge_deleted(db):
    """物理删除所有软删除的行, 并清空撤销批次。"""
    workspace_id = current_workspace_id()
    db.execute(
        "DELETE FROM tasks WHERE deleted=1 AND workspace_id=?", (workspace_id,)
    )
    db.execute(
        "DELETE FROM lines WHERE deleted=1 AND workspace_id=?", (workspace_id,)
    )
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
        "SELECT DISTINCT status FROM tasks WHERE workspace_id=? "
        "AND status IS NOT NULL ORDER BY status", (current_workspace_id(),)
    ).fetchall()
    for r in rows:
        if r["status"] and r["status"] not in statuses:
            statuses.append(r["status"])
    return statuses


def get_status_colors(db, statuses=None):
    statuses = statuses or get_statuses(db)
    stored = {}
    raw = get_meta(db, "status_colors")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for status, color in parsed.items():
                    try:
                        normalized = line_color(color)
                    except ApiError:
                        continue
                    if isinstance(status, str) and status and normalized:
                        stored[status] = normalized
        except ValueError:
            pass
    return {
        status: stored.get(
            status, DEFAULT_STATUS_COLORS.get(status, FALLBACK_STATUS_COLOR)
        )
        for status in statuses
    }


# ------------------------------------------------------------------- routes
@app.route("/")
def index():
    return send_from_directory(str(app.static_folder), "index.html")


def session_payload(db, user):
    workspaces = user_workspaces(db, user["id"])
    if not workspaces:
        session.clear()
        raise ApiError("账号尚未加入任何项目空间，请联系管理员", 403)
    workspace_id = session.get("workspace_id")
    current = next((w for w in workspaces if w["id"] == workspace_id), None)
    if current is None and workspaces:
        current = workspaces[0]
        session["workspace_id"] = current["id"]
    return {
        "authenticated": True,
        "user": {
            "id": user["id"], "username": user["username"],
            "display_name": user["display_name"],
        },
        "workspaces": workspaces,
        "current_workspace": current,
    }


@app.route("/api/auth/session")
def auth_session():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"authenticated": False})
    db = get_db()
    user = db.execute(
        "SELECT id,username,display_name,active FROM users WHERE id=?", (user_id,)
    ).fetchone()
    if not user or not user["active"]:
        session.clear()
        return jsonify({"authenticated": False})
    return jsonify(session_payload(db, user))


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = json_object()
    username = validate_username(data.get("username"))
    password = data.get("password")
    if not isinstance(password, str):
        raise ApiError("密码必须是字符串")
    db = get_db()
    user = db.execute(
        "SELECT id,username,display_name,password_hash,active FROM users "
        "WHERE username=?", (username,)
    ).fetchone()
    if not user or not user["active"] or not check_password_hash(
            user["password_hash"], password):
        raise ApiError("账号或密码错误", 401)
    session.clear()
    session["user_id"] = user["id"]
    return jsonify(session_payload(db, user))


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/password", methods=["PUT"])
def auth_change_password():
    data = json_object()
    current_password = data.get("current_password")
    new_password = validate_password(data.get("new_password"))
    db = get_db()
    user = db.execute(
        "SELECT password_hash FROM users WHERE id=?", (g.user["id"],)
    ).fetchone()
    if not isinstance(current_password, str) or not check_password_hash(
            user["password_hash"], current_password):
        raise ApiError("当前密码错误", 400)
    db.execute(
        "UPDATE users SET password_hash=?,updated_at=? WHERE id=?",
        (generate_password_hash(new_password), date.today().isoformat(), g.user["id"]),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/workspaces", methods=["POST"])
def create_workspace():
    data = json_object()
    name = text_field(data, "name", "项目空间名称").strip()
    description = text_field(data, "description", "项目空间描述").strip()
    if not name:
        raise ApiError("项目空间名称不能为空")
    db = get_db()
    can_create = db.execute(
        "SELECT 1 FROM workspace_members WHERE user_id=? AND role='admin' LIMIT 1",
        (g.user["id"],),
    ).fetchone()
    if not can_create:
        raise ApiError("仅管理员可创建项目空间", 403)
    today = date.today().isoformat()
    cur = db.execute(
        "INSERT INTO workspaces(name,description,created_by,created_at,updated_at) "
        "VALUES(?,?,?,?,?)", (name, description, g.user["id"], today, today),
    )
    workspace_id = cur.lastrowid
    db.execute(
        "INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) "
        "VALUES(?,?,?,?)", (workspace_id, g.user["id"], "admin", today),
    )
    db.commit()
    session["workspace_id"] = workspace_id
    return jsonify({"id": workspace_id}), 201


@app.route("/api/workspaces/<int:workspace_id>", methods=["PATCH"])
def update_workspace(workspace_id):
    require_workspace_admin(workspace_id)
    data = json_object()
    fields, values = [], []
    for key, label in (("name", "项目空间名称"), ("description", "项目空间描述")):
        if key in data:
            value = text_field(data, key, label).strip()
            if key == "name" and not value:
                raise ApiError("项目空间名称不能为空")
            fields.append(f"{key}=?")
            values.append(value)
    if fields:
        fields.append("updated_at=?")
        values.extend([date.today().isoformat(), workspace_id])
        get_db().execute(
            f"UPDATE workspaces SET {','.join(fields)} WHERE id=?", values
        )
        get_db().commit()
    return jsonify({"ok": True})


@app.route("/api/workspaces/<int:workspace_id>/select", methods=["POST"])
def select_workspace(workspace_id):
    row = get_db().execute(
        "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?",
        (workspace_id, g.user["id"]),
    ).fetchone()
    if not row:
        raise ApiError("无权访问该项目空间", 403)
    session["workspace_id"] = workspace_id
    return jsonify({"ok": True})


@app.route("/api/workspaces/<int:workspace_id>/members", methods=["GET", "POST"])
def workspace_members(workspace_id):
    require_workspace_admin(workspace_id)
    db = get_db()
    if request.method == "GET":
        rows = [dict(row) for row in db.execute(
            "SELECT u.id,u.username,u.display_name,m.role,m.joined_at,"
            "CASE WHEN u.managed_by=? THEN 1 ELSE 0 END AS can_manage_account "
            "FROM workspace_members m JOIN users u ON u.id=m.user_id "
            "WHERE m.workspace_id=? ORDER BY m.role,u.display_name,u.id",
            (g.user["id"], workspace_id),
        )]
        return jsonify({"members": rows})

    data = json_object()
    username = validate_username(data.get("username"))
    display_name = text_field(data, "display_name", "姓名", username).strip() or username
    role = data.get("role", "member")
    if role not in {"admin", "member"}:
        raise ApiError("角色必须是 admin 或 member")
    user = db.execute(
        "SELECT id FROM users WHERE username=?", (username,)
    ).fetchone()
    today = date.today().isoformat()
    if user:
        user_id = user["id"]
    else:
        password = validate_password(data.get("password"))
        cur = db.execute(
            "INSERT INTO users(username,display_name,password_hash,managed_by,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?)",
            (
                username, display_name, generate_password_hash(password),
                g.user["id"], today, today,
            ),
        )
        user_id = cur.lastrowid
    try:
        db.execute(
            "INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) "
            "VALUES(?,?,?,?)", (workspace_id, user_id, role, today),
        )
    except sqlite3.IntegrityError:
        raise ApiError("该账号已在项目空间中", 409)
    db.commit()
    return jsonify({"user_id": user_id}), 201


@app.route(
    "/api/workspaces/<int:workspace_id>/members/<int:user_id>",
    methods=["PATCH", "DELETE"],
)
def workspace_member(workspace_id, user_id):
    require_workspace_admin(workspace_id)
    db = get_db()
    member = db.execute(
        "SELECT m.role,u.managed_by FROM workspace_members m "
        "JOIN users u ON u.id=m.user_id "
        "WHERE m.workspace_id=? AND m.user_id=?",
        (workspace_id, user_id),
    ).fetchone()
    if not member:
        raise ApiError("成员不存在", 404)
    if user_id == g.user["id"] and request.method == "DELETE":
        raise ApiError("不能将自己移出当前项目空间")

    def ensure_not_last_admin(new_role=None):
        if member["role"] != "admin" or new_role == "admin":
            return
        count = db.execute(
            "SELECT COUNT(*) AS count FROM workspace_members "
            "WHERE workspace_id=? AND role='admin'", (workspace_id,),
        ).fetchone()["count"]
        if count <= 1:
            raise ApiError("项目空间至少需要保留一名管理员")

    if request.method == "DELETE":
        ensure_not_last_admin()
        db.execute(
            "DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?",
            (workspace_id, user_id),
        )
        db.commit()
        return jsonify({"ok": True})

    data = json_object()
    if "role" in data:
        role = data["role"]
        if role not in {"admin", "member"}:
            raise ApiError("角色必须是 admin 或 member")
        ensure_not_last_admin(role)
        db.execute(
            "UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?",
            (role, workspace_id, user_id),
        )
    fields, values = [], []
    account_changes = "display_name" in data or data.get("password") not in (None, "")
    if account_changes and member["managed_by"] != g.user["id"]:
        raise ApiError("该账号由其他管理员维护，仅可调整其空间角色", 403)
    if "display_name" in data:
        display_name = text_field(data, "display_name", "姓名").strip()
        if not display_name:
            raise ApiError("姓名不能为空")
        fields.append("display_name=?")
        values.append(display_name)
    if data.get("password") not in (None, ""):
        fields.append("password_hash=?")
        values.append(generate_password_hash(validate_password(data["password"])))
    if fields:
        fields.append("updated_at=?")
        values.extend([date.today().isoformat(), user_id])
        db.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?", values)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/state")
def api_state():
    db = get_db()
    workspace_id = current_workspace_id()
    statuses = get_statuses(db)
    lines = [dict(r) for r in db.execute(
        "SELECT id,name,description,color,parent_id,fork_date,merge_date,updated_at "
        "FROM lines "
        "WHERE workspace_id=? AND deleted=0 ORDER BY id", (workspace_id,))]
    tasks = [dict(r) for r in db.execute(
        "SELECT t.id,t.line_id,t.name,t.content,t.goal,t.owner,t.priority,"
        "t.next_action,t.risk_reason,t.status,t.start_date,t.end_date,"
        "t.status_since,t.updated_at FROM tasks t "
        "JOIN lines l ON l.id=t.line_id "
        "WHERE t.workspace_id=? AND l.workspace_id=? "
        "AND t.deleted=0 AND l.deleted=0 ORDER BY t.start_date,t.id",
        (workspace_id, workspace_id))]
    return jsonify({
        "lines": lines,
        "tasks": tasks,
        "can_undo": get_meta(db, "undo_batch") is not None,
        "status_enum": statuses,
        "status_colors": get_status_colors(db, statuses),
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
    db = get_db()
    statuses = get_statuses(db)
    return jsonify({
        "statuses": statuses,
        "colors": get_status_colors(db, statuses),
    })


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
    colors = d.get("colors", {})
    if not isinstance(colors, dict) or \
            not all(isinstance(k, str) and isinstance(v, str)
                    for k, v in colors.items()):
        return jsonify({"error": "colors 必须是状态名到颜色的对象"}), 400
    unknown_colors = set(colors) - set(cleaned)
    if unknown_colors:
        return jsonify({"error": "颜色配置包含未知状态"}), 400
    normalized_colors = {}
    for status, color in colors.items():
        normalized = line_color(color)
        if normalized is None:
            return jsonify({"error": "状态颜色不能为空"}), 400
        normalized_colors[status] = normalized

    previous_colors = get_status_colors(db)
    set_meta(db, "statuses", json.dumps(cleaned, ensure_ascii=False))
    effective_statuses = get_statuses(db)
    effective_colors = {
        status: normalized_colors.get(
            status,
            previous_colors.get(
                status, DEFAULT_STATUS_COLORS.get(status, FALLBACK_STATUS_COLOR)
            ),
        )
        for status in effective_statuses
    }
    set_meta(db, "status_colors", json.dumps(effective_colors, ensure_ascii=False))
    db.commit()
    return jsonify({
        "ok": True,
        "statuses": effective_statuses,
        "colors": effective_colors,
    })


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
    workspace_id = current_workspace_id()
    if parent_id is not None:
        p = db.execute(
            "SELECT id,fork_date FROM lines WHERE id=? AND workspace_id=? "
            "AND deleted=0", (parent_id, workspace_id)
        ).fetchone()
        if not p:
            return jsonify({"error": "父线不存在"}), 404
        if fork_date < p["fork_date"]:
            return jsonify({"error": "支线起始日期不能早于父线起始日期"}), 400
    on_edit(db)
    cur = db.execute(
        "INSERT INTO lines(workspace_id,name,description,color,parent_id,fork_date,updated_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (
            workspace_id, name, description, color, parent_id, fork_date,
            date.today().isoformat(),
        ),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/lines/<int:lid>", methods=["PATCH"])
def update_line(lid):
    d = json_object()
    if d.get("merge_date") == "":
        d["merge_date"] = None
    db = get_db()
    workspace_id = current_workspace_id()
    row = db.execute(
        "SELECT * FROM lines WHERE id=? AND workspace_id=? AND deleted=0",
        (lid, workspace_id),
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
            "SELECT fork_date FROM lines WHERE id=? AND workspace_id=? AND deleted=0",
            (row["parent_id"], workspace_id),
        ).fetchone()
        if parent and new_fork < parent["fork_date"]:
            return jsonify({"error": "支线起始日期不能早于父线起始日期"}), 400
    child = db.execute(
        "SELECT MIN(fork_date) AS first_date FROM lines "
        "WHERE parent_id=? AND workspace_id=? AND deleted=0", (lid, workspace_id)
    ).fetchone()
    if child["first_date"] and child["first_date"] < new_fork:
        return jsonify({"error": "起始日期不能晚于子支线的起始日期"}), 400
    task = db.execute(
        "SELECT MIN(start_date) AS first_date FROM tasks "
        "WHERE line_id=? AND workspace_id=? AND deleted=0", (lid, workspace_id)
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
        vals.append(workspace_id)
        db.execute(
            f"UPDATE lines SET {','.join(fields)} WHERE id=? AND workspace_id=?", vals
        )
        db.commit()
    return jsonify({"ok": True})


def collect_descendants(db, lid, workspace_id):
    ids = [lid]
    i = 0
    while i < len(ids):
        rows = db.execute(
            "SELECT id FROM lines WHERE parent_id=? AND workspace_id=? AND deleted=0",
            (ids[i], workspace_id),
        ).fetchall()
        ids.extend(r["id"] for r in rows)
        i += 1
    return ids


@app.route("/api/lines/<int:lid>", methods=["DELETE"])
def delete_line(lid):
    db = get_db()
    workspace_id = current_workspace_id()
    row = db.execute(
        "SELECT id FROM lines WHERE id=? AND workspace_id=? AND deleted=0",
        (lid, workspace_id),
    ).fetchone()
    if not row:
        return jsonify({"error": "线不存在"}), 404
    batch = new_batch(db)
    ids = collect_descendants(db, lid, workspace_id)
    marks = ",".join("?" * len(ids))
    today = date.today().isoformat()
    db.execute(
        f"UPDATE lines SET deleted=1, del_batch=?, deleted_at=? "
        f"WHERE workspace_id=? AND id IN ({marks})",
        [batch, today, workspace_id] + ids,
    )
    db.execute(
        f"UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? WHERE deleted=0 "
        f"AND workspace_id=? AND line_id IN ({marks})",
        [batch, today, workspace_id] + ids,
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
    workspace_id = current_workspace_id()
    line_id = required_id(d.get("line_id"), "line_id")
    line = db.execute(
        "SELECT id,fork_date FROM lines WHERE id=? AND workspace_id=? AND deleted=0",
        (line_id, workspace_id),
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
        "INSERT INTO tasks(workspace_id,line_id,name,content,goal,owner,priority,next_action,"
        "risk_reason,status,start_date,end_date,status_since,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            workspace_id, line_id, name, content, goal, owner, priority,
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
    workspace_id = current_workspace_id()
    row = db.execute(
        "SELECT * FROM tasks WHERE id=? AND workspace_id=? AND deleted=0",
        (tid, workspace_id),
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
        "SELECT fork_date FROM lines WHERE id=? AND workspace_id=? AND deleted=0",
        (new_line_id, workspace_id),
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
        vals.append(workspace_id)
        db.execute(
            f"UPDATE tasks SET {','.join(fields)} WHERE id=? AND workspace_id=?", vals
        )
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:tid>", methods=["DELETE"])
def delete_task(tid):
    db = get_db()
    workspace_id = current_workspace_id()
    row = db.execute(
        "SELECT id FROM tasks WHERE id=? AND workspace_id=? AND deleted=0",
        (tid, workspace_id),
    ).fetchone()
    if not row:
        return jsonify({"error": "事务不存在"}), 404
    batch = new_batch(db)
    db.execute(
        "UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? "
        "WHERE id=? AND workspace_id=?",
        (batch, date.today().isoformat(), tid, workspace_id),
    )
    db.commit()
    return jsonify({"ok": True, "can_undo": True})


@app.route("/api/tasks/export", methods=["POST"])
def export_tasks():
    d = json_object()
    scope = d.get("scope")
    workspace_id = current_workspace_id()
    params = [workspace_id, workspace_id]
    selected_count = None
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
        params.extend(ids)
        selected_count = len(ids)
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
        "WHERE t.workspace_id=? AND l.workspace_id=? "
        "AND t.deleted=0 AND l.deleted=0" + id_clause +
        " ORDER BY t.start_date,t.id",
        params,
    ).fetchall()]
    if scope == "selected" and len(rows) != selected_count:
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
    workspace_id = current_workspace_id()
    marks = ",".join("?" * len(ids))
    existing = db.execute(
        f"SELECT id FROM tasks WHERE workspace_id=? AND deleted=0 "
        f"AND id IN ({marks})", [workspace_id] + ids
    ).fetchall()
    if len(existing) != len(set(ids)):
        return jsonify({"error": "部分事务不存在或已删除"}), 404

    if request.method == "DELETE":
        batch = new_batch(db)
        db.execute(
            f"UPDATE tasks SET deleted=1, del_batch=?, deleted_at=? "
            f"WHERE workspace_id=? AND id IN ({marks})",
            [batch, date.today().isoformat(), workspace_id] + ids,
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
            "SELECT id,fork_date FROM lines WHERE id=? AND workspace_id=? "
            "AND deleted=0", (patch["line_id"], workspace_id)
        ).fetchone()
        if not ln:
            return jsonify({"error": "所属线不存在"}), 404
        first_task = db.execute(
            f"SELECT MIN(start_date) AS first_date FROM tasks "
            f"WHERE workspace_id=? AND deleted=0 AND id IN ({marks})",
            [workspace_id] + ids,
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
        f"UPDATE tasks SET {','.join(fields)} WHERE workspace_id=? "
        f"AND id IN ({marks})",
        vals + [workspace_id] + ids,
    )
    db.commit()
    return jsonify({"ok": True, "count": len(ids)})


# ----- undo
@app.route("/api/undo", methods=["POST"])
def undo():
    db = get_db()
    workspace_id = current_workspace_id()
    batch = get_meta(db, "undo_batch")
    if batch is None:
        return jsonify({"error": "没有可撤销的删除"}), 400
    db.execute(
        "UPDATE lines SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE workspace_id=? AND del_batch=?", (workspace_id, batch)
    )
    db.execute(
        "UPDATE tasks SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE workspace_id=? AND del_batch=?", (workspace_id, batch)
    )
    set_meta(db, "undo_batch", None)
    db.commit()
    return jsonify({"ok": True})


# ----- trash
@app.route("/api/trash", methods=["GET"])
def trash():
    db = get_db()
    workspace_id = current_workspace_id()
    line_rows = [dict(r) for r in db.execute(
        "SELECT id,name,parent_id,fork_date,merge_date,del_batch,deleted_at "
        "FROM lines WHERE workspace_id=? AND deleted=1 "
        "ORDER BY deleted_at DESC,id DESC", (workspace_id,)
    )]
    task_rows = [dict(r) for r in db.execute(
        "SELECT id,line_id,name,status,owner,priority,start_date,end_date,"
        "del_batch,deleted_at FROM tasks WHERE workspace_id=? AND deleted=1 "
        "ORDER BY deleted_at DESC,id DESC", (workspace_id,)
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
    workspace_id = current_workspace_id()
    found = db.execute(
        "SELECT 1 FROM lines WHERE workspace_id=? AND del_batch=? AND deleted=1 "
        "UNION SELECT 1 FROM tasks WHERE workspace_id=? AND del_batch=? AND deleted=1",
        (workspace_id, batch, workspace_id, batch),
    ).fetchone()
    if not found:
        return jsonify({"error": "未找到该删除批次"}), 404
    blocked_line = db.execute(
        "SELECT child.id FROM lines child JOIN lines parent "
        "ON parent.id=child.parent_id WHERE child.del_batch=? AND child.deleted=1 "
        "AND child.workspace_id=? AND parent.workspace_id=? "
        "AND parent.deleted=1 AND parent.del_batch<>? LIMIT 1",
        (batch, workspace_id, workspace_id, batch)
    ).fetchone()
    blocked_task = db.execute(
        "SELECT task.id FROM tasks task JOIN lines line ON line.id=task.line_id "
        "WHERE task.del_batch=? AND task.deleted=1 AND line.deleted=1 "
        "AND task.workspace_id=? AND line.workspace_id=? "
        "AND line.del_batch<>? LIMIT 1",
        (batch, workspace_id, workspace_id, batch)
    ).fetchone()
    if blocked_line or blocked_task:
        return jsonify({"error": "请先恢复该批次所依赖的所属线"}), 409
    db.execute(
        "UPDATE lines SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE workspace_id=? AND del_batch=?", (workspace_id, batch)
    )
    db.execute(
        "UPDATE tasks SET deleted=0, del_batch=NULL, deleted_at=NULL "
        "WHERE workspace_id=? AND del_batch=?", (workspace_id, batch)
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
