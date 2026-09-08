# AnyLine 验收与需求追踪矩阵

文档编号：AL-AC-001 · 版本：1.0 · 日期：2026-09-07

关联：[产品规范](product-spec.md) · [审计专项](features/001-audit.md)

## 1. 验收原则

验收应同时核对业务行为、权限边界、失败回滚和页面可用性。接口测试通过不自动代表浏览器行为正确；源码字符串断言不等同于实际页面操作；既有自动化结果不替代业务负责人确认。

本表的测试名称均对应 [`tests/test_app.py`](../tests/test_app.py)，浏览器检查指 [`tests/check_audit_ui.cjs`](../tests/check_audit_ui.cjs)。“部分”表示已有对应证据但不能覆盖该需求的全部表达。

## 2. 需求—实现—验证对应

| 需求编号 | 实现入口 / 关键规则 | 已有验证 | 覆盖说明 |
| --- | --- | --- | --- |
| AL-AUTH-001 | `auth_login,load_authenticated_context` | `test_authentication_is_required` | 登录与未登录拒绝 |
| AL-AUTH-002 | `auth_change_password,auth_avatar_update,workspace_member` | `test_user_can_upload_a_constrained_custom_avatar`；`test_admin_can_manage_member_role_and_password` | 账号、头像与角色管理主要路径 |
| AL-WS-001 | `current_workspace_id,select_workspace,resetWorkspaceState` | `test_workspace_isolation_and_member_permissions`；审计浏览器检查 | 业务空间隔离及审计切换 |
| AL-WS-002 | `create_workspace,archive_workspace,restore_workspace,delete_workspace` | `test_workspace_archive_is_read_only_and_workspace_can_be_deleted` | 归档、名称确认、恢复与删除限制 |
| AL-CFG-001 | `api_set_statuses,get_workspace_member_names` | `test_configuration_validation_and_member_owner_options` | 枚举、颜色校验与成员候选 |
| AL-LINE-001 | `create_line,update_line,delete_line` | `test_line_crud_and_date_rules`；`test_recursive_delete_restore_and_purge` | CRUD 与级联 |
| AL-LINE-002 | 线日期、父子线与反合校验 | `test_line_crud_and_date_rules`；`test_nested_branch_starts_on_parent_at_its_fork_date` | 接口约束及部分画布源码断言 |
| AL-TASK-001 | `create_task,update_task,delete_task` | `test_task_full_crud_from_canvas_payload`；`test_task_required_fields_and_modal_controls`；`test_task_validation_never_returns_500` | CRUD、必填及错误路径 |
| AL-TASK-002 | `bulk_tasks,renderTable` | `test_bulk_update_delete_and_undo`；`test_table_line_dropdown_only_uses_main_and_branch_lines` | 批量接口及部分表格源码断言 |
| AL-DEP-001 | `validate_dependencies,ensure_dependencies_closed,ensure_tasks_not_required` | `test_task_dependencies_and_closure_guard` | 环路、闭环、删除保护 |
| AL-MILE-001 | `create_milestone,update_milestone,validate_milestone_tasks` | `test_milestone_crud_acceptance_and_task_delete_guard`；`test_milestone_validation_archive_and_canvas_ui` | CRUD、日期、引用与归档 |
| AL-MILE-002 | `openMilestoneModal,milestoneStatusBands` | `test_milestone_validation_archive_and_canvas_ui`；`test_line_delete_restores_its_milestones_with_same_batch` | 展示部分为源码断言，完整交互需人工 |
| AL-FILE-001 | 图片/附件校验、替换和下载 | `test_task_content_images_are_persisted_served_and_undoable`；`test_task_attachments_are_downloadable_editable_and_undoable` | 存取、修改、恢复和无效文件 |
| AL-IO-001 | `import_data,import_lines,import_tasks` | `test_unified_excel_import_is_atomic_across_sheets`；`test_line_excel_import_is_atomic_on_invalid_hierarchy`；`test_excel_import_template_and_atomic_import` | 跨表与层级失败原子性 |
| AL-IO-002 | `export_data,export_tasks,export_lines` | `test_unified_excel_import_export_and_selected_lineage`；`test_excel_export_all_and_selected` | 选中导出、祖先线与回导 |
| AL-COL-001 | 关注、评论、提及、活动与通知函数 | `test_collaboration_comments_mentions_followers_and_notifications`；`test_status_activity_and_dependency_unblocked_notification` | 协作核心接口 |
| AL-COL-002 | `personalTodoTasks,openMyStatusModal` | `test_personal_todo_entry_count_and_statistics` | 主要为源码断言，跨真实姓名数据需人工核对 |
| AL-COL-003 | `COLLABORATION_NOTIFICATION_KINDS,pollNotificationCount` | `test_collaboration_comments_mentions_followers_and_notifications`；源码审阅 | 协作类型白名单、历史到期通知隔离及轮询；连续轮询边界需补专项测试 |
| AL-VIEW-001 | `renderCanvas,renderTable,taskDependencyFocus` | `test_canvas_dependency_focus_visual_encoding_and_semantic_zoom`；`test_same_day_tasks_spread_horizontally_at_high_zoom` | 部分为源码断言，不宣称完整视觉自动化 |
| AL-DASH-001 | `renderDashboard,update_dashboard_snapshot` | `test_dashboard_snapshot_metrics_and_same_day_update`；`test_dashboard_risk_bubbles_use_stable_click_targets` | 聚合接口与部分源码；打印和报告口径需人工核对 |
| AL-DASH-002 | `DashboardAnalysis`；场景历史接口 | `test_dashboard_history_preserves_scenes_and_workspace_scope`；`test_dashboard_history_migrates_existing_summary_snapshots`；`test_dashboard_history_retention_and_archived_read_access`；`check_dashboard_analysis.cjs`；`check_dashboard_analysis_ui.cjs` | 历史及个人数据隔离、迁移、保留上限、推演计算、六项交互与主题窄屏；实际执行结果见变更规格 |
| AL-REC-001 | `delete_line,restore_trash,purge_deleted` | `test_recursive_delete_restore_and_purge`；`test_restore_dependency_order`；`test_line_delete_restores_its_milestones_with_same_batch` | 批次、依赖恢复和级联 |
| AL-REC-002 | `on_edit,restore_snapshot,undo,redo` | `test_general_undo_for_canvas_edits`；`test_redo_restores_undo_and_is_cleared_by_a_new_edit` | 单步快照恢复；多人交错操作需补验收 |
| AL-UX-001 | `applyTheme`、头像菜单结构及样式 | 审计浏览器检查中的暗色展示；源码审阅 | 部分；系统主题、存储同步及按钮切换需人工 |
| AL-UX-002 | `openTaskModal,saveTaskCreateDraft` | `test_task_required_fields_and_modal_controls` | 部分为源码断言，草稿及上传失败交互需人工 |
| AL-AUD-001 | 审计菜单、`require_workspace_admin` | `test_audit_access_is_scoped_to_current_workspace_admin`；审计浏览器检查 | 权限、隐藏入口及已归档访问 |
| AL-AUD-002 | `audit.begin,capture,finish` | `test_audit_records_member_changes_and_filters`；`test_audit_import_is_per_object_and_retained_on_workspace_delete` | 成员操作、导入与对象级记录 |
| AL-AUD-003 | 延迟 commit 与审计最终提交 | `test_audit_failure_rolls_back_business_edit` | 故障注入，业务与日志同时回滚 |
| AL-AUD-004 | 快照脱敏、文件摘要 | `test_audit_account_secrets_are_redacted`；`test_audit_dependencies_attachments_comments_and_settings` | 密码、依赖、附件、评论与配置 |
| AL-AUD-005 | `query_audit,audit_detail,loadAuditPage` | `test_audit_records_member_changes_and_filters`；审计浏览器检查 | 查询参数、分页、快照、XSS 文本化 |
| AL-AUD-006 | 只追加触发器与空间删除保留 | `test_audit_bulk_undo_redo_cascade_restore_and_purge`；`test_audit_import_is_per_object_and_retained_on_workspace_delete` | 撤销、清理、日志不可直接更新删除 |
| AL-NFR-001 | 授权、字段校验及文本渲染 | 空间/审计权限测试；`test_task_validation_never_returns_500`；审计浏览器检查 | 功能性安全证据，非渗透报告 |
| AL-NFR-002 | SQLite 迁移与事务 | `test_legacy_schema_is_migrated`；导入与审计原子性测试 | 迁移及回滚；备份恢复演练未覆盖 |
| AL-NFR-003 | 状态加载、SQLite 写入、快照采集 | 尚无容量/压力基准 | 待约定环境、数据量与测量指标 |
| AL-NFR-004 | 焦点、主题、响应式及快捷键 | `test_canvas_shortcuts_include_redo_today_branch_and_task`；审计浏览器检查 | 部分；全站键盘和多浏览器需人工 |

