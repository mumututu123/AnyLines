# AnyLine HTTP 接口契约

文档编号：AL-API-001 · 版本：1.0 · 日期：2026-09-07

关联：[产品规范](product-spec.md) · [审计专项](features/001-audit.md)

## 1. 通用约定

- API 前缀为 `/api`，与页面同源，使用登录后的 Cookie 会话；当前没有 Bearer Token 或 API 版本前缀。
- JSON 请求使用 `Content-Type: application/json`，需要请求体时必须是对象；Excel 上传使用 multipart 的 `file` 字段。
- 普通业务对象均隐含当前空间，不能通过提交任意 `workspace_id` 扩大访问范围。
- 下文 `:id`、`:workspace_id`、`:user_id` 等表示路径参数，不是路径字面量。
- 创建通常返回 `201 {"id":123}`，更新通常返回 `200 {"ok":true}`；例外见各接口。
- API 不采用统一的 `{code,data,message}` 包装。业务错误通常为 `{"error":"说明"}`，导入错误可带工作表和行号明细。
- ID 请求字段为整数且不接受布尔值；时间日期约束见产品规范。PATCH 只更新受支持字段；未提供字段保留原值，集合字段的替换语义见下文。
- 应用请求体上限 64 MiB，文件及导入另有更小的业务上限。

| 状态码 | 约定 |
| --- | --- |
| 200 | 查询、更新或幂等操作成功 |
| 201 | 新对象或新关系创建成功 |
| 400 | 输入类型、必填、格式、日期、导入内容等无效 |
| 401 | 未登录、会话失效或登录凭据错误 |
| 403 | 角色不足、无可访问空间或无权操作目标空间 |
| 404 | 对象不存在、已删除或不在接口允许访问的空间内 |
| 409 | 已归档、依赖未闭环、仍被引用、重复成员等业务冲突 |
| 413 | 超过应用请求体总大小限制；较小的文件业务上限按输入校验返回 400 |
| 500 | 未预期服务错误，包括审计提交失败；不得解释为业务已成功 |

## 2. 接口目录

权限简写：`成员`＝当前空间有效成员；`可编辑成员`＝成员且空间未归档；`管理员`＝目标空间管理员。头像和密码接口操作本人账号。

### 2.1 身份与空间

