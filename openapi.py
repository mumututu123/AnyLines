# -*- coding: utf-8 -*-
"""AnyLine OpenAPI 3 document used by the bundled Swagger UI."""

from copy import deepcopy


def _ref(name):
    return {"$ref": f"#/components/schemas/{name}"}


def _array(items):
    return {"type": "array", "items": items}


def _object(properties=None, required=None, **extra):
    schema = {"type": "object", "properties": properties or {}}
    if required:
        schema["required"] = required
    schema.update(extra)
    return schema


def _json_body(schema, example=None, required=True):
    media = {"schema": schema}
    if example is not None:
        media["example"] = example
    return {
        "required": required,
        "content": {"application/json": media},
    }


def _file_body():
    return {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": _object(
                    {"file": {"type": "string", "format": "binary"}},
                    ["file"],
                )
            }
        },
    }


def _json_response(description, schema=None, example=None):
    media = {"schema": schema or {"type": "object"}}
    if example is not None:
        media["example"] = example
    return {"description": description, "content": {"application/json": media}}


def _binary_response(description, media_type="application/octet-stream"):
    return {
        "description": description,
        "content": {media_type: {"schema": {"type": "string", "format": "binary"}}},
    }


def _operation(tag, summary, success=None, body=None, parameters=None,
               description=None, public=False, success_code="200"):
    operation = {
        "tags": [tag],
        "summary": summary,
        "responses": {
            success_code: success or _json_response("操作成功", _ref("OkResponse"), {"ok": True}),
            "400": {"$ref": "#/components/responses/BadRequest"},
            "401": {"$ref": "#/components/responses/Unauthorized"},
            "403": {"$ref": "#/components/responses/Forbidden"},
            "404": {"$ref": "#/components/responses/NotFound"},
            "409": {"$ref": "#/components/responses/Conflict"},
            "500": {"$ref": "#/components/responses/ServerError"},
        },
    }
    if body:
        operation["requestBody"] = body
    if parameters:
        operation["parameters"] = parameters
    if description:
        operation["description"] = description
    if public:
        operation["security"] = []
    return operation


def _created(schema=None, example=None, description="创建成功"):
    return _json_response(description, schema or _ref("IdResponse"), example or {"id": 123})


def _path_parameter(name):
    if name == "snapshot_date":
        schema = {"type": "string", "format": "date", "example": "2026-09-09"}
    else:
        schema = {"type": "integer", "minimum": 1, "example": 123}
    return {"name": name, "in": "path", "required": True, "schema": schema}


def _query_parameter(name, schema=None, description=None):
    parameter = {
        "name": name,
        "in": "query",
        "required": False,
        "schema": schema or {"type": "string"},
    }
    if description:
        parameter["description"] = description
    return parameter


DATE = {"type": "string", "format": "date", "example": "2026-09-09"}
NULLABLE_DATE = {**DATE, "nullable": True}
ID = {"type": "integer", "minimum": 1, "example": 123}