## 3. 端到端业务验收场景

| 场景 | 前提 | 操作 | 验收结果 |
| --- | --- | --- | --- |
| AC-WS-001 | 用户只属于空间 A | 请求空间 B 的对象或管理接口 | 不返回 B 的对象内容，不产生修改 |
| AC-WS-002 | 管理员归档空间 A | 成员尝试改事务、评论、导入；管理员查询审计 | 编辑被拒绝，审计仍可查 |
| AC-TASK-001 | 有主线与成员 | 新建事务，表格改优先级，再从画布打开 | 三处数据一致，更新可追溯 |
| AC-DEP-001 | B 依赖未闭环的 A | 尝试闭环 B；闭环 A 后再闭环 B | 前一次 409，后一次成功；解除提醒按规则生成 |
| AC-MILE-001 | 里程碑关联事务 A | 删除 A；移除验收引用后再删除 A | 前一次阻止，后一次允许 |
| AC-IO-001 | Excel 线表有效、事务表有错误 | 提交统一导入 | 无部分新增对象，返回工作表/行错误信息 |
| AC-REC-001 | 线含嵌套支线、事务、里程碑 | 删除、恢复、撤销、重做 | 对象关系与批次正确，历史审计保留 |
| AC-COL-001 | 成员 A/B 同属空间 | A 评论并提及 B，B 查看通知并标记已读 | B 收到相关通知，A/B 的未读状态互不混用 |
| AC-DASH-001 | 周期内有闭环、取消、超期事项 | 打开看板、下钻并打印 | 聚合与源事务可核对，取消语义按本基线解释 |
| AC-UX-001 | 已登录且打开头像菜单 | 切换日夜模式、刷新，再打开菜单 | 按钮在上传图标左侧、风格一致，主题选择保留 |
| AC-UX-002 | 新建事务填写未提交内容 | 点击遮罩关闭后在同线重新打开 | 当前页面内恢复草稿，另一空间不混入草稿 |