| 方法 | 路径 | 输入 / 结果 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/auth/session` | 返回会话载荷；未登录返回 `authenticated:false` | 无需预先登录 |
| POST | `/api/auth/login` | `username,password` → 会话载荷及 Cookie | 无需预先登录 |
| POST | `/api/auth/logout` | 清除会话，返回 ok | 成员 |
| PUT | `/api/auth/password` | `current_password,new_password` → ok | 本人 |
| GET | `/api/auth/avatar` | 返回本人头像图片；无头像返回不存在 | 本人 |
| PUT | `/api/auth/avatar` | `data_url` → `avatar_url` | 本人 |
| POST | `/api/workspaces` | `name,description?` → id，并切换至新空间 | 任一空间管理员 |
| PATCH | `/api/workspaces/:workspace_id` | `name?,description?` → ok | 管理员且未归档 |
| POST | `/api/workspaces/:workspace_id/archive` | 归档 → `ok,archived_at` | 管理员 |
| POST | `/api/workspaces/:workspace_id/restore` | 取消归档 → ok | 管理员 |
| DELETE | `/api/workspaces/:workspace_id` | `confirmation` 必须等于空间名称 → `ok,current_workspace_id` | 管理员 |
| POST | `/api/workspaces/:workspace_id/select` | 切换会话空间 → ok | 目标空间成员 |
| GET | `/api/workspaces/:workspace_id/members` | `members` 数组，含角色和 `can_manage_account` | 管理员 |
| POST | `/api/workspaces/:workspace_id/members` | `username,display_name?,password?,role?` → `user_id` | 管理员且未归档 |
| PATCH | `/api/workspaces/:workspace_id/members/:user_id` | `role?,display_name?,password?` → ok | 管理员且未归档；账号字段受维护归属限制 |
| DELETE | `/api/workspaces/:workspace_id/members/:user_id` | 移除本空间成员 → ok，不删除全局账号 | 管理员且未归档 |

添加已存在账号时建立成员关系，不重设其姓名或密码；新账号必须提供有效密码。角色缺省为 `member`。

### 2.2 业务对象与配置

| 方法 | 路径 | 输入 / 结果 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/state` | 当前空间聚合状态，结构见第 3 节 | 成员 |
| GET | `/api/dashboard/history` | `workspace_id,snapshots`；最近 90 个场景记录日，按日期升序，条目含 `snapshot_date,captured_at,total,done` | 成员，允许已归档空间 |
| GET | `/api/dashboard/history/:date` | `workspace_id,snapshot_date,captured_at,scene`；场景含 `tasks,lines,dependencies,milestones`，无记录返回 404 | 当前空间成员，允许已归档空间 |
| GET | `/api/statuses` | `statuses,colors` | 成员 |
| PUT | `/api/statuses` | `statuses,colors?` → `ok,statuses,colors` | 可编辑成员 |
| POST | `/api/lines` | 线创建字段 → id | 可编辑成员 |
| PATCH | `/api/lines/:id` | 线可修改字段 → ok | 可编辑成员 |
| DELETE | `/api/lines/:id` | 级联软删除 → ok 及恢复相关标志 | 可编辑成员 |
| POST | `/api/tasks` | 事务创建字段（可含 `initial_comment` 首条协作动态）→ id | 可编辑成员 |
| PATCH | `/api/tasks/:id` | 事务可修改字段 → ok | 可编辑成员 |
| DELETE | `/api/tasks/:id` | 软删除 → `ok,can_undo` | 可编辑成员 |
| POST | `/api/tasks/:id/dependencies` | `prerequisite_task_id` → `ok,created`；新增 201，已存在 200 | 可编辑成员 |
| DELETE | `/api/tasks/:id/dependencies` | `prerequisite_task_id` → ok；关系不存在 404 | 可编辑成员 |
| PATCH | `/api/tasks/bulk` | `ids,patch` → `ok,count` | 可编辑成员 |
| DELETE | `/api/tasks/bulk` | `ids` → `ok,count,can_undo` | 可编辑成员 |
| POST | `/api/milestones` | 里程碑创建字段 → id | 可编辑成员 |
| PATCH | `/api/milestones/:id` | 里程碑可修改字段 → ok | 可编辑成员 |
| DELETE | `/api/milestones/:id` | 软删除 → ok 及恢复相关标志 | 可编辑成员 |
| GET | `/api/task-images/:id` | 图片二进制 | 成员，且对象有效 |
| GET | `/api/task-attachments/:id` | 带下载文件名的二进制 | 成员，且对象有效 |

### 2.3 协作、导入导出与恢复