SCHEMAS = {
    "Error": _object(
        {"error": {"type": "string", "example": "请求参数无效"}}, ["error"]
    ),
    "OkResponse": _object(
        {"ok": {"type": "boolean", "example": True}}, ["ok"]
    ),
    "IdResponse": _object({"id": ID}, ["id"]),
    "User": _object({
        "id": ID,
        "username": {"type": "string", "example": "admin"},
        "display_name": {"type": "string", "example": "项目管理员"},
        "avatar_url": {"type": "string", "nullable": True, "example": None},
    }, ["id", "username", "display_name", "avatar_url"]),
    "Workspace": _object({
        "id": ID,
        "name": {"type": "string", "example": "示例项目"},
        "description": {"type": "string", "example": "接口联调空间"},
        "archived_at": NULLABLE_DATE,
        "role": {"type": "string", "enum": ["admin", "member"], "example": "admin"},
    }, ["id", "name", "description", "archived_at", "role"]),
    "Session": _object({
        "authenticated": {"type": "boolean", "example": True},
        "user": _ref("User"),
        "workspaces": _array(_ref("Workspace")),
        "current_workspace": _ref("Workspace"),
    }, ["authenticated", "user", "workspaces", "current_workspace"]),
    "Line": _object({
        "id": ID,
        "name": {"type": "string", "example": "产品发布"},
        "description": {"type": "string", "example": "从开发到正式上线"},
        "color": {"type": "string", "nullable": True, "example": "#0969da"},
        "parent_id": {"type": "integer", "nullable": True, "example": None},
        "fork_date": DATE,
        "merge_date": NULLABLE_DATE,
    }, ["id", "name", "fork_date"]),
    "Task": _object({
        "id": ID,
        "line_id": ID,
        "name": {"type": "string", "example": "完成接口联调"},
        "content": {"type": "string", "example": "核对请求和响应并记录异常"},
        "goal": {"type": "string", "example": "全部约定场景验证通过"},
        "next_action": {"type": "string", "example": "准备联调数据"},
        "risk_reason": {"type": "string", "example": ""},
        "priority": {"type": "string", "enum": ["低", "中", "高", "紧急"], "example": "高"},
        "owner": {"type": "string", "example": "项目管理员"},
        "owners": _array({"type": "string", "example": "项目管理员"}),
        "status": {"type": "string", "example": "进行中"},
        "start_date": DATE,
        "end_date": DATE,
        "status_since": DATE,
    }, ["id", "line_id", "name", "content", "owners", "status", "start_date", "end_date"]),
    "Milestone": _object({
        "id": ID,
        "line_id": ID,
        "name": {"type": "string", "example": "正式发布"},
        "target_description": {"type": "string", "example": "核心功能上线并完成验收"},
        "milestone_date": DATE,
        "acceptance_task_ids": _array(ID),
    }, ["id", "line_id", "name", "target_description", "milestone_date"]),
    "LineWrite": _object({
        "name": {"type": "string", "example": "产品发布"},
        "description": {"type": "string", "example": "从开发到正式上线"},
        "color": {"type": "string", "nullable": True, "pattern": "^#[0-9a-fA-F]{6}$", "example": "#0969da"},
        "parent_id": {"type": "integer", "nullable": True, "example": None},
        "fork_date": DATE,
        "merge_date": NULLABLE_DATE,
    }, ["name"]),
    "TaskWrite": _object({
        "line_id": ID,
        "name": {"type": "string", "example": "完成接口联调"},
        "content": {"type": "string", "example": "核对请求和响应并记录异常"},
        "goal": {"type": "string", "example": "全部场景验证通过"},
        "next_action": {"type": "string", "example": "准备测试数据"},
        "risk_reason": {"type": "string", "example": ""},
        "priority": {"type": "string", "enum": ["低", "中", "高", "紧急"], "example": "高"},
        "owners": _array({"type": "string", "example": "项目管理员"}),
        "status": {"type": "string", "example": "进行中"},
        "start_date": DATE,
        "end_date": DATE,
        "prerequisite_ids": _array(ID),
        "images": _array({
            "oneOf": [
                _object({"id": ID}, ["id"]),
                _object({"data_url": {"type": "string", "example": "data:image/png;base64,iVBORw0KGgo..."}}, ["data_url"]),
            ]
        }),
        "attachments": _array({
            "oneOf": [
                _object({"id": ID}, ["id"]),
                _object({
                    "name": {"type": "string", "example": "联调说明.txt"},
                    "data_url": {"type": "string", "example": "data:text/plain;base64,SGVsbG8="},
                }, ["name", "data_url"]),
            ]
        }),
        "initial_comment": {"type": "string", "example": "请相关成员准备联调环境"},
    }, ["line_id", "name", "content", "owners", "status", "start_date", "end_date"]),
    "MilestoneWrite": _object({
        "line_id": ID,
        "name": {"type": "string", "example": "正式发布"},
        "target_description": {"type": "string", "example": "核心功能上线并完成验收"},
        "milestone_date": DATE,
        "acceptance_task_ids": _array(ID),
    }, ["line_id", "name", "target_description", "milestone_date"]),
    "Notification": _object({
        "id": ID,
        "kind": {"type": "string", "example": "assigned"},
        "task_id": ID,
        "task_name": {"type": "string", "example": "完成接口联调"},
        "message": {"type": "string", "example": "你被指派为事务责任人"},
        "read_at": {"type": "string", "format": "date-time", "nullable": True},
    }, ["id", "kind", "task_id", "message"]),
    "AuditRecord": _object({
        "id": ID,
        "username": {"type": "string", "example": "admin"},
        "operation": {"type": "string", "example": "update"},
        "object_type": {"type": "string", "example": "task"},
        "object_id": {"type": "string", "example": "123"},
        "object_name": {"type": "string", "example": "完成接口联调"},
        "created_at": {"type": "string", "format": "date-time", "example": "2026-09-09T08:30:00Z"},
        "request_id": {"type": "string", "example": "example-request-id"},
    }, ["id", "username", "operation", "object_type", "created_at"]),
}

