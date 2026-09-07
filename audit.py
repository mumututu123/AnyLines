"""Transactional, append-only audit history for workspace edits."""
import hashlib
import json
import sqlite3
from datetime import datetime, timezone


OPERATIONS = {
    "create": "新增", "update": "修改", "delete": "删除",
    "import": "导入", "bulk_update": "批量修改", "bulk_delete": "批量删除",
    "undo": "撤销", "redo": "重做", "restore": "恢复", "purge": "永久删除",
    "archive": "归档", "comment": "发表评论", "follow": "关注",
    "unfollow": "取消关注", "password": "修改密码", "avatar": "修改头像",
}
OBJECT_TYPES = {
    "workspace": "项目空间", "line": "线", "task": "事务",
    "milestone": "里程碑", "member": "空间成员", "settings": "状态设置",
    "comment": "评论", "follow": "事务关注", "account": "账号",
}
ENDPOINTS = {
    "create_workspace", "update_workspace", "archive_workspace", "restore_workspace",
    "delete_workspace", "workspace_members", "workspace_member",
    "auth_change_password", "auth_avatar_update",
}


class Connection(sqlite3.Connection):
    # Existing handlers may call commit; an audited request commits only after
    # its snapshots have been persisted, so audit failure rolls back the edit.
    audit_context = None

    def commit(self):
        if self.audit_context is None:
            super().commit()


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            operation TEXT NOT NULL,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_name TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            created_at TEXT NOT NULL,
            request_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_workspace_time
            ON audit_logs(workspace_id,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_workspace_user
            ON audit_logs(workspace_id,username,id DESC);
        CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
            BEFORE UPDATE ON audit_logs BEGIN
                SELECT RAISE(ABORT, 'Audit records are append-only');
            END;
        CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
            BEFORE DELETE ON audit_logs BEGIN
                SELECT RAISE(ABORT, 'Audit records are append-only');
            END;
    """)


def account_snapshot(row):
    item = dict(row)
    data = item.pop("avatar_data", None)
    item["avatar"] = ({"mime_type": item.pop("avatar_mime", None),
                       "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                      if data else None)
    item.pop("avatar_mime", None)
    # Compared in memory only; removed before audit serialization.
    item["_password_hash"] = item.pop("password_hash", None)
    return item


def capture(db, workspace_id, account_id=None):
    objects = {}
    if account_id is not None:
        row = db.execute("SELECT * FROM users WHERE id=?", (account_id,)).fetchone()
        if row:
            objects[("account", str(account_id))] = account_snapshot(row)
        return objects
    row = db.execute("SELECT * FROM workspaces WHERE id=?", (workspace_id,)).fetchone()
    if not row:
        return objects
    objects[("workspace", str(workspace_id))] = dict(row)
    for table, kind in (("lines", "line"), ("tasks", "task"),
                        ("milestones", "milestone"), ("task_comments", "comment")):
        for row in db.execute(f"SELECT * FROM {table} WHERE workspace_id=? ORDER BY id",
                              (workspace_id,)):
            item = dict(row)
            if kind == "task":
                item.update(dependencies=[], images=[], attachments=[])
            elif kind == "milestone":
                item["acceptance_task_ids"] = []
            objects[(kind, str(row["id"]))] = item
    for row in db.execute("SELECT * FROM task_dependencies WHERE workspace_id=? "
                          "ORDER BY dependent_task_id,prerequisite_task_id", (workspace_id,)):
        task = objects.get(("task", str(row["dependent_task_id"])))
        if task is not None:
            task["dependencies"].append(row["prerequisite_task_id"])
    for row in db.execute("SELECT * FROM milestone_tasks WHERE workspace_id=? "
                          "ORDER BY milestone_id,task_id", (workspace_id,)):
        milestone = objects.get(("milestone", str(row["milestone_id"])))
        if milestone is not None:
            milestone["acceptance_task_ids"].append(row["task_id"])
    for table, field in (("task_images", "images"), ("task_attachments", "attachments")):
        for row in db.execute(f"SELECT * FROM {table} WHERE workspace_id=? ORDER BY id",
                              (workspace_id,)):
            task = objects.get(("task", str(row["task_id"])))
            if task is not None:
                item = dict(row)
                data = item.pop("data")
                item.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                task[field].append(item)
    for row in db.execute("SELECT u.*,m.workspace_id,m.role,m.joined_at FROM workspace_members m "
                          "JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.id",
                          (workspace_id,)):
        objects[("member", str(row["id"]))] = account_snapshot(row)
    for row in db.execute("SELECT * FROM task_followers WHERE workspace_id=? "
                          "ORDER BY task_id,user_id", (workspace_id,)):
        objects[("follow", f"{row['task_id']}:{row['user_id']}")] = dict(row)
    settings = {row["key"]: json.loads(row["value"]) for row in db.execute(
        "SELECT key,value FROM workspace_meta WHERE workspace_id=? "
        "AND key IN ('statuses','status_colors') ORDER BY key", (workspace_id,))}
    objects[("settings", "statuses")] = settings
    return objects


def begin(db, workspace_id, user, endpoint):
    import uuid
    db.execute("BEGIN IMMEDIATE")
    account_id = user["id"] if endpoint in {"auth_change_password", "auth_avatar_update"} else None
    db.audit_context = {
        "workspace_id": workspace_id, "user_id": user["id"], "username": user["username"],
        "endpoint": endpoint, "account_id": account_id, "request_id": uuid.uuid4().hex,
        "before": capture(db, workspace_id, account_id),
    }


def operation(endpoint, method, before, after):
    special = {
        "import_data": "import", "import_lines": "import", "import_tasks": "import",
        "undo": "undo", "redo": "redo", "restore_trash": "restore",
        "restore_workspace": "restore", "purge_trash": "purge",
        "delete_workspace": "purge", "archive_workspace": "archive",
        "add_task_comment": "comment", "follow_task": "follow", "unfollow_task": "unfollow",
        "auth_change_password": "password", "auth_avatar_update": "avatar",
    }
    if endpoint == "bulk_tasks":
        return "bulk_delete" if method == "DELETE" else "bulk_update"
    if endpoint in special:
        return special[endpoint]
    if after is None or (before and not before.get("deleted") and after.get("deleted")):
        return "delete"
    return "create" if before is None else "update"


def finish(db, method, success, created_workspace_id=None):
    context = db.audit_context
    if context is None:
        return
    try:
        if not success:
            db.rollback()
            return
        workspace_id = created_workspace_id or context["workspace_id"]
        after = capture(db, workspace_id, context["account_id"])
        before = context["before"]
        created_at = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        for key in sorted(before.keys() | after.keys()):
            old, new = before.get(key), after.get(key)
            if old == new:
                continue
            kind, object_id = key
            item = new if new is not None else old
            name = item.get("name") or item.get("username") or OBJECT_TYPES[kind]
            if kind in {"comment", "follow"}:
                task = after.get(("task", str(item["task_id"]))) or before.get(("task", str(item["task_id"])))
                name = f"{OBJECT_TYPES[kind]} · {(task or {}).get('name', item['task_id'])}"
            snapshot = {
                "before": {k: v for k, v in old.items() if not k.startswith("_")} if old is not None else None,
                "after": {k: v for k, v in new.items() if not k.startswith("_")} if new is not None else None,
            }
            if old and new and old.get("_password_hash") != new.get("_password_hash"):
                snapshot["password_changed"] = True
            db.execute(
                "INSERT INTO audit_logs(workspace_id,user_id,username,operation,object_type,"
                "object_id,object_name,snapshot,created_at,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, context["user_id"], context["username"],
                 operation(context["endpoint"], method, old, new), kind, object_id, name,
                 json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
                 created_at, context["request_id"]),
            )
        sqlite3.Connection.commit(db)
    except Exception:
        db.rollback()
        raise
    finally:
        db.audit_context = None