| 方法 | 路径 | 输入 / 结果 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/tasks/:id/collaboration` | 关注人、是否关注、评论和动态时间线、可提及成员 | 成员 |
| POST | `/api/tasks/:id/follow` | `ok,following:true` | 可编辑成员 |
| DELETE | `/api/tasks/:id/follow` | `ok,following:false` | 可编辑成员 |
| POST | `/api/tasks/:id/comments` | `content` → `id,created_at` | 可编辑成员 |
| GET | `/api/notifications` | `notifications,unread_count`；仅返回 `assigned,mention,comment,status_changed,dependency_unblocked`，最多 100 条，未读优先 | 成员本人 |
| POST | `/api/notifications/read-all` | 将当前空间全部协作通知标为已读，返回 `ok,unread_count:0` | 成员本人 |
| POST | `/api/notifications/:id/read` | 将指定协作通知标为已读并返回 `ok,unread_count`；非协作类型按不存在处理 | 成员本人 |
| GET | `/api/data/import-template` | 统一 Excel 模板 | 成员 |
| POST | `/api/data/import` | multipart 文件 → `ok,count,line_count,task_count,line_ids,task_ids,can_undo`，201 | 可编辑成员 |
| POST | `/api/data/export` | `scope,ids?` → Excel | 成员 |
| GET | `/api/lines/import-template` | 线模板 | 成员 |
| POST | `/api/lines/import` | multipart 文件 → `ok,count,ids,can_undo`，201 | 可编辑成员 |
| GET | `/api/lines/export` | 线 Excel | 成员 |
| GET | `/api/tasks/import-template` | 事务模板 | 成员 |
| POST | `/api/tasks/import` | multipart 文件 → `ok,count,ids,can_undo`，201 | 可编辑成员 |
| POST | `/api/tasks/export` | `scope,ids?` → 事务 Excel | 成员 |
| POST | `/api/undo` | 执行空间最近一次撤销 → ok | 可编辑成员 |
| POST | `/api/redo` | 执行空间单步重做 → ok | 可编辑成员 |
| GET | `/api/trash` | `batches,lines,tasks,milestones` | 成员 |
| POST | `/api/trash/restore` | `batch` → ok | 可编辑成员 |
| POST | `/api/trash/purge` | 清空当前空间回收站 → ok | 可编辑成员 |

统一导出 `scope` 为 `all` 或 `selected`；选中导出必须提供有效非空事务 ID 集合。独立的线/事务导入导出入口为既有兼容接口，主界面优先使用统一入口。

### 2.4 审计

| 方法 | 路径 | 结果 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/audit` | 分页摘要、类型字典与当前空间 ID | 当前空间管理员 |
| GET | `/api/audit/:id` | 单条记录及前后快照 | 当前空间管理员 |

两类响应设置 `Cache-Control: no-store`。参数和详细语义见第 5 节及 [专项 Spec](features/001-audit.md)。

## 3. 聚合与业务字段

### 3.1 会话与项目状态

登录和有效会话返回：

```json
{
  "authenticated": true,
  "user": {"id": 1, "username": "reviewer", "display_name": "项目管理员", "avatar_url": null},
  "workspaces": [{"id": 1, "name": "示例项目", "description": "", "archived_at": null, "role": "admin"}],
  "current_workspace": {"id": 1, "name": "示例项目", "description": "", "archived_at": null, "role": "admin"}
}
```

以上为说明性样例，不是实际账号或数据库导出。

`GET /api/state` 返回 `lines,tasks,milestones,dependencies,task_images,task_attachments,can_undo,can_redo,status_enum,status_colors,priority_enum,owners,collaboration_members,unread_notifications,today,dashboard_snapshots`。业务列表排除已删除对象，文件列表只含元数据。该接口没有通用分页，不应据此承诺大规模数据加载性能。

### 3.2 创建及修改字段

| 对象 | 创建必填 | 可选字段 / 默认 | PATCH 边界 |
| --- | --- | --- | --- |
| 线 | `name` | `description` 空、`color` 空、`parent_id` 空、`fork_date` 默认今日 | `name,description,color,fork_date,merge_date`；不支持修改父线 |
| 事务 | `line_id,name,content,owner,status,start_date,end_date` | `priority` 默认中；`goal,next_action,risk_reason` 空；关系及文件数组默认空 | 业务字段及 `prerequisite_ids,images,attachments`；状态和日期按更新后的整体对象校验 |
| 里程碑 | `line_id,name,target_description,milestone_date` | `acceptance_task_ids` 默认空 | `name,target_description,milestone_date,acceptance_task_ids`；不修改所属线 |

事务表单及创建 API 均要求有效状态；数据库列的 `未启动` 默认值不替代 API 必填校验。依赖集合 `prerequisite_ids`、里程碑验收集合 `acceptance_task_ids` 是完整替换集合，更新时省略表示保留，传空数组表示清空。

颜色使用 `#RRGGBB`，空值表示未指定；支线 `merge_date:null` 或空字符串取消反合。批量 patch 仅允许 `line_id,owner,status,priority`，不支持批量修改任意字段。