SCHEMAS["LinePatch"] = deepcopy(SCHEMAS["LineWrite"])
SCHEMAS["LinePatch"].pop("required", None)
SCHEMAS["LinePatch"]["properties"].pop("parent_id", None)
SCHEMAS["TaskPatch"] = deepcopy(SCHEMAS["TaskWrite"])
SCHEMAS["TaskPatch"].pop("required", None)
SCHEMAS["TaskPatch"]["properties"].pop("initial_comment", None)
SCHEMAS["MilestonePatch"] = deepcopy(SCHEMAS["MilestoneWrite"])
SCHEMAS["MilestonePatch"].pop("required", None)
SCHEMAS["MilestonePatch"]["properties"].pop("line_id", None)

ERROR_RESPONSES = {
    "BadRequest": _json_response("请求参数、格式或业务校验无效", _ref("Error"), {"error": "请求参数无效"}),
    "Unauthorized": _json_response("未登录或会话已失效", _ref("Error"), {"error": "请先登录"}),
    "Forbidden": _json_response("当前账号或角色无权操作", _ref("Error"), {"error": "仅项目管理员可执行此操作"}),
    "NotFound": _json_response("对象不存在或不属于当前空间", _ref("Error"), {"error": "对象不存在"}),
    "Conflict": _json_response("归档、依赖或引用关系造成业务冲突", _ref("Error"), {"error": "当前状态不允许此操作"}),
    "ServerError": _json_response("服务器处理请求失败", _ref("Error"), {"error": "服务器处理请求失败"}),
}

TAGS = [
    {"name": "接口文档", "description": "OpenAPI 文档本身。"},
    {"name": "身份与账号", "description": "Cookie 会话、密码和头像。"},
    {"name": "项目空间", "description": "空间、成员及归档生命周期。"},
    {"name": "项目状态", "description": "当前空间聚合状态和历史场景。"},
    {"name": "线路", "description": "主线、支线及兼容导入导出。"},
    {"name": "事务", "description": "事务、依赖和批量处理。"},
    {"name": "里程碑", "description": "里程碑及验收事务。"},
    {"name": "协作通知", "description": "关注、评论、动态和个人通知。"},
    {"name": "配置", "description": "当前空间状态枚举。"},
    {"name": "导入导出", "description": "统一 Excel 导入导出。"},
    {"name": "恢复", "description": "撤销、重做和回收站。"},
    {"name": "操作审计", "description": "仅当前空间管理员可查询。"},
]

PATHS = {}


def _add(path, method, operation):
    names = [part[1:-1] for part in path.split("/") if part.startswith("{")]
    path_parameters = [_path_parameter(name) for name in names]
    if path_parameters:
        operation["parameters"] = path_parameters + operation.get("parameters", [])
    PATHS.setdefault(path, {})[method.lower()] = operation


def _ok(example=None, schema=None, description="操作成功"):
    return _json_response(description, schema or _ref("OkResponse"), example or {"ok": True})