审计的十个专项场景 `AC-AUD-001` 至 `AC-AUD-010` 见 [专项 Spec](features/001-audit.md)。

## 4. 可复现验证方法

在仓库根目录执行：

```powershell
python -m unittest discover -s tests -v
node --check static/app.js
node --check tests/check_audit_ui.cjs
```

安装 Chrome 的 Windows 与 Node 20+ 环境可执行：

```powershell
node --experimental-websocket tests/check_audit_ui.cjs
```

HTTP 测试使用临时数据库和本机随机端口；浏览器检查同样创建独立测试数据库与浏览器目录，不对业务库写入测试事项。浏览器脚本默认查找 Windows Chrome，可用 `ANYLINE_TEST_CHROME` 指定路径。

测试套件的适用环境应在每次验收记录中填写。依赖范围以 `requirements.txt` 为准；历史运行环境不自动证明声明范围内每种依赖组合均兼容。

## 5. 已观察的验证记录

以下记录引用本项目同日审计功能开发阶段已经执行的检查；本次仅整理文档，未重复运行业务测试。

| 日期 | 检查 | 已观察结果 | 限定 |
| --- | --- | --- | --- |
| 2026-09-07 | `python -m unittest discover -s tests -v` | 51 项通过，输出 `Ran 51 tests` 与 `OK` | Windows、Python 3.9 本地环境；不代表生产压测 |
| 2026-09-07 | Node JavaScript 语法检查 | `static/app.js` 与审计浏览器脚本检查通过 | 语法检查不能代替行为测试 |
| 2026-09-07 | 审计 Chrome 自动检查 | 管理员菜单、分页、筛选、前后快照、文本转义、暗色、窄屏、空间切换与成员限制通过 | 独立临时数据库，非全站浏览器套件 |

原运行输出未作为独立制品归档，当前可复现脚本与测试源文件均在仓库工作区。正式验收应重新运行并保存对应提交号、依赖版本、命令、输出和签署结论。

## 6. 验收门槛与未覆盖项

正式接受本基线前，应完成以下事项；本表未默认勾选通过。

- [ ] 业务负责人确认产品范围、权限矩阵及取消/闭环语义。
- [ ] 验收版本包含全部引用源文件与测试文件，并记录提交号。
- [ ] 自动化检查在目标依赖环境通过，输出保存为验收附件。
- [ ] 关键人工流程完成，包括画布、表格、里程碑编辑返回、草稿、主题及打印。
- [ ] 部署方确认备份方式，并完成数据库恢复演练。
- [ ] 根据部署规模决定是否增加性能、并发、安全及多浏览器验证。
- [ ] 所有未决问题有明确接受、修复或延期结论。

尚未建立的证据包括性能与长时稳定性、多人编辑冲突、跨日提醒、数据库容量增长、多浏览器完整兼容和安全专项。它们不是已通过的隐含验收项。