### 3.3 文件描述

新增图片：`{"data_url":"data:image/png;base64,..."}`；保留图片：`{"id":12}`。

新增附件：`{"name":"说明.txt","data_url":"data:text/plain;base64,..."}`；保留附件：`{"id":34}`。

更新提交 `images` 或 `attachments` 时，仅保留数组中列出的已有对象并新增新文件；省略数组表示不改变文件集合。新建事务不得引用其他事务的已有文件 ID。

头像输入为 PNG、JPEG 或 WebP 的 data URL，源文件最多 5 MiB，宽高均至少 64 像素，总像素最多 25,000,000。服务端裁切缩放为 256 × 256，透明图片保存 PNG，否则保存 JPEG，处理后最多 1 MiB。

## 4. 典型写入请求

```http
POST /api/tasks
Content-Type: application/json
Cookie: <登录会话>
```

```json
{
  "line_id": 12,
  "name": "完成接口联调",
  "content": "核对请求与响应并记录异常",
  "owner": "张三",
  "status": "进行中",
  "start_date": "2026-09-07",
  "end_date": "2026-09-14",
  "priority": "高",
  "goal": "全部约定场景验证通过",
  "next_action": "准备联调数据",
  "risk_reason": "",
  "prerequisite_ids": []
}
```

示例中的线和责任人须已存在于当前空间。成功返回 `201 {"id":123}`；若前置事务未闭环却尝试闭环当前事务，返回 409；若数据验证失败，不应出现部分业务写入。

## 5. 审计查询契约

| 参数 | 类型 / 默认 | 匹配方式 |
| --- | --- | --- |
| `username` | 可选字符串 | 操作时账号完整精确匹配；与登录账号 NOCASE 比较不要混淆 |
| `operation` | 可选字符串 | 操作代码精确匹配 |
| `object_type` | 可选字符串 | 对象类型代码精确匹配 |
| `object_id` | 可选字符串 | 对象 ID 精确匹配 |
| `q` | 可选字符串 | 对象名称或 ID 的字面子串；不搜索快照全文 |
| `start / end` | 可选含时区 ISO 8601 字符串 | 转为 UTC，起止均包含边界；起始不得晚于结束 |
| `page` | 整数，默认 1 | 从 1 开始 |
| `page_size` | 整数，默认 25 | 1–100 |

多条件使用 AND 组合。列表按 `created_at DESC,id DESC` 排序。前端以本地日期时间收集条件并转换为 UTC；结束时间输入精确到分钟时扩展到该分钟末尾。

列表响应：

```json
{
  "items": [
    {"id": 8, "username": "reviewer", "operation": "update", "object_type": "task", "object_id": "123", "object_name": "完成接口联调", "created_at": "2026-09-07T08:30:00.000000Z", "request_id": "example-request-id"}
  ],
  "total": 1,
  "page": 1,
  "page_size": 25,
  "workspace_id": 1,
  "operations": {"update": "修改"},
  "object_types": {"task": "事务"}
}
```

样例字典仅展示一项，真实响应返回完整操作及对象字典。列表不带快照，点击详情通过 `/api/audit/:id` 获取。

详情包含列表字段、`workspace_id,user_id,snapshot`。`snapshot` 为 `{before,after}`，账号改密时可附 `password_changed:true`；before/after 为对象状态或 null，业务对象字段随类型不同。不存在或属于其他空间的记录统一返回 404，普通成员返回 403。

## 6. 兼容与重试约定

新增字段应允许旧客户端忽略；删除、改名、默认值和权限变化必须进入变更规格。当前没有通用幂等键，客户端不得把所有失败写请求自动重试；例如创建成功但响应丢失时，重试可能新增第二个对象，应先核对业务状态。

重复关注与重复新增相同依赖具有接口自身的幂等处理，不代表所有 POST 都幂等。并发更新没有 `If-Match`、版本号或条件写入协议，调用方应避免假定服务端会自动合并编辑。