# Documentation and session
_add("/api/openapi.json", "get", _operation(
    "接口文档", "获取 OpenAPI 3.0 定义",
    _json_response("完整 OpenAPI 文档", {"type": "object"}), public=True,
))
_add("/api/auth/session", "get", _operation(
    "身份与账号", "读取当前登录会话",
    _json_response("已登录时返回用户和空间；未登录返回 authenticated=false", _ref("Session"), {
        "authenticated": True,
        "user": {"id": 1, "username": "admin", "display_name": "项目管理员", "avatar_url": None},
        "workspaces": [{"id": 1, "name": "示例项目", "description": "", "archived_at": None, "role": "admin"}],
        "current_workspace": {"id": 1, "name": "示例项目", "description": "", "archived_at": None, "role": "admin"},
    }), public=True,
))
_add("/api/auth/login", "post", _operation(
    "身份与账号", "登录并建立 Cookie 会话",
    _json_response("登录成功", _ref("Session")),
    _json_body(_object({
        "username": {"type": "string", "example": "admin"},
        "password": {"type": "string", "format": "password", "example": "admin123"},
    }, ["username", "password"]), {"username": "admin", "password": "admin123"}),
    public=True,
))
_add("/api/auth/logout", "post", _operation("身份与账号", "退出并清除当前会话"))
_add("/api/auth/password", "put", _operation(
    "身份与账号", "修改本人密码", body=_json_body(_object({
        "current_password": {"type": "string", "format": "password", "example": "admin123"},
        "new_password": {"type": "string", "format": "password", "minLength": 6, "example": "new-password"},
    }, ["current_password", "new_password"])),
))
_add("/api/auth/avatar", "get", _operation(
    "身份与账号", "下载本人头像",
    _binary_response("头像图片", "image/png"),
))
_add("/api/auth/avatar", "put", _operation(
    "身份与账号", "更新本人头像",
    _ok({"avatar_url": "/api/auth/avatar?v=2026-09-09"}),
    _json_body(_object({
        "data_url": {"type": "string", "format": "byte", "example": "data:image/png;base64,iVBORw0KGgo..."},
    }, ["data_url"])),
))

# Workspaces and members
_add("/api/workspaces", "post", _operation(
    "项目空间", "创建并切换到新项目空间", _created(),
    _json_body(_object({
        "name": {"type": "string", "example": "接口联调项目"},
        "description": {"type": "string", "example": "供 API 调试使用"},
    }, ["name"])),
))
_add("/api/workspaces/{workspace_id}", "patch", _operation(
    "项目空间", "修改项目空间", body=_json_body(_object({
        "name": {"type": "string", "example": "新项目名称"},
        "description": {"type": "string", "example": "更新后的说明"},
    })), success_code="201",
))
_add("/api/workspaces/{workspace_id}/archive", "post", _operation(
    "项目空间", "归档项目空间",
    _ok({"ok": True, "archived_at": "2026-09-09"}),
))
_add("/api/workspaces/{workspace_id}/restore", "post", _operation("项目空间", "恢复已归档项目空间"))
_add("/api/workspaces/{workspace_id}", "delete", _operation(
    "项目空间", "永久删除已归档项目空间",
    _ok({"ok": True, "current_workspace_id": 2}),
    _json_body(_object({
        "confirmation": {"type": "string", "example": "接口联调项目"},
    }, ["confirmation"])),
    description="confirmation 必须与空间名称完全一致；至少保留一个可访问空间。",
))
_add("/api/workspaces/{workspace_id}/select", "post", _operation("项目空间", "切换当前会话的项目空间"))
_add("/api/workspaces/{workspace_id}/members", "get", _operation(
    "项目空间", "查询空间成员",
    _json_response("成员列表", _object({"members": _array(_object({
        "id": ID,
        "username": {"type": "string", "example": "developer"},
        "display_name": {"type": "string", "example": "开发成员"},
        "role": {"type": "string", "enum": ["admin", "member"]},
        "can_manage_account": {"type": "boolean", "example": True},
    }))}), {"members": [{"id": 2, "username": "developer", "display_name": "开发成员", "role": "member", "can_manage_account": True}]}),
))
_add("/api/workspaces/{workspace_id}/members", "post", _operation(
    "项目空间", "添加已有账号或创建新成员",
    _created(_object({"user_id": ID}), {"user_id": 2}),
    _json_body(_object({
        "username": {"type": "string", "example": "developer"},
        "display_name": {"type": "string", "example": "开发成员"},
        "password": {"type": "string", "format": "password", "example": "member123"},
        "role": {"type": "string", "enum": ["admin", "member"], "example": "member"},
    }, ["username"])), success_code="201",
))
_add("/api/workspaces/{workspace_id}/members/{user_id}", "patch", _operation(
    "项目空间", "修改成员角色或账号资料", body=_json_body(_object({
        "role": {"type": "string", "enum": ["admin", "member"], "example": "admin"},
        "display_name": {"type": "string", "example": "研发负责人"},
        "password": {"type": "string", "format": "password", "example": "reset-password"},
    })),
))
_add("/api/workspaces/{workspace_id}/members/{user_id}", "delete", _operation("项目空间", "移除空间成员"))

# Aggregate state, snapshots and settings
_add("/api/state", "get", _operation(
    "项目状态", "读取当前空间完整业务状态",
    _json_response("供单页前端渲染的聚合状态", _object({
        "lines": _array(_ref("Line")),
        "tasks": _array(_ref("Task")),
        "milestones": _array(_ref("Milestone")),
        "dependencies": _array(_object({"task_id": ID, "prerequisite_task_id": ID})),
        "status_enum": _array({"type": "string"}),
        "priority_enum": _array({"type": "string"}),
        "can_undo": {"type": "boolean"},
        "can_redo": {"type": "boolean"},
        "today": DATE,
    }), {"lines": [], "tasks": [], "milestones": [], "dependencies": [], "status_enum": ["未启动", "进行中", "已闭环"], "priority_enum": ["低", "中", "高", "紧急"], "can_undo": False, "can_redo": False, "today": "2026-09-09"}),
))
_add("/api/dashboard/history", "get", _operation(
    "项目状态", "查询最近 90 个项目场景记录日",
    _json_response("历史场景目录", _object({
        "workspace_id": ID,
        "snapshots": _array(_object({
            "snapshot_date": DATE,
            "captured_at": {"type": "string", "format": "date-time"},
            "total": {"type": "integer"},
            "done": {"type": "integer"},
        })),
    }), {"workspace_id": 1, "snapshots": [{"snapshot_date": "2026-09-09", "captured_at": "2026-09-09T08:00:00Z", "total": 12, "done": 7}]}),
))
_add("/api/dashboard/history/{snapshot_date}", "get", _operation(
    "项目状态", "读取指定日期的项目场景",
    _json_response("场景快照", _object({
        "workspace_id": ID,
        "snapshot_date": DATE,
        "captured_at": {"type": "string", "format": "date-time"},
        "scene": _object({
            "lines": _array(_ref("Line")),
            "tasks": _array(_ref("Task")),
            "dependencies": _array({"type": "object"}),
            "milestones": _array(_ref("Milestone")),
        }),
    })),
))
_add("/api/statuses", "get", _operation(
    "配置", "查询状态枚举与颜色",
    _json_response("状态配置", _object({
        "statuses": _array({"type": "string"}),
        "colors": {"type": "object", "additionalProperties": {"type": "string"}},
    }), {"statuses": ["未启动", "进行中", "已闭环"], "colors": {"未启动": "#8c959f", "进行中": "#0969da", "已闭环": "#1a7f37"}}),
))
_add("/api/statuses", "put", _operation(
    "配置", "替换状态枚举与颜色",
    _ok({"ok": True, "statuses": ["未启动", "进行中", "已闭环"], "colors": {"未启动": "#8c959f", "进行中": "#0969da", "已闭环": "#1a7f37"}}),
    _json_body(_object({
        "statuses": _array({"type": "string"}),
        "colors": {"type": "object", "additionalProperties": {"type": "string"}},
    }, ["statuses"]), {"statuses": ["未启动", "进行中", "已闭环"], "colors": {"未启动": "#8c959f", "进行中": "#0969da", "已闭环": "#1a7f37"}}),
))

# Lines
_add("/api/lines", "post", _operation("线路", "创建主线或支线", _created(), _json_body(_ref("LineWrite")), success_code="201"))
_add("/api/lines/{lid}", "patch", _operation("线路", "修改线路", body=_json_body(_ref("LinePatch"))))
_add("/api/lines/{lid}", "delete", _operation("线路", "递归软删除线路及其业务对象", _ok({"ok": True, "can_undo": True})))
_add("/api/lines/import-template", "get", _operation("线路", "下载线路 Excel 模板", _binary_response("Excel 模板", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))
_add("/api/lines/import", "post", _operation("线路", "从 Excel 导入线路", _json_response("导入成功", _object({"ok": {"type": "boolean"}, "count": {"type": "integer"}, "ids": _array(ID), "can_undo": {"type": "boolean"}}), {"ok": True, "count": 2, "ids": [12, 13], "can_undo": True}), _file_body(), success_code="201"))
_add("/api/lines/export", "get", _operation("线路", "导出当前空间全部线路", _binary_response("线路 Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))

# Milestones
_add("/api/milestones", "post", _operation("里程碑", "创建里程碑", _created(), _json_body(_ref("MilestoneWrite")), success_code="201"))
_add("/api/milestones/{milestone_id}", "patch", _operation("里程碑", "修改里程碑", body=_json_body(_ref("MilestonePatch"))))
_add("/api/milestones/{milestone_id}", "delete", _operation("里程碑", "软删除里程碑", _ok({"ok": True, "can_undo": True})))

# Tasks and dependencies
_add("/api/tasks", "post", _operation("事务", "创建事务", _created(), _json_body(_ref("TaskWrite")), success_code="201"))
_add("/api/tasks/{tid}", "patch", _operation("事务", "修改事务", body=_json_body(_ref("TaskPatch"))))
_add("/api/tasks/{tid}", "delete", _operation("事务", "软删除事务", _ok({"ok": True, "can_undo": True})))
dependency_body = _json_body(_object({"prerequisite_task_id": ID}, ["prerequisite_task_id"]), {"prerequisite_task_id": 45})
_add("/api/tasks/{tid}/dependencies", "post", _operation("事务", "添加事务前置依赖", _created(_object({"ok": {"type": "boolean"}, "created": {"type": "boolean"}}), {"ok": True, "created": True}, "依赖已创建"), dependency_body, success_code="201"))
PATHS["/api/tasks/{tid}/dependencies"]["post"]["responses"]["200"] = _ok(
    {"ok": True, "created": False}, description="依赖已存在"
)
_add("/api/tasks/{tid}/dependencies", "delete", _operation("事务", "删除事务前置依赖", body=dependency_body))
_add("/api/tasks/bulk", "patch", _operation(
    "事务", "批量修改事务",
    _ok({"ok": True, "count": 2}),
    _json_body(_object({
        "ids": _array(ID),
        "patch": _object({
            "line_id": ID,
            "owners": _array({"type": "string"}),
            "status": {"type": "string", "example": "进行中"},
            "priority": {"type": "string", "enum": ["低", "中", "高", "紧急"]},
        }),
    }, ["ids", "patch"]), {"ids": [12, 13], "patch": {"status": "进行中", "priority": "高"}}),
))
_add("/api/tasks/bulk", "delete", _operation(
    "事务", "批量软删除事务", _ok({"ok": True, "count": 2, "can_undo": True}),
    _json_body(_object({"ids": _array(ID)}, ["ids"]), {"ids": [12, 13]}),
))
_add("/api/tasks/import-template", "get", _operation("事务", "下载事务 Excel 模板", _binary_response("Excel 模板", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))
_add("/api/tasks/import", "post", _operation("事务", "从 Excel 导入事务", _json_response("导入成功", _object({"ok": {"type": "boolean"}, "count": {"type": "integer"}, "ids": _array(ID), "can_undo": {"type": "boolean"}}), {"ok": True, "count": 2, "ids": [21, 22], "can_undo": True}), _file_body(), success_code="201"))
export_body = _json_body(_object({
    "scope": {"type": "string", "enum": ["all", "selected"], "example": "selected"},
    "ids": _array(ID),
}, ["scope"]), {"scope": "selected", "ids": [12, 13]})
_add("/api/tasks/export", "post", _operation("事务", "导出事务 Excel", _binary_response("事务 Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), export_body))
_add("/api/task-images/{image_id}", "get", _operation("事务", "下载事务图片", _binary_response("图片文件", "image/png")))
_add("/api/task-attachments/{attachment_id}", "get", _operation("事务", "下载事务附件", _binary_response("附件文件")))

# Collaboration and notifications
_add("/api/tasks/{task_id}/collaboration", "get", _operation(
    "协作通知", "查询事务关注、评论与动态",
    _json_response("协作详情", _object({
        "following": {"type": "boolean"},
        "followers": _array(_ref("User")),
        "timeline": _array({"type": "object"}),
        "members": _array(_ref("User")),
    }), {"following": True, "followers": [], "timeline": [], "members": []}),
))
_add("/api/tasks/{task_id}/follow", "post", _operation("协作通知", "关注事务", _ok({"ok": True, "following": True})))
_add("/api/tasks/{task_id}/follow", "delete", _operation("协作通知", "取消关注事务", _ok({"ok": True, "following": False})))
_add("/api/tasks/{task_id}/comments", "post", _operation(
    "协作通知", "发布事务评论",
    _created(_object({"id": ID, "created_at": {"type": "string", "format": "date-time"}}), {"id": 35, "created_at": "2026-09-09T08:30:00Z"}),
    _json_body(_object({"content": {"type": "string", "example": "@开发成员 请确认联调结果"}}, ["content"])), success_code="201",
))
_add("/api/notifications", "get", _operation(
    "协作通知", "查询本人协作通知",
    _json_response("未读优先，最多返回 100 条", _object({
        "notifications": _array(_ref("Notification")),
        "unread_count": {"type": "integer", "example": 1},
    }), {"notifications": [], "unread_count": 0}),
))
_add("/api/notifications/read-all", "post", _operation("协作通知", "将当前空间全部协作通知标为已读", _ok({"ok": True, "unread_count": 0})))
_add("/api/notifications/{notification_id}/read", "post", _operation("协作通知", "将一条协作通知标为已读", _ok({"ok": True, "unread_count": 0})))

# Unified import/export
_add("/api/data/import-template", "get", _operation("导入导出", "下载统一 Excel 导入模板", _binary_response("统一模板", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))
_add("/api/data/import", "post", _operation(
    "导入导出", "统一导入线路和事务",
    _json_response("原子导入成功", _object({
        "ok": {"type": "boolean"},
        "count": {"type": "integer"},
        "line_count": {"type": "integer"},
        "task_count": {"type": "integer"},
        "line_ids": _array(ID),
        "task_ids": _array(ID),
        "can_undo": {"type": "boolean"},
    }), {"ok": True, "count": 4, "line_count": 2, "task_count": 2, "line_ids": [12, 13], "task_ids": [21, 22], "can_undo": True}),
    _file_body(), success_code="201",
))
_add("/api/data/export", "post", _operation("导入导出", "统一导出线路和事务", _binary_response("统一数据 Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), export_body))

# Undo, redo and trash
_add("/api/undo", "post", _operation("恢复", "撤销当前空间最近一次编辑"))
_add("/api/redo", "post", _operation("恢复", "恢复当前空间最近一次撤销"))
_add("/api/trash", "get", _operation(
    "恢复", "查询当前空间回收站",
    _json_response("按删除批次返回对象", _object({
        "batches": _array({"type": "object"}),
        "lines": _array(_ref("Line")),
        "tasks": _array(_ref("Task")),
        "milestones": _array(_ref("Milestone")),
    }), {"batches": [], "lines": [], "tasks": [], "milestones": []}),
))
_add("/api/trash/restore", "post", _operation(
    "恢复", "按删除批次恢复对象", body=_json_body(_object({
        "batch": {"type": "integer", "example": 1725868800000},
    }, ["batch"])),
))
_add("/api/trash/purge", "post", _operation("恢复", "永久清空当前空间回收站"))

# Audit
audit_parameters = [
    _query_parameter("username", description="操作时账号，精确匹配"),
    _query_parameter("operation", description="操作代码，精确匹配"),
    _query_parameter("object_type", description="对象类型代码，精确匹配"),
    _query_parameter("object_id", description="对象 ID，精确匹配"),
    _query_parameter("q", description="对象名称或 ID 的字面子串"),
    _query_parameter("start", {"type": "string", "format": "date-time"}, "含时区的起始时间，包含边界"),
    _query_parameter("end", {"type": "string", "format": "date-time"}, "含时区的结束时间，包含边界"),
    _query_parameter("page", {"type": "integer", "minimum": 1, "default": 1}),
    _query_parameter("page_size", {"type": "integer", "minimum": 1, "maximum": 100, "default": 25}),
]
_add("/api/audit", "get", _operation(
    "操作审计", "分页查询当前空间操作审计",
    _json_response("审计摘要列表", _object({
        "items": _array(_ref("AuditRecord")),
        "total": {"type": "integer", "example": 1},
        "page": {"type": "integer", "example": 1},
        "page_size": {"type": "integer", "example": 25},
        "workspace_id": ID,
        "operations": {"type": "object", "additionalProperties": {"type": "string"}},
        "object_types": {"type": "object", "additionalProperties": {"type": "string"}},
    }), {"items": [{"id": 8, "username": "admin", "operation": "update", "object_type": "task", "object_id": "123", "object_name": "完成接口联调", "created_at": "2026-09-09T08:30:00Z", "request_id": "example-request-id"}], "total": 1, "page": 1, "page_size": 25, "workspace_id": 1, "operations": {"update": "修改"}, "object_types": {"task": "事务"}}),
    parameters=audit_parameters,
))
_add("/api/audit/{record_id}", "get", _operation(
    "操作审计", "读取操作审计前后快照",
    _json_response("审计详情", _object({
        "id": ID,
        "workspace_id": ID,
        "username": {"type": "string"},
        "operation": {"type": "string"},
        "object_type": {"type": "string"},
        "object_id": {"type": "string"},
        "object_name": {"type": "string"},
        "created_at": {"type": "string", "format": "date-time"},
        "snapshot": _object({
            "before": {"type": "object", "nullable": True, "additionalProperties": True},
            "after": {"type": "object", "nullable": True, "additionalProperties": True},
        }),
    }), {"id": 8, "workspace_id": 1, "username": "admin", "operation": "update", "object_type": "task", "object_id": "123", "object_name": "完成接口联调", "created_at": "2026-09-09T08:30:00Z", "snapshot": {"before": {"status": "未启动"}, "after": {"status": "进行中"}}}),
))


OPENAPI_SPEC = {
    "openapi": "3.0.3",
    "info": {
        "title": "AnyLine HTTP API",
        "version": "1.0.0",
        "description": (
            "AnyLine 同源 HTTP API。除登录、会话查询和本文档外，接口使用浏览器的 "
            "HttpOnly Cookie 会话，并默认作用于当前项目空间。Swagger 中执行写请求会直接修改真实数据。"
        ),
    },
    "servers": [{"url": "/", "description": "当前 AnyLine 实例"}],
    "tags": TAGS,
    "security": [{"cookieAuth": []}],
    "paths": PATHS,
    "components": {
        "securitySchemes": {
            "cookieAuth": {
                "type": "apiKey",
                "in": "cookie",
                "name": "session",
                "description": "由 POST /api/auth/login 建立；同源 Swagger 页面会自动携带。",
            }
        },
        "schemas": SCHEMAS,
        "responses": ERROR_RESPONSES,
    },
}


def build_openapi_spec():
    """Return an isolated document so callers cannot mutate the module template."""
    return deepcopy(OPENAPI_SPEC)
