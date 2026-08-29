/* AnyLine 前端逻辑：看板 + 画布视图 + 表格视图 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  lines: [], tasks: [], dependencies: [], taskImages: [], canUndo: false,
  statusEnum: [], statusColors: {},
  priorityEnum: [], owners: [], today: "",
  user: null, workspaces: [], currentWorkspace: null,
  selectedLineId: null,
  selectedTaskId: null,
  selectedTaskIds: new Set(),
  view: "canvas",
  show: { name: true, status: true, dur: true, owner: true },
  expandedClusters: new Set(),   // 已展开的同天多事务簇 key: "lineId|date"
  hiddenBranchIds: new Set(),    // 画布中已折叠的支线（支线自身及其后代隐藏）
  canvasTaskPositions: new Map(),
  zoom: 1,                       // 画布缩放倍数 (Ctrl+滚轮)
  pan: { x: 0, y: 0 },           // 画布拖拽位移（屏幕像素）
  filters: { q: "", line: "", owner: "", status: "", priority: "", due: "" },
  quickFilter: "",
  sort: "start_asc",
};

const SOON_DAYS = 7;
const STALE_DAYS = 7;
const DONE_STATUSES = new Set(["已闭环", "已取消"]);
const RISK_STATUSES = new Set(["有风险"]);
const PRIORITY_WEIGHT = { "低": 1, "中": 2, "高": 3, "紧急": 4 };
const DEFAULT_STATUS_COLORS = {
  "未启动": "#8c959f", "进行中": "#0969da", "有风险": "#d4a72c",
  "等待中": "#0e7490", "已暂停": "#8250df", "已闭环": "#1a7f37",
  "已取消": "#57606a",
};
const TASK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_TASK_IMAGES = 8;
const MAX_TASK_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TASK_IMPORT_BYTES = 5 * 1024 * 1024;

/* ---------------------------------------------- 界面偏好记忆 (localStorage) */
const PREFS_KEY = "anyline.prefs";

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      show: state.show,
      view: state.view,
      zoom: state.zoom,
      sort: state.sort,
    }));
  } catch (_e) { /* 隐私模式等场景忽略 */ }
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (p.show && typeof p.show === "object") {
      for (const k of Object.keys(state.show)) {
        if (typeof p.show[k] === "boolean") state.show[k] = p.show[k];
      }
    }
    if (["dashboard", "canvas", "table"].includes(p.view)) state.view = p.view;
    if (typeof p.zoom === "number" && p.zoom >= 0.25 && p.zoom <= 4) {
      state.zoom = p.zoom;
    }
    if (["start_asc", "due_asc", "priority_desc", "updated_desc"].includes(p.sort)) {
      state.sort = p.sort;
    }
  } catch (_e) { /* 数据损坏则用默认值 */ }
}

const LINE_COLORS = ["#0969da", "#8250df", "#bf3989", "#d4772c",
                     "#1a7f37", "#cf222e", "#0e7490", "#6e7781"];

function lineDisplayColor(line, colorRows = null) {
  if (line && line.color) return line.color;
  const row = line && colorRows ? colorRows.get(line.id) :
    (line ? assignRows(true).get(line.id) : state.lines.length);
  return LINE_COLORS[(row ?? state.lines.length) % LINE_COLORS.length];
}

/* ---------------------------------------------------------------- utils */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

const taskImageViewer = { images: [], index: 0, returnFocus: null };

function renderTaskImageViewer() {
  const current = taskImageViewer.images[taskImageViewer.index];
  if (!current) return;
  const image = $("#image-lightbox-image");
  image.src = current.src;
  image.alt = current.alt;
  $("#image-lightbox-caption").textContent =
    `${current.alt} · ${taskImageViewer.index + 1} / ${taskImageViewer.images.length}`;
  const hasMultiple = taskImageViewer.images.length > 1;
  $("#image-lightbox-prev").classList.toggle("hidden", !hasMultiple);
  $("#image-lightbox-next").classList.toggle("hidden", !hasMultiple);
}

function openTaskImageViewer(images, index, trigger) {
  taskImageViewer.images = images.map((image, imageIndex) => ({
    src: image.src || image.data_url,
    alt: `事务内容图片 ${imageIndex + 1}`,
  }));
  taskImageViewer.index = index;
  taskImageViewer.returnFocus = trigger;
  renderTaskImageViewer();
  $("#image-lightbox").classList.remove("hidden");
  $("#image-lightbox-close").focus();
}

function closeTaskImageViewer({ restoreFocus = true } = {}) {
  const lightbox = $("#image-lightbox");
  if (lightbox.classList.contains("hidden")) return;
  lightbox.classList.add("hidden");
  $("#image-lightbox-image").removeAttribute("src");
  if (restoreFocus && taskImageViewer.returnFocus?.isConnected) {
    taskImageViewer.returnFocus.focus();
  }
  taskImageViewer.images = [];
  taskImageViewer.returnFocus = null;
}

function moveTaskImageViewer(offset) {
  const count = taskImageViewer.images.length;
  if (count < 2) return;
  taskImageViewer.index = (taskImageViewer.index + offset + count) % count;
  renderTaskImageViewer();
}

$("#image-lightbox-close").onclick = () => closeTaskImageViewer();
$("#image-lightbox-prev").onclick = () => moveTaskImageViewer(-1);
$("#image-lightbox-next").onclick = () => moveTaskImageViewer(1);
$("#image-lightbox").onclick = (event) => {
  if (event.target === $("#image-lightbox")) closeTaskImageViewer();
};

async function api(url, method = "GET", body = null) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body) opt.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opt);
  } catch (error) {
    toast("无法连接服务器，请检查服务是否已启动");
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== "/api/auth/login") showLoggedOut();
    toast(data.error || `请求失败 (${res.status})`);
    throw new Error(data.error || res.status);
  }
  return data;
}

function showLoggedOut() {
  closeAccountMenu();
  closeTaskImageViewer({ restoreFocus: false });
  document.body.classList.remove("authenticated");
  document.body.classList.remove("workspace-archived");
  state.user = null;
  state.workspaces = [];
  state.currentWorkspace = null;
  $("#modal-mask").classList.add("hidden");
  $("#login-password").value = "";
  $("#login-username").focus();
}

function applySession(data) {
  state.user = data.user;
  state.workspaces = data.workspaces || [];
  state.currentWorkspace = data.current_workspace;
  document.body.classList.add("authenticated");
  const select = $("#workspace-select");
  select.innerHTML = "";
  for (const workspace of state.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.archived_at ?
      `${workspace.name}（已归档）` : workspace.name;
    option.selected = workspace.id === state.currentWorkspace.id;
    select.appendChild(option);
  }
  const isCurrentAdmin = state.currentWorkspace?.role === "admin";
  const isArchived = Boolean(state.currentWorkspace?.archived_at);
  const canManageWorkspaces = state.workspaces.some(
    (workspace) => workspace.role === "admin"
  );
  document.body.classList.toggle("workspace-archived", isArchived);
  select.classList.toggle("archived", isArchived);
  select.title = isArchived ? "当前项目空间已归档，仅可浏览" : "切换项目空间";
  $("#btn-workspaces").classList.toggle("hidden", !canManageWorkspaces);
  $("#btn-members").classList.toggle("hidden", !isCurrentAdmin || isArchived);
  $("#btn-statuses").classList.toggle("hidden", isArchived);
  const displayName = (state.user.display_name || state.user.username || "").trim();
  const accountName = state.user.username || displayName;
  $("#account-avatar").textContent = Array.from(displayName)[0]?.toLocaleUpperCase() || "用";
  $("#account-trigger").setAttribute("aria-label", `${displayName}，打开账号菜单`);
  $("#current-user").textContent = displayName;
  $("#current-username").textContent = accountName === displayName ? "" : accountName;
  $("#current-username").classList.toggle("hidden", accountName === displayName);
  $("#current-user-role").textContent = isCurrentAdmin ? "管理员" : "普通用户";
}

function isWorkspaceArchived() {
  return Boolean(state.currentWorkspace?.archived_at);
}

function ensureWorkspaceEditable() {
  if (!isWorkspaceArchived()) return true;
  toast("项目空间已归档，仅可浏览，不能编辑");
  return false;
}

function closeAccountMenu({ restoreFocus = false } = {}) {
  const menu = $("#account-menu");
  const trigger = $("#account-trigger");
  if (!menu || !trigger) return;
  menu.classList.add("hidden");
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function toggleAccountMenu() {
  const menu = $("#account-menu");
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  $("#account-trigger").setAttribute("aria-expanded", String(willOpen));
  if (willOpen) menu.querySelector('[role="menuitem"]:not(.hidden)')?.focus();
}

function resetWorkspaceState() {
  state.selectedLineId = null;
  state.selectedTaskId = null;
  state.selectedTaskIds.clear();
  state.expandedClusters.clear();
  state.hiddenBranchIds.clear();
  state.dependencies = [];
  state.taskImages = [];
  state.pan = { x: 0, y: 0 };
  state.filters = { q: "", line: "", owner: "", status: "", priority: "", due: "" };
  state.quickFilter = "";
}

async function refreshSession() {
  const data = await api("/api/auth/session");
  if (!data.authenticated) {
    showLoggedOut();
    return false;
  }
  applySession(data);
  return true;
}

function parseDate(s) { return new Date(s + "T00:00:00"); }
function fmtDays(n) {
  return n >= 1 ? `${n}天` : "今日";
}
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
function lineById(id) { return state.lines.find((l) => l.id === id); }
function taskById(id) { return state.tasks.find((t) => t.id === id); }
function prerequisiteIds(taskId) {
  return state.dependencies
    .filter((dependency) => dependency.dependent_task_id === taskId)
    .map((dependency) => dependency.prerequisite_task_id);
}
function isDone(t) { return DONE_STATUSES.has(t.status); }
function priorityRank(p) { return PRIORITY_WEIGHT[p] || 0; }
function statusClass(status) {
  return ["未启动", "进行中", "有风险", "等待中", "已暂停", "已闭环", "已取消"].includes(status)
    ? `st-${status}` : "st-custom";
}
function statusColor(status) {
  return state.statusColors[status] || DEFAULT_STATUS_COLORS[status] || "#6e7781";
}
function decorateStatusSelect(select) {
  select.classList.add("status-select");
  for (const option of select.options) {
    if (option.value) option.style.color = statusColor(option.value);
  }
  const paint = () => {
    const hasStatus = Boolean(select.value);
    select.classList.toggle("has-status", hasStatus);
    if (hasStatus) {
      select.style.setProperty("--status-color", statusColor(select.value));
    } else {
      select.style.removeProperty("--status-color");
    }
  };
  select.oninput = paint;
  paint();
}
function ownerOptions() {
  return [...new Set(state.owners)].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function taskHealth(t) {
  const h = {
    overdue: false, soon: false, stale: false, risk: RISK_STATUSES.has(t.status),
    labels: [],
    className: "",
  };
  if (!isDone(t) && t.end_date) {
    const left = daysBetween(state.today, t.end_date);
    h.overdue = left < 0;
    h.soon = left >= 0 && left <= SOON_DAYS;
  }
  h.stale = !isDone(t) && daysBetween(t.status_since, state.today) >= STALE_DAYS;
  if (h.overdue) h.labels.push(["超期", "badge-overdue"]);
  else if (h.soon) h.labels.push(["即将到期", "badge-soon"]);
  if (h.risk) h.labels.push(["风险", "badge-risk"]);
  if (h.stale) h.labels.push(["停留过久", "badge-stale"]);
  if (!h.labels.length && isDone(t)) h.labels.push(["已结束", "badge-ok"]);
  h.className = h.overdue ? "health-overdue" : (h.soon ? "health-soon" : (h.stale ? "health-stale" : ""));
  return h;
}
function searchableText(t) {
  const ln = lineById(t.line_id);
  return [
    ln && ln.name, t.name, t.content, t.goal, t.owner, t.status,
    t.priority, t.next_action, t.risk_reason,
  ].filter(Boolean).join(" ").toLowerCase();
}
function taskMatchesFilters(t) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const h = taskHealth(t);
  if (q && !searchableText(t).includes(q)) return false;
  if (f.line && String(t.line_id) !== f.line) return false;
  if (f.owner && t.owner !== f.owner) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.priority && t.priority !== f.priority) return false;
  if (f.due === "overdue" && !h.overdue) return false;
  if (f.due === "soon" && !h.soon) return false;
  if (f.due === "none" && t.end_date) return false;
  if (state.quickFilter === "active" && isDone(t)) return false;
  if (state.quickFilter === "risk" && !h.risk) return false;
  if (state.quickFilter === "overdue" && !h.overdue) return false;
  if (state.quickFilter === "soon" && !h.soon) return false;
  if (state.quickFilter === "stale" && !h.stale) return false;
  return true;
}
function compareTasks(a, b) {
  if (state.sort === "due_asc") {
    return (a.end_date || "9999-12-31").localeCompare(b.end_date || "9999-12-31") ||
      a.start_date.localeCompare(b.start_date) || a.id - b.id;
  }
  if (state.sort === "priority_desc") {
    return priorityRank(b.priority) - priorityRank(a.priority) ||
      (a.end_date || "9999-12-31").localeCompare(b.end_date || "9999-12-31") || a.id - b.id;
  }
  if (state.sort === "updated_desc") {
    return (b.updated_at || "").localeCompare(a.updated_at || "") || b.id - a.id;
  }
  return a.start_date.localeCompare(b.start_date) || a.id - b.id;
}
function filteredTasks() {
  return state.tasks.filter(taskMatchesFilters).sort(compareTasks);
}
function descendantIds(rootId) {
  const ids = [];
  const walk = (pid) => {
    for (const l of state.lines.filter((x) => x.parent_id === pid)) {
      ids.push(l.id);
      walk(l.id);
    }
  };
  walk(rootId);
  return ids;
}

/* ---------------------------------------------------------------- data */
async function reload() {
  const d = await api("/api/state");
  state.lines = d.lines;
  state.tasks = d.tasks;
  state.dependencies = d.dependencies || [];
  state.taskImages = d.task_images || [];
  state.canUndo = d.can_undo;
  state.statusEnum = d.status_enum;
  state.statusColors = d.status_colors || {};
  state.priorityEnum = d.priority_enum || ["低", "中", "高", "紧急"];
  state.owners = d.owners || [];
  state.today = d.today;
  for (const id of [...state.hiddenBranchIds]) {
    if (!state.lines.some((line) => line.id === id && line.parent_id !== null)) {
      state.hiddenBranchIds.delete(id);
    }
  }
  if (state.selectedLineId && !lineById(state.selectedLineId)) {
    state.selectedLineId = null;
  }
  for (const id of [...state.selectedTaskIds]) {
    if (!state.tasks.some((t) => t.id === id)) state.selectedTaskIds.delete(id);
  }
  if (state.selectedTaskId && !state.tasks.some((t) => t.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
  }
  renderFilterControls();
  render();
}

function render() {
  renderToolbar();
  renderSummary();
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "canvas") renderCanvas();
  else renderTable();
}

/* ---------------------------------------------------------------- toolbar */
function renderToolbar() {
  const archived = isWorkspaceArchived();
  const sel = state.selectedLineId ? lineById(state.selectedLineId) : null;
  const selectedTask = state.selectedTaskId ? taskById(state.selectedTaskId) : null;
  const children = sel ? state.lines.filter((line) => line.parent_id === sel.id) : [];
  const allChildrenHidden = children.length > 0 &&
    children.every((line) => state.hiddenBranchIds.has(line.id));
  $("#btn-add-mainline").disabled = archived;
  $("#btn-add-branch").disabled = archived || !sel;
  $("#btn-add-task").disabled = archived || !sel;
  $("#btn-merge").disabled = archived || !sel || sel.parent_id === null || sel.merge_date;
  $("#btn-toggle-children").disabled = !children.length;
  $("#btn-toggle-children").textContent =
    allChildrenHidden ? "展开子支线" : "折叠子支线";
  $("#sel-info").textContent = selectedTask
    ? `已选中事务：${selectedTask.name}`
    : (sel
      ? `已选中：${sel.name}${sel.parent_id === null ? "（主线）" : "（支线）"}`
      : "未选中任何对象");
}

function setSelectOptions(sel, values, allText, selected) {
  const old = selected == null ? sel.value : selected;
  sel.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = allText;
  sel.appendChild(first);
  for (const v of values) {
    const o = document.createElement("option");
    o.value = String(v.value ?? v);
    o.textContent = String(v.label ?? v);
    if (o.value === old) o.selected = true;
    sel.appendChild(o);
  }
}

function renderFilterControls() {
  setSelectOptions($("#filter-line"), state.lines.map((l) => ({ value: l.id, label: l.name })),
    "全部线", state.filters.line);
  setSelectOptions($("#filter-owner"), ownerOptions(), "全部责任人", state.filters.owner);
  setSelectOptions($("#filter-status"), state.statusEnum, "全部状态", state.filters.status);
  setSelectOptions($("#filter-priority"), state.priorityEnum, "全部优先级", state.filters.priority);
  setSelectOptions($("#bulk-status"), state.statusEnum, "批量改状态", "");
  setSelectOptions($("#bulk-owner"), ownerOptions(), "批量改责任人", "");
  setSelectOptions($("#bulk-priority"), state.priorityEnum, "批量改优先级", "");
  $("#filter-q").value = state.filters.q;
  $("#filter-due").value = state.filters.due;
  $("#sort-tasks").value = state.sort;
  decorateStatusSelect($("#filter-status"));
  decorateStatusSelect($("#bulk-status"));
}

function renderSummary() {
  let active = 0, risk = 0, overdue = 0, soon = 0, stale = 0;
  for (const t of state.tasks) {
    const h = taskHealth(t);
    if (!isDone(t)) active++;
    if (h.risk) risk++;
    if (h.overdue) overdue++;
    if (h.soon) soon++;
    if (h.stale) stale++;
  }
  $("#sum-active").textContent = active;
  $("#sum-risk").textContent = risk;
  $("#sum-overdue").textContent = overdue;
  $("#sum-soon").textContent = soon;
  $("#sum-stale").textContent = stale;
  for (const btn of document.querySelectorAll(".summary-card")) {
    btn.classList.toggle("active", btn.dataset.quick === state.quickFilter);
  }
}

/* ============================================================== 项目看板 */
function dashboardStatuses() {
  const statuses = [...state.statusEnum];
  for (const task of state.tasks) {
    if (task.status && !statuses.includes(task.status)) statuses.push(task.status);
  }
  return statuses;
}

function dashboardStatButton(label, value, tasks, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `dashboard-stat-button ${className}`.trim();
  button.setAttribute("aria-label", `${label}，${value} 个事务，查看详情`);

  const number = document.createElement("strong");
  number.textContent = value;
  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(number);
  button.appendChild(text);
  button.onclick = () => openTaskListModal(label, tasks);
  return button;
}

function renderDashboard() {
  const mainLines = state.lines.filter((line) => line.parent_id === null);
  const branchLines = state.lines.filter((line) => line.parent_id !== null);
  const statuses = dashboardStatuses();
  const owners = ownerOptions();

  $("#dashboard-workspace-name").textContent = state.currentWorkspace?.name || "当前项目空间";
  $("#dashboard-updated").textContent = state.today ? `数据截至 ${state.today}` : "";

  const overview = $("#dashboard-overview");
  overview.innerHTML = "";
  const overviewItems = [
    ["主线", mainLines.length, "项目一级推进路径"],
    ["支线", branchLines.length, "从主线或支线分出的路径"],
  ];
  for (const [label, value, description] of overviewItems) {
    const item = document.createElement("div");
    item.className = "dashboard-overview-item";
    const number = document.createElement("strong");
    number.textContent = value;
    const name = document.createElement("span");
    name.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = description;
    item.append(number, name, detail);
    overview.appendChild(item);
  }
  const taskOverview = document.createElement("div");
  taskOverview.className = "dashboard-overview-item dashboard-overview-action";
  taskOverview.appendChild(dashboardStatButton("全部事务", state.tasks.length, state.tasks));
  const taskDetail = document.createElement("small");
  taskDetail.textContent = "单击查看当前空间全部事务";
  taskOverview.appendChild(taskDetail);
  overview.appendChild(taskOverview);

  const ownerOverview = document.createElement("div");
  ownerOverview.className = "dashboard-overview-item";
  const ownerNumber = document.createElement("strong");
  ownerNumber.textContent = owners.length;
  const ownerLabel = document.createElement("span");
  ownerLabel.textContent = "责任人";
  const ownerDetail = document.createElement("small");
  ownerDetail.textContent = "当前项目空间成员";
  ownerOverview.append(ownerNumber, ownerLabel, ownerDetail);
  overview.appendChild(ownerOverview);

  $("#dashboard-status-total").textContent = `共 ${state.tasks.length} 个事务`;
  const statusList = $("#dashboard-statuses");
  statusList.innerHTML = "";
  for (const status of statuses) {
    const tasks = state.tasks.filter((task) => task.status === status);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dashboard-status-row";
    button.setAttribute("aria-label", `${status}，${tasks.length} 个事务，查看详情`);
    button.onclick = () => openTaskListModal(status, tasks);

    const label = document.createElement("span");
    label.className = "dashboard-status-label";
    const dot = document.createElement("i");
    dot.style.backgroundColor = statusColor(status);
    const name = document.createElement("span");
    name.textContent = status;
    label.append(dot, name);

    const track = document.createElement("span");
    track.className = "dashboard-status-track";
    const fill = document.createElement("span");
    fill.style.backgroundColor = statusColor(status);
    fill.style.width = `${state.tasks.length ? (tasks.length / state.tasks.length) * 100 : 0}%`;
    track.appendChild(fill);

    const count = document.createElement("strong");
    count.textContent = tasks.length;
    button.append(label, track, count);
    statusList.appendChild(button);
  }
  if (!statuses.length) {
    const empty = document.createElement("div");
    empty.className = "dashboard-empty";
    empty.textContent = "暂无状态配置";
    statusList.appendChild(empty);
  }

  const unownedTasks = state.tasks.filter((task) => !task.owner || !task.owner.trim());
  const riskTasks = state.tasks.filter((task) => taskHealth(task).risk);
  const overdueTasks = state.tasks.filter((task) => taskHealth(task).overdue);
  const alerts = $("#dashboard-alerts");
  alerts.innerHTML = "";
  alerts.append(
    dashboardStatButton("无主事务", unownedTasks.length, unownedTasks, "dashboard-alert-stat"),
    dashboardStatButton("风险事务", riskTasks.length, riskTasks, "dashboard-alert-stat"),
    dashboardStatButton("超期事务", overdueTasks.length, overdueTasks, "dashboard-alert-stat")
  );

  renderDashboardOwners(statuses, owners, unownedTasks);
}

function renderDashboardOwners(statuses, owners, unownedTasks) {
  const wrap = $("#dashboard-owners");
  wrap.innerHTML = "";
  const table = document.createElement("table");
  table.className = "dashboard-owner-table";
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const title of ["责任人", "合计", ...statuses]) {
    const th = document.createElement("th");
    th.textContent = title;
    header.appendChild(th);
  }
  thead.appendChild(header);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const ownerRows = owners.map((owner) => ({
    owner,
    tasks: state.tasks.filter((task) => task.owner === owner),
  }));
  if (unownedTasks.length) ownerRows.push({ owner: "无主", tasks: unownedTasks, alert: true });

  for (const row of ownerRows) {
    const tr = document.createElement("tr");
    if (row.alert) tr.className = "dashboard-owner-alert";
    const ownerCell = document.createElement("th");
    ownerCell.scope = "row";
    ownerCell.textContent = row.owner;
    tr.appendChild(ownerCell);

    const totalCell = document.createElement("td");
    totalCell.appendChild(dashboardTableCount(row.tasks.length, `${row.owner}的全部事务`, row.tasks));
    tr.appendChild(totalCell);
    for (const status of statuses) {
      const tasks = row.tasks.filter((task) => task.status === status);
      const cell = document.createElement("td");
      const count = dashboardTableCount(tasks.length, `${row.owner} · ${status}`, tasks);
      count.style.setProperty("--status-color", statusColor(status));
      count.classList.add("status-count");
      cell.appendChild(count);
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (!ownerRows.length) {
    const empty = document.createElement("div");
    empty.className = "dashboard-empty dashboard-owner-empty";
    empty.textContent = "暂无责任人和事务";
    wrap.appendChild(empty);
  }
}

function dashboardTableCount(value, title, tasks) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dashboard-table-count";
  button.textContent = value;
  button.title = `${title}：${value}`;
  button.setAttribute("aria-label", `${title}，${value} 个，查看详情`);
  button.onclick = () => openTaskListModal(title, tasks);
  return button;
}

function openTaskListModal(title, tasks) {
  const taskList = [...tasks].sort(compareTasks);
  openModal(`${title}（${taskList.length}）`, (body) => {
    $("#modal").classList.add("modal-wide", "task-list-modal");
    $("#modal-ok").classList.add("hidden");
    $("#modal-cancel").textContent = "关闭";

    if (!taskList.length) {
      const empty = document.createElement("div");
      empty.className = "dashboard-empty task-list-empty";
      empty.textContent = "暂无符合条件的事务";
      body.appendChild(empty);
      return;
    }

    const tableWrap = document.createElement("div");
    tableWrap.className = "dashboard-task-list-wrap";
    const table = document.createElement("table");
    table.className = "dashboard-task-list";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const titleText of ["事务", "所属线", "责任人", "状态", "结束日期", "提示"]) {
      const th = document.createElement("th");
      th.textContent = titleText;
      header.appendChild(th);
    }
    thead.appendChild(header);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const task of taskList) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `编辑事务 ${task.name}`);
      const openEditor = () => openTaskModal(task);
      row.onclick = openEditor;
      row.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openEditor();
        }
      };

      const health = taskHealth(task);
      const values = [
        task.name,
        lineById(task.line_id)?.name || "—",
        task.owner || "无主",
        task.status,
        task.end_date || "—",
        health.labels.map(([label]) => label).join("、") || "—",
      ];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === 0) cell.className = "dashboard-task-name";
        if (index === 3) {
          const statusText = document.createElement("span");
          statusText.className = "dashboard-task-status";
          statusText.style.color = statusColor(task.status);
          statusText.textContent = value;
          cell.appendChild(statusText);
        } else if (index === 5 && (health.overdue || health.risk)) {
          const alertText = document.createElement("span");
          alertText.className = "dashboard-task-alert";
          alertText.textContent = value;
          cell.appendChild(alertText);
        } else {
          cell.textContent = value;
        }
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    body.appendChild(tableWrap);
  }, async () => true);
}

/* ============================================================== 画布视图 */
const CV = {
  padL: 60, padR: 160, padT: 56, rowH: 74, pxPerDay: 6,
};

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

/* 计算每条线的泳道行号：主线在上，支线递归排在父线之后 */
function assignRows(includeHidden = false) {
  const roots = state.lines.filter((l) => l.parent_id === null);
  const children = (pid) =>
    state.lines.filter((l) => l.parent_id === pid)
      .sort((a, b) => a.fork_date.localeCompare(b.fork_date) || a.id - b.id);
  const rows = new Map();
  let row = 0;
  function walk(line) {
    rows.set(line.id, row++);
    for (const c of children(line.id)) {
      if (includeHidden || !state.hiddenBranchIds.has(c.id)) walk(c);
    }
  }
  roots.sort((a, b) => a.id - b.id).forEach(walk);
  return rows;
}

/* 线的有效时间范围（含其事务与子线） */
function lineEnd(line) {
  let end = line.merge_date || state.today;
  for (const t of state.tasks.filter((t) => t.line_id === line.id)) {
    if (t.end_date && t.end_date > end) end = t.end_date;
    if (t.start_date > end) end = t.start_date;
  }
  return end;
}

/*
 * 同线同天多事务 -> 折叠为一个聚合节点，点击展开/折叠。
 * 簇 key = `${line_id}|${start_date}`；展开状态记录在 state.expandedClusters。
 */
const FAN_STEP = 30;   // 展开时相邻节点的垂直间距

function clusterKey(t) { return `${t.line_id}|${t.start_date}`; }

/* 最不成熟的状态 = 枚举顺序里最靠前的（未启动 < 进行中 < 有风险 < 已闭环） */
function leastMatureStatus(tasks) {
  let best = null, bestIdx = Infinity;
  for (const t of tasks) {
    const i = state.statusEnum.indexOf(t.status);
    if (i < bestIdx) { bestIdx = i; best = t.status; }
  }
  return best || "未启动";
}

/* 按 线+同天 分簇。返回 Map<key, task[]>，簇内按 id 排序 */
function buildClusters(tasks = state.tasks) {
  const clusters = new Map();
  for (const t of tasks) {
    const k = clusterKey(t);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(t);
  }
  for (const arr of clusters.values()) arr.sort((a, b) => a.id - b.id);
  return clusters;
}

/* 簇内第 i 个节点的展开偏移: 0, -1, +1, -2, +2 ... 乘以步长 */
function fanDy(i) {
  return Math.ceil(i / 2) * (i % 2 === 1 ? -1 : 1) * FAN_STEP;
}

function renderCanvas() {
  const svg = $("#graph");
  const wrap = $("#canvas-wrap");
  const z = state.zoom;
  svg.innerHTML = "";
  state.canvasTaskPositions = new Map();
  const layoutRows = assignRows();
  const colorRows = assignRows(true);
  const taskScopedFilterActive = Boolean(
    state.filters.q.trim() || state.filters.owner || state.filters.status ||
    state.filters.priority || state.filters.due || state.quickFilter
  );
  const hasActiveCanvasFilter = Boolean(state.filters.line || taskScopedFilterActive);
  const taskRows = hasActiveCanvasFilter ? colorRows : layoutRows;
  const canvasTasks = filteredTasks().filter((task) => taskRows.has(task.line_id));
  const filterMatchedLineIds = new Set();
  const retainLineAndAncestors = (lineId) => {
    const visited = new Set();
    let line = lineById(lineId);
    while (line && !visited.has(line.id)) {
      filterMatchedLineIds.add(line.id);
      visited.add(line.id);
      line = line.parent_id !== null ? lineById(line.parent_id) : null;
    }
  };
  for (const task of canvasTasks) retainLineAndAncestors(task.line_id);
  if (state.filters.line && !taskScopedFilterActive) {
    retainLineAndAncestors(Number(state.filters.line));
  }
  const rows = hasActiveCanvasFilter
    ? new Map([...colorRows.keys()]
      .filter((id) => filterMatchedLineIds.has(id))
      .map((id, index) => [id, index]))
    : layoutRows;

  if (!state.lines.length) {
    svg.setAttribute("width", Math.max(800 * z, wrap.clientWidth));
    svg.setAttribute("height", Math.max(400 * z, wrap.clientHeight));
    const t = svgEl("text", { x: 60, y: 80, fill: "#8c959f", "font-size": 15 }, svg);
    t.textContent = "还没有任何线，点击左上角「+ 主线」开始。";
    return;
  }

  /* 时间范围 */
  let minD = state.today, maxD = state.today;
  const visibleLines = state.lines.filter((l) => rows.has(l.id));
  if (!visibleLines.length) {
    svg.setAttribute("width", Math.max(800 * z, wrap.clientWidth));
    svg.setAttribute("height", Math.max(400 * z, wrap.clientHeight));
    const t = svgEl("text", { x: 60, y: 80, fill: "#8c959f", "font-size": 15 }, svg);
    t.textContent = "没有符合当前筛选条件的线或事务。";
    return;
  }
  for (const l of visibleLines) {
    if (l.fork_date < minD) minD = l.fork_date;
    const e = lineEnd(l);
    if (e > maxD) maxD = e;
  }
  for (const t of canvasTasks) {
    if (t.start_date < minD) minD = t.start_date;
    const e = t.end_date || t.start_date;
    if (e > maxD) maxD = e;
  }
  /* 左右各留半个月余量 */
  const start = new Date(parseDate(minD)); start.setDate(start.getDate() - 15);
  const stop = new Date(parseDate(maxD)); stop.setDate(stop.getDate() + 20);

  const x = (dateStr) =>
    CV.padL + ((parseDate(dateStr) - start) / 86400000) * CV.pxPerDay;

  /* 同线同天分簇；清理已失效的展开记录 */
  const clusters = buildClusters(canvasTasks);
  for (const k of [...state.expandedClusters]) {
    if (!clusters.has(k) || clusters.get(k).length < 2) {
      state.expandedClusters.delete(k);
    }
  }

  /* 每条线的泳道高度按其已展开簇的最大扇出量自适应 */
  const lineMaxFan = new Map();
  for (const [k, arr] of clusters) {
    if (arr.length < 2 || !state.expandedClusters.has(k)) continue;
    const lid = arr[0].line_id;
    const fan = Math.abs(fanDy(arr.length - 1));
    lineMaxFan.set(lid, Math.max(lineMaxFan.get(lid) || 0, fan));
  }
  const rowIds = [...rows.entries()]
    .sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const rowCenter = new Map();
  let cursorY = CV.padT;
  for (const id of rowIds) {
    const fan = lineMaxFan.get(id) || 0;
    const h = CV.rowH + fan * 2;
    rowCenter.set(id, cursorY + h / 2);
    cursorY += h;
  }
  const lineY = (id) => rowCenter.get(id);

  const BRANCH_SLOPE = Math.tan(70 * Math.PI / 180);  // |dy / dx|，统一为 70°。
  const BRANCH_CORNER_R = 6;
  const lineGeometryCache = new Map();
  const mergeGeometryCache = new Map();

  /* 同日创建的嵌套支线从父支线可见斜线段的中点继续分叉。 */
  const branchStartPoint = (line, parent) => {
    if (parent.parent_id !== null && line.fork_date === parent.fork_date) {
      const parentGeometry = lineGeometry(parent);
      if (parentGeometry.diagonalEnd) {
        return {
          x: (parentGeometry.start.x + parentGeometry.diagonalEnd.x) / 2,
          y: (parentGeometry.start.y + parentGeometry.diagonalEnd.y) / 2,
        };
      }
    }
    return { x: x(line.fork_date), y: lineY(parent.id) };
  };

  function lineGeometry(line) {
    if (lineGeometryCache.has(line.id)) return lineGeometryCache.get(line.id);
    const y = lineY(line.id);
    const parentLine = line.parent_id !== null ? lineById(line.parent_id) : null;
    const parent = parentLine && rows.has(parentLine.id) ? parentLine : null;
    if (!parent) {
      const point = { x: x(line.fork_date), y };
      const geometry = {
        start: point, diagonalEnd: null, corner: null, horizontalStart: point,
      };
      lineGeometryCache.set(line.id, geometry);
      return geometry;
    }

    const start = branchStartPoint(line, parent);
    const verticalDistance = Math.abs(y - start.y);
    const corner = { x: start.x + verticalDistance / BRANCH_SLOPE, y };
    const dx = corner.x - start.x;
    const dy = corner.y - start.y;
    const diagonalLength = Math.hypot(dx, dy);
    const trim = Math.min(BRANCH_CORNER_R, diagonalLength / 3);
    const diagonalEnd = {
      x: corner.x - dx / diagonalLength * trim,
      y: corner.y - dy / diagonalLength * trim,
    };
    const horizontalStart = { x: corner.x + BRANCH_CORNER_R, y };
    const geometry = { start, diagonalEnd, corner, horizontalStart };
    lineGeometryCache.set(line.id, geometry);
    return geometry;
  }

  function mergeGeometry(line) {
    if (mergeGeometryCache.has(line.id)) return mergeGeometryCache.get(line.id);
    const parentLine = line.parent_id !== null ? lineById(line.parent_id) : null;
    const parent = parentLine && rows.has(parentLine.id) ? parentLine : null;
    if (!parent || !line.merge_date) {
      mergeGeometryCache.set(line.id, null);
      return null;
    }

    const y = lineY(line.id);
    const parentY = lineY(parent.id);
    const lineStartX = lineGeometry(line).horizontalStart.x;
    const horizontalEnd = {
      x: Math.max(x(lineEnd(line)), lineStartX + 6),
      y,
    };
    const corner = { x: horizontalEnd.x + BRANCH_CORNER_R, y };
    const verticalDistance = Math.abs(parentY - y);
    const horizontalDistance = verticalDistance / BRANCH_SLOPE;
    const end = { x: corner.x + horizontalDistance, y: parentY };
    const dx = end.x - corner.x;
    const dy = end.y - corner.y;
    const diagonalLength = Math.hypot(dx, dy);
    const trim = Math.min(BRANCH_CORNER_R, diagonalLength / 3);
    const diagonalStart = {
      x: corner.x + dx / diagonalLength * trim,
      y: corner.y + dy / diagonalLength * trim,
    };
    const geometry = { horizontalEnd, corner, diagonalStart, end };
    mergeGeometryCache.set(line.id, geometry);
    return geometry;
  }

  const geometryRight = Math.max(
    ...visibleLines.map((line) => {
      const merge = mergeGeometry(line);
      return merge ? merge.end.x : lineGeometry(line).horizontalStart.x;
    })
  );
  const contentWidth = Math.max(
    x(stop.toISOString().slice(0, 10)) + CV.padR,
    geometryRight + CV.padR,
    900
  );
  const contentHeight = cursorY + 60;
  const width = Math.max(contentWidth, wrap.clientWidth);
  const height = Math.max(contentHeight, wrap.clientHeight);
  svg.setAttribute("width", Math.max(Math.ceil(width * z), wrap.clientWidth));
  svg.setAttribute("height", Math.max(Math.ceil(height * z), wrap.clientHeight));

  /* 根容器：整体缩放 */
  const root = svgEl("g", {
    id: "canvas-root",
    transform: `translate(${state.pan.x} ${state.pan.y}) scale(${z})`,
  }, svg);
  const defs = svgEl("defs", {}, root);
  const dependencyArrow = svgEl("marker", {
    id: "dependency-preview-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4,
    markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse",
  }, defs);
  const previewArrowHead = svgEl("path", {
    d: "M 0 0 L 8 4 L 0 8 z", class: "dependency-arrow-head",
  }, dependencyArrow);
  previewArrowHead.style.fill = "#0969da";
  const dependencyMarkerIds = new Map();
  const dependencyMarkerFor = (task) => {
    if (dependencyMarkerIds.has(task.id)) return dependencyMarkerIds.get(task.id);
    const markerId = `dependency-arrow-${task.id}`;
    const marker = svgEl("marker", {
      id: markerId, viewBox: "0 0 8 8", refX: 7, refY: 4,
      markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse",
    }, defs);
    const arrowHead = svgEl("path", {
      d: "M 0 0 L 8 4 L 0 8 z", class: "dependency-arrow-head",
    }, marker);
    arrowHead.style.fill = statusColor(task.status);
    dependencyMarkerIds.set(task.id, markerId);
    return markerId;
  };

  /* ---- 年月时间轴（淡淡显示） ---- */
  const gGrid = svgEl("g", {}, root);
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= stop) {
    const ds = cur.toISOString().slice(0, 10);
    const gx = x(ds);
    const isYear = cur.getMonth() === 0;
    svgEl("line", {
      x1: gx, y1: 28, x2: gx, y2: height - 10,
      class: isYear ? "year-line" : "month-line",
    }, gGrid);
    if (isYear) {
      const yl = svgEl("text", { x: gx + 4, y: 20, class: "year-label" }, gGrid);
      yl.textContent = `${cur.getFullYear()}年`;
    }
    const ml = svgEl("text", { x: gx + 4, y: 40, class: "month-label" }, gGrid);
    ml.textContent = `${cur.getMonth() + 1}月`;
    cur.setMonth(cur.getMonth() + 1);
  }
  /* 今日虚线 */
  svgEl("line", {
    x1: x(state.today), y1: 28, x2: x(state.today), y2: height - 10,
    stroke: "#fb8f44", "stroke-width": 1, "stroke-dasharray": "4 4",
    opacity: .6, class: "today-line",
  }, gGrid);

  /* ---- 线 ---- */
  const gLines = svgEl("g", {}, root);
  const colorOf = (line) => lineDisplayColor(line, colorRows);

  for (const line of visibleLines) {
    const y = lineY(line.id);
    const color = colorOf(line);
    const x1 = x(line.fork_date);
    const geometry = lineGeometry(line);
    const endDate = lineEnd(line);
    const selected = line.id === state.selectedLineId;
    const parentLine = line.parent_id !== null ? lineById(line.parent_id) : null;
    const parent = parentLine && rows.has(parentLine.id) ? parentLine : null;
    const merge = mergeGeometry(line);
    const x2 = Math.max(
      merge ? merge.horizontalEnd.x : x(endDate),
      parent ? geometry.horizontalStart.x + 6 : x1 + 30
    );

    let d = "";
    if (parent) {
      /* 从父线斜向拉出，并用二次曲线平滑过渡到水平线。 */
      const { start, diagonalEnd, corner, horizontalStart } = geometry;
      d += `M ${start.x} ${start.y} L ${diagonalEnd.x} ${diagonalEnd.y} ` +
        `Q ${corner.x} ${corner.y}, ${horizontalStart.x} ${horizontalStart.y} `;
      d += `L ${x2} ${y}`;
    } else {
      d = `M ${x1} ${y} L ${x2} ${y}`;
    }
    /* 反合使用与分叉一致的圆角斜向折线。 */
    if (merge) {
      const { corner, diagonalStart, end } = merge;
      d += ` Q ${corner.x} ${corner.y}, ${diagonalStart.x} ${diagonalStart.y} ` +
        `L ${end.x} ${end.y}`;
    }

    const path = svgEl("path", {
      d, stroke: color,
      class: "line-path" + (selected ? " selected" : "") +
        (hasActiveCanvasFilter && filterMatchedLineIds.has(line.id) ? " filter-match" : ""),
    }, gLines);
    /* 加宽的透明命中区域 */
    const hit = svgEl("path", { d, class: "line-hit" }, gLines);
    const lineTip = svgEl("title", {}, hit);
    lineTip.textContent =
      `${line.name}\n${line.description || "暂无描述"}\n颜色：${color}`;
    const select = () => {
      state.selectedLineId = line.id;
      state.selectedTaskId = null;
      render();
    };
    hit.addEventListener("click", select);
    path.addEventListener("click", select);
    hit.addEventListener("dblclick", () => openLineModal(line));

    /* 反合点 */
    if (merge) {
      svgEl("circle", {
        cx: merge.end.x, cy: merge.end.y,
        r: 4.5, fill: color, class: "merge-dot",
      }, gLines);
    }

    /* 线名标签 */
    const hiddenChildCount = hasActiveCanvasFilter ? 0 : state.lines.filter(
      (child) => child.parent_id === line.id && state.hiddenBranchIds.has(child.id)
    ).length;
    const lineHeadX = parent ? geometry.horizontalStart.x : x1;
    const lbl = svgEl("text", {
      x: lineHeadX - 12,
      y: y + 4,
      "text-anchor": "end",
      fill: color, class: "line-label",
    }, gLines);
    lbl.textContent = line.name +
      (hiddenChildCount ? `（已折叠 ${hiddenChildCount}支线）` : "");
    lbl.addEventListener("click", select);
  }

  /* 分叉点始终保留在父线上，点击可折叠或展开对应支线。 */
  const gForks = svgEl("g", {}, root);
  for (const branch of state.lines.filter((line) => line.parent_id !== null)) {
    const parent = lineById(branch.parent_id);
    if (!parent || !rows.has(parent.id)) continue;
    if (hasActiveCanvasFilter && !rows.has(branch.id)) continue;
    const hidden = !hasActiveCanvasFilter && state.hiddenBranchIds.has(branch.id);
    const { x: cx, y: cy } = branchStartPoint(branch, parent);
    const color = colorOf(branch);
    const control = svgEl("g", {
      class: `fork-control${hidden ? " collapsed" : ""}`,
      "data-branch-id": branch.id,
    }, gForks);
    svgEl("circle", { cx, cy, r: 12, class: "fork-hit" }, control);
    svgEl("circle", {
      cx, cy, r: hidden ? 6 : 4.5, fill: color,
      class: `fork-dot${hidden ? " collapsed" : ""}`,
    }, control);
    if (hidden) {
      const symbol = svgEl("text", {
        x: cx, y: cy + 3.5, "text-anchor": "middle", class: "fork-symbol",
      }, control);
      symbol.textContent = "+";
    }
    const title = svgEl("title", {}, control);
    title.textContent = `${hidden ? "展开" : "折叠"}支线：${branch.name}`;
    control.addEventListener("click", (event) => {
      event.stopPropagation();
      if (hidden) {
        state.hiddenBranchIds.delete(branch.id);
      } else {
        state.hiddenBranchIds.add(branch.id);
        const hiddenIds = new Set([branch.id, ...descendantIds(branch.id)]);
        if (hiddenIds.has(state.selectedLineId)) state.selectedLineId = parent.id;
        const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId);
        if (selectedTask && hiddenIds.has(selectedTask.line_id)) state.selectedTaskId = null;
      }
      render();
    });
  }

  /* ---- 事务节点（同线同天多事务折叠为聚合节点，点击展开/折叠） ---- */
  const gDependencies = svgEl("g", { class: "task-dependencies" }, root);
  const gTasks = svgEl("g", {}, root);

  /* 事务日期为分叉当日时，钳制到对应支线圆角过渡后的水平段。 */
  const nodeX = (t) => {
    const ln = lineById(t.line_id);
    const lineStart = lineGeometry(ln).horizontalStart.x;
    return Math.max(x(t.start_date), lineStart);
  };

  const trianglePoints = (cx, cy, size) => {
    const halfWidth = Math.sqrt(3) * size / 2;
    return `${cx},${cy - size} ${cx + halfWidth},${cy + size / 2} ` +
      `${cx - halfWidth},${cy + size / 2}`;
  };

  const canvasPointFromClient = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.pan.x) / state.zoom,
      y: (clientY - rect.top - state.pan.y) / state.zoom,
    };
  };

  const startDependencyDrag = (event, sourceTask) => {
    if (isWorkspaceArchived()) return;
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const start = state.canvasTaskPositions.get(sourceTask.id);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    let moved = false;
    const preview = svgEl("line", {
      x1: start.x, y1: start.y, x2: start.x, y2: start.y,
      class: "dependency-line dependency-preview",
      "marker-end": "url(#dependency-preview-arrow)",
    }, gDependencies);
    for (const candidate of svg.querySelectorAll(".task-node[data-task-id]")) {
      if (Number(candidate.dataset.taskId) !== sourceTask.id) {
        candidate.classList.add("dependency-target");
      }
    }

    const cleanup = () => {
      preview.remove();
      for (const candidate of svg.querySelectorAll(".dependency-target")) {
        candidate.classList.remove("dependency-target");
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const point = canvasPointFromClient(moveEvent.clientX, moveEvent.clientY);
      preview.setAttribute("x2", point.x);
      preview.setAttribute("y2", point.y);
      moved = moved || Math.hypot(point.x - start.x, point.y - start.y) > 5;
    };
    const finish = async (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      const targetElement = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
        ?.closest?.(".task-node[data-task-id]");
      const targetTaskId = targetElement ? Number(targetElement.dataset.taskId) : null;
      cleanup();
      if (!moved) return;
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 0);
      if (!targetTaskId || targetTaskId === sourceTask.id) return;
      try {
        const result = await api(`/api/tasks/${sourceTask.id}/dependencies`, "POST", {
          prerequisite_task_id: targetTaskId,
        });
        toast(result.created === false ? "依赖关系已存在" : "已建立事务依赖");
        await reload();
      } catch (_error) {
        // api() 已显示自依赖、循环依赖或跨空间等具体错误。
      }
    };
    const cancel = (cancelEvent) => {
      if (cancelEvent.pointerId === event.pointerId) cleanup();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  /* 单个事务节点 + 标签 */
  const drawTask = (t, y, labelRight) => {
    const line = lineById(t.line_id);
    const cx = nodeX(t);

    if (t.end_date && t.end_date > t.start_date) {
      const bar = svgEl("rect", {
        x: cx, y: y - 4, width: Math.max(x(t.end_date) - cx, 2), height: 8,
        rx: 4, class: `task-bar ${statusClass(t.status)}`,
      }, gTasks);
      bar.style.fill = statusColor(t.status);
    }

    const health = taskHealth(t);
    const selectedTask = state.selectedTaskId === t.id;
    const node = svgEl("polygon", {
      points: trianglePoints(cx, y, selectedTask ? 12 : 9),
      "data-task-id": t.id,
      class: `task-node ${statusClass(t.status)} ${health.className}` +
        (hasActiveCanvasFilter ? " filter-match" : ""),
    }, gTasks);
    node.style.fill = statusColor(t.status);
    state.canvasTaskPositions.set(t.id, { x: cx, y });
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedLineId = line.id;
      state.selectedTaskId = t.id;
      render();
    });
    node.addEventListener("pointerdown", (e) => {
      if (state.selectedTaskId === t.id) startDependencyDrag(e, t);
    });
    node.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openTaskModal(t);
    });
    const title = svgEl("title", {}, node);
    title.textContent =
      `${t.name}\n状态：${t.status}\n责任人：${t.owner || "—"}\n` +
      `${t.start_date} ~ ${t.end_date || "…"}\n内容：${t.content || "—"}\n` +
      `闭环目标：${t.goal || "—"}\n下一步：${t.next_action || "—"}\n风险原因：${t.risk_reason || "—"}`;

    const parts1 = [], parts2 = [];
    if (state.show.name) parts1.push(t.name);
    if (state.show.status) parts2.push(t.status);
    if (state.show.dur) parts2.push(fmtDays(daysBetween(t.status_since, state.today)));
    if (state.show.owner && t.owner) parts2.push("@" + t.owner);

    if (labelRight) {
      /* 展开的簇成员：标签横排在节点右侧 */
      const text = [...parts1, ...parts2].join(" · ");
      if (text) {
        const e = svgEl("text", {
          x: cx + 12, y: y + 4, "text-anchor": "start",
          class: "task-label " + (parts1.length ? "t-name" : "t-meta"),
        }, gTasks);
        e.textContent = text;
      }
    } else {
      const above = (state.tasks.filter((o) => o.line_id === t.line_id)
        .indexOf(t) % 2) === 0;
      let ty = above ? y - 26 : y + 22;
      if (parts1.length) {
        const e = svgEl("text", {
          x: cx, y: ty, "text-anchor": "middle", class: "task-label t-name",
        }, gTasks);
        e.textContent = parts1.join(" ");
        ty += 13;
      }
      if (parts2.length) {
        const e = svgEl("text", {
          x: cx, y: parts1.length ? ty : (above ? y - 13 : y + 22),
          "text-anchor": "middle", class: "task-label t-meta",
        }, gTasks);
        e.textContent = parts2.join(" · ");
      }
    }
  };

  for (const [key, arr] of clusters) {
    const line = lineById(arr[0].line_id);
    if (!line || !rows.has(line.id)) continue;
    const baseY = lineY(line.id);
    const cx = nodeX(arr[0]);
    const color = colorOf(line);

    /* 单事务：直接画 */
    if (arr.length === 1) {
      drawTask(arr[0], baseY, false);
      continue;
    }

    const expanded = state.expandedClusters.has(key);
    const toggle = (e) => {
      e.stopPropagation();
      if (expanded) state.expandedClusters.delete(key);
      else state.expandedClusters.add(key);
      renderCanvas();
    };

    if (!expanded) {
      /* ---- 折叠态：一个聚合节点，颜色 = 最不成熟的状态 ---- */
      const st = leastMatureStatus(arr);
      const hs = arr.map(taskHealth);
      const clusterHealth = hs.some((h) => h.overdue) ? "health-overdue" :
        (hs.some((h) => h.soon) ? "health-soon" :
          (hs.some((h) => h.stale) ? "health-stale" : ""));
      const g = svgEl("g", { class: "cluster-node" }, gTasks);
      for (const task of arr) {
        state.canvasTaskPositions.set(task.id, { x: cx, y: baseY });
      }
      /* 底层错位三角形暗示"这是一叠节点" */
      const backNode = svgEl("polygon", {
        points: trianglePoints(cx + 3, baseY + 3, 13),
        class: `task-node ${statusClass(st)} ${clusterHealth}` +
          (hasActiveCanvasFilter ? " filter-match" : ""),
        opacity: .35,
      }, g);
      const node = svgEl("polygon", {
        points: trianglePoints(cx, baseY, 13),
        class: `task-node ${statusClass(st)} ${clusterHealth}` +
          (hasActiveCanvasFilter ? " filter-match" : ""),
      }, g);
      backNode.style.fill = statusColor(st);
      node.style.fill = statusColor(st);
      /* 数量徽标 */
      const badge = svgEl("text", {
        x: cx, y: baseY + 3.5, "text-anchor": "middle", class: "cluster-count",
      }, g);
      badge.textContent = arr.length;
      /* 展开提示徽标 */
      const hint = svgEl("text", {
        x: cx + 13, y: baseY - 9, class: "cluster-hint",
      }, g);
      hint.textContent = "▸ 展开";

      const title = svgEl("title", {}, node);
      title.textContent =
        `${arr[0].start_date} 同天 ${arr.length} 个事务（单击展开）\n` +
        arr.map((t) => `· ${t.name}【${t.status}】${t.owner ? " @" + t.owner : ""}`).join("\n");

      g.addEventListener("click", toggle);

      /* 折叠态标签：显示"N项"及最不成熟状态 */
      const parts = [];
      if (state.show.name) parts.push(`${arr.length}项事务`);
      if (state.show.status) parts.push(st);
      if (parts.length) {
        const e = svgEl("text", {
          x: cx, y: baseY - 18, "text-anchor": "middle", class: "task-label t-name",
        }, gTasks);
        e.textContent = parts.join(" · ");
      }
    } else {
      /* ---- 展开态：垂直扇出所有节点 + 折叠按钮 ---- */
      const ys = arr.map((_, i) => baseY + fanDy(i));
      /* 竖向主干连接所有扇出节点 */
      svgEl("line", {
        x1: cx, y1: Math.min(...ys), x2: cx, y2: Math.max(...ys),
        stroke: color, "stroke-width": 1.2, "stroke-dasharray": "2 2", opacity: .55,
      }, gTasks);
      arr.forEach((t, i) => drawTask(t, ys[i], true));

      /* 折叠按钮：置于簇顶部 */
      const topY = Math.min(...ys) - 16;
      const g = svgEl("g", { class: "cluster-node" }, gTasks);
      const tx = svgEl("text", {
        x: cx, y: topY + 3.5, "text-anchor": "middle", class: "cluster-hint",
      }, g);
      tx.textContent = "▾ 折叠";
      const title = svgEl("title", {}, g);
      title.textContent = "折叠同天事务";
      g.addEventListener("click", toggle);
    }
  }

  const dependencySegment = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return null;
    const ux = dx / distance;
    const uy = dy / distance;
    return {
      x1: from.x + ux * 10, y1: from.y + uy * 10,
      x2: to.x - ux * 10, y2: to.y - uy * 10,
    };
  };
  for (const dependency of state.dependencies) {
    const from = state.canvasTaskPositions.get(dependency.dependent_task_id);
    const to = state.canvasTaskPositions.get(dependency.prerequisite_task_id);
    if (!from || !to) continue;
    const segment = dependencySegment(from, to);
    if (!segment) continue;
    const dependent = taskById(dependency.dependent_task_id);
    const prerequisite = taskById(dependency.prerequisite_task_id);
    const path = svgEl("line", {
      ...segment, class: "dependency-line",
      "marker-end": `url(#${dependencyMarkerFor(prerequisite)})`,
    }, gDependencies);
    path.style.stroke = statusColor(prerequisite.status);
    const title = svgEl("title", {}, path);
    title.textContent = `${dependent?.name || "事务"} 依赖 ${prerequisite?.name || "事务"}`;
  }

  /* 点击空白取消选中 */
  svg.onclick = (e) => {
    if (e.target === svg) {
      state.selectedLineId = null;
      state.selectedTaskId = null;
      render();
    }
  };
}

/* ============================================================== 表格视图 */
function renderTable() {
  const archived = isWorkspaceArchived();
  const tbody = $("#task-tbody");
  tbody.innerHTML = "";
  const sorted = filteredTasks();
  const visibleIds = new Set(sorted.map((t) => t.id));
  for (const id of [...state.selectedTaskIds]) {
    if (!visibleIds.has(id)) state.selectedTaskIds.delete(id);
  }
  const checkAll = $("#check-all-tasks");
  checkAll.checked = sorted.length > 0 && sorted.every((t) => state.selectedTaskIds.has(t.id));
  checkAll.indeterminate = sorted.some((t) => state.selectedTaskIds.has(t.id)) && !checkAll.checked;
  const exportAll = $("#btn-export-all");
  const exportSelected = $("#btn-export-selected");
  exportAll.disabled = state.tasks.length === 0;
  exportSelected.disabled = state.selectedTaskIds.size === 0;
  exportSelected.textContent = state.selectedTaskIds.size ?
    `导出选中 (${state.selectedTaskIds.size})` : "导出选中";
  $("#btn-table-add").disabled = archived;
  $("#btn-import-tasks").disabled = archived;
  $("#bulk-status").disabled = archived;
  $("#bulk-owner").disabled = archived;
  $("#bulk-priority").disabled = archived;
  $("#btn-bulk-delete").disabled = archived;
  $("#table-edit-hint").textContent = archived ?
    "已归档项目仅可浏览和导出" : "单元格可直接编辑，修改后自动保存";
  checkAll.onchange = () => {
    if (checkAll.checked) sorted.forEach((t) => state.selectedTaskIds.add(t.id));
    else sorted.forEach((t) => state.selectedTaskIds.delete(t.id));
    renderTable();
  };

  for (const t of sorted) {
    const tr = document.createElement("tr");
    if (state.selectedTaskId === t.id) tr.classList.add("selected-row");

    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "task-check";
    cb.checked = state.selectedTaskIds.has(t.id);
    cb.onchange = () => {
      if (cb.checked) state.selectedTaskIds.add(t.id);
      else state.selectedTaskIds.delete(t.id);
      renderTable();
    };
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdHealth = document.createElement("td");
    const badges = document.createElement("div");
    badges.className = "health-badges";
    const health = taskHealth(t);
    for (const [text, cls] of health.labels) {
      const b = document.createElement("span");
      b.className = `badge ${cls}`;
      b.textContent = text;
      badges.appendChild(b);
    }
    tdHealth.appendChild(badges);
    tr.appendChild(tdHealth);

    /* 线名（下拉切换所属线） */
    const tdLine = document.createElement("td");
    const selLine = document.createElement("select");
    for (const l of state.lines) {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.name;
      if (l.id === t.line_id) o.selected = true;
      selLine.appendChild(o);
    }
    selLine.disabled = archived;
    selLine.onchange = () => saveTask(t.id, { line_id: +selLine.value });
    tdLine.appendChild(selLine);
    tr.appendChild(tdLine);

    /* 文本字段 */
    const textField = (key, val) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.value = val || "";
      inp.disabled = archived;
      inp.onchange = () => saveTask(t.id, { [key]: inp.value });
      td.appendChild(inp);
      return td;
    };
    tr.appendChild(textField("name", t.name));
    tr.appendChild(textField("content", t.content));
    tr.appendChild(textField("goal", t.goal));
    tr.appendChild(textField("next_action", t.next_action));
    tr.appendChild(textField("risk_reason", t.risk_reason));

    /* 优先级 */
    const tdPriority = document.createElement("td");
    const selPriority = document.createElement("select");
    for (const p of state.priorityEnum) {
      const o = document.createElement("option");
      o.value = p; o.textContent = p;
      if ((t.priority || "中") === p) o.selected = true;
      selPriority.appendChild(o);
    }
    selPriority.className = `priority-${t.priority || "中"}`;
    selPriority.disabled = archived;
    selPriority.onchange = () => saveTask(t.id, { priority: selPriority.value });
    tdPriority.appendChild(selPriority);
    tr.appendChild(tdPriority);

    /* 责任人：配置了名单则下拉选择，否则文本输入 */
    const tdOwner = document.createElement("td");
    const ownerEl = ownerInput(t.owner, true);
    ownerEl.disabled = archived;
    ownerEl.onchange = () => saveTask(t.id, { owner: ownerEl.value });
    tdOwner.appendChild(ownerEl);
    tr.appendChild(tdOwner);

    /* 进展状态：下拉枚举 */
    const tdSt = document.createElement("td");
    const selSt = document.createElement("select");
    for (const s of state.statusEnum) {
      const o = document.createElement("option");
      o.value = s; o.textContent = s;
      if (s === t.status) o.selected = true;
      selSt.appendChild(o);
    }
    selSt.onchange = () => saveTask(t.id, { status: selSt.value });
    selSt.disabled = archived;
    decorateStatusSelect(selSt);
    tdSt.appendChild(selSt);
    tr.appendChild(tdSt);

    const tdDependencies = document.createElement("td");
    const dependencyIds = prerequisiteIds(t.id);
    const dependencyButton = document.createElement("button");
    dependencyButton.type = "button";
    dependencyButton.className = "dependency-config-button";
    dependencyButton.textContent = dependencyIds.length ? `${dependencyIds.length} 项` : "+";
    dependencyButton.title = dependencyIds.length
      ? dependencyIds.map((id) => taskById(id)?.name).filter(Boolean).join("、")
      : "配置依赖事务";
    dependencyButton.disabled = archived;
    dependencyButton.onclick = () => openTaskDependenciesModal(t);
    tdDependencies.appendChild(dependencyButton);
    tr.appendChild(tdDependencies);

    /* 日期 */
    const dateField = (key, val) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "date";
      inp.value = val || "";
      inp.disabled = archived;
      inp.onchange = () => saveTask(t.id, { [key]: inp.value || null });
      td.appendChild(inp);
      return td;
    };
    tr.appendChild(dateField("start_date", t.start_date));
    tr.appendChild(dateField("end_date", t.end_date));

    const tdUpdated = document.createElement("td");
    const updatedText = document.createElement("span");
    updatedText.className = "muted-text";
    updatedText.textContent = t.updated_at || "—";
    tdUpdated.appendChild(updatedText);
    tr.appendChild(tdUpdated);

    /* 删除 */
    const tdDel = document.createElement("td");
    const locate = document.createElement("button");
    locate.className = "row-action";
    locate.textContent = "定位";
    locate.onclick = () => locateTask(t.id);
    const btn = document.createElement("button");
    btn.className = "row-del";
    btn.textContent = "删除";
    btn.disabled = archived;
    btn.onclick = async () => {
      await api(`/api/tasks/${t.id}`, "DELETE");
      toast("已删除事务，可从回收站恢复");
      reload();
    };
    tdDel.appendChild(locate);
    if (!archived) tdDel.appendChild(btn);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  }
  if (!sorted.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 16;
    const emptyText = document.createElement("span");
    emptyText.className = "muted-text";
    emptyText.textContent = state.tasks.length ? "没有匹配筛选条件的事务。" :
      (archived ? "该归档项目暂无事务。" : "暂无事务，点击「+ 新增事务」添加。");
    td.appendChild(emptyText);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function saveTask(id, patch) {
  if (!ensureWorkspaceEditable()) return;
  try {
    await api(`/api/tasks/${id}`, "PATCH", patch);
  } catch (_error) {
    // 表格控件已先显示新值，失败后重新加载以恢复服务端数据。
  } finally {
    await reload();
  }
}

function locateTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  state.selectedTaskId = id;
  state.selectedLineId = t.line_id;
  const sameDay = state.tasks.filter((x) => x.line_id === t.line_id && x.start_date === t.start_date);
  if (sameDay.length > 1) state.expandedClusters.add(clusterKey(t));
  switchView("canvas");
  setTimeout(() => scrollToCanvasTask(id), 0);
}

function scrollToCanvasTask(id) {
  const pos = state.canvasTaskPositions.get(id);
  if (!pos) return;
  centerCanvasPoint(pos.x, pos.y);
}

function centerCanvasPoint(x, y = null) {
  const wrap = $("#canvas-wrap");
  state.pan.x = wrap.scrollLeft + wrap.clientWidth / 2 - x * state.zoom;
  if (y !== null) {
    state.pan.y = wrap.scrollTop + wrap.clientHeight / 2 - y * state.zoom;
  }
  applyPanTransform();
}

/* ============================================================== 弹窗 */
function openModal(title, bodyBuilder, onOk) {
  $("#modal-title").textContent = title;
  $("#modal").classList.remove("modal-wide", "task-list-modal");
  $("#modal-ok").textContent = "确定";
  $("#modal-ok").classList.remove("hidden", "danger");
  $("#modal-cancel").textContent = "取消";
  const body = $("#modal-body");
  body.innerHTML = "";
  $("#modal-header-tools").innerHTML = "";
  $("#modal-tools").innerHTML = "";
  bodyBuilder(body);
  $("#modal-mask").classList.remove("hidden");
  const close = () => $("#modal-mask").classList.add("hidden");
  $("#modal-cancel").onclick = close;
  $("#modal-ok").onclick = async () => {
    const ok = $("#modal-ok");
    if (ok.disabled) return;
    ok.disabled = true;
    try {
      if (await onOk() !== false) close();
    } catch (_error) {
      // api() 已显示具体错误，保留弹窗方便修改后重试。
    } finally {
      ok.disabled = false;
    }
  };
}

$("#modal-mask").onclick = (event) => {
  if (event.button === 0 && event.target === event.currentTarget) {
    event.currentTarget.classList.add("hidden");
  }
};

function field(parent, labelText, el, required = false) {
  const div = document.createElement("div");
  div.className = "field";
  const lb = document.createElement("label");
  if (required) {
    const mark = document.createElement("span");
    mark.className = "required-mark";
    mark.textContent = "*";
    mark.setAttribute("aria-hidden", "true");
    lb.appendChild(mark);
    const requiredControl = el.matches("input, select, textarea") ?
      el : el.querySelector("input, select, textarea");
    if (requiredControl) {
      requiredControl.required = true;
      requiredControl.setAttribute("aria-required", "true");
    }
  }
  lb.appendChild(document.createTextNode(labelText));
  div.appendChild(lb);
  div.appendChild(el);
  parent.appendChild(div);
  return el;
}
function input(type = "text", value = "") {
  const i = document.createElement("input");
  i.type = type; i.value = value;
  return i;
}

/* 责任人输入控件：选项直接来自当前项目空间成员。 */
function ownerInput(value = "", required = false) {
  const sel = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = required ? "请选择责任人" : "（不指定）";
  empty.disabled = required;
  sel.appendChild(empty);
  for (const n of ownerOptions()) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    if (n === value) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

/* 新建/编辑线 */
function openLineModal(line, parentId = null) {
  if (!ensureWorkspaceEditable()) return;
  const isNew = !line;
  openModal(
    isNew ? (parentId ? "新建支线" : "新建主线") : "编辑线",
    (body) => {
      body._name = field(body, "线名", input("text", line ? line.name : ""));
      const description = document.createElement("textarea");
      description.rows = 3;
      description.value = line ? (line.description || "") : "";
      body._description = field(body, "描述", description);
      const color = input("color", lineDisplayColor(line));
      color.className = "line-color-input";
      body._color = field($("#modal-tools"), "颜色", color);
      body._date = field(body, isNew ? "起始日期（支线即分叉日）" : "起始日期",
        input("date", line ? line.fork_date : state.today));
      if (parentId) {
        const hint = document.createElement("div");
        hint.className = "opt-hint";
        hint.textContent = `父线：${lineById(parentId).name}`;
        body.appendChild(hint);
      }
      body._name.focus();
    },
    async () => {
      const body = $("#modal-body");
      const name = body._name.value.trim();
      const description = body._description.value.trim();
      const color = body._color.value;
      if (!name) { toast("线名不能为空"); return false; }
      if (isNew) {
        const r = await api("/api/lines", "POST", {
          name, description, color, parent_id: parentId,
          fork_date: body._date.value || state.today,
        });
        state.selectedLineId = r.id;
      } else {
        await api(`/api/lines/${line.id}`, "PATCH", {
          name, description, color, fork_date: body._date.value,
        });
      }
      reload();
    }
  );
}

function lineOptionLabel(line) {
  const names = [line.name];
  let parent = line.parent_id !== null ? lineById(line.parent_id) : null;
  const visited = new Set([line.id]);
  while (parent && !visited.has(parent.id)) {
    names.unshift(parent.name);
    visited.add(parent.id);
    parent = parent.parent_id !== null ? lineById(parent.parent_id) : null;
  }
  return `${line.parent_id === null ? "主线" : "支线"} · ${names.join(" / ")}`;
}

function createDependencyPicker(body, task, selectedIds = [], parent = body) {
  const selected = new Set(selectedIds);
  const candidates = state.tasks
    .filter((candidate) => !task || candidate.id !== task.id)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
  const wrapper = document.createElement("div");
  wrapper.className = "dependency-picker-wrap";
  const toolbar = document.createElement("div");
  toolbar.className = "dependency-picker-toolbar";
  const search = input("search");
  search.className = "dependency-search-input";
  search.placeholder = "搜索事务名、内容、责任人或所属线";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "搜索依赖事务");
  const count = document.createElement("span");
  count.className = "dependency-selected-count";
  toolbar.appendChild(search);
  toolbar.appendChild(count);
  wrapper.appendChild(toolbar);
  const picker = document.createElement("div");
  picker.className = "dependency-picker";
  body._dependencyChecks = [];
  const empty = document.createElement("div");
  empty.className = "dependency-empty";
  empty.textContent = candidates.length ? "未找到匹配事务" : "暂无其他事务";
  empty.hidden = Boolean(candidates.length);
  picker.appendChild(empty);
  for (const candidate of candidates) {
    const option = document.createElement("label");
    option.className = "dependency-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(candidate.id);
    const text = document.createElement("span");
    const line = lineById(candidate.line_id);
    text.textContent = `${candidate.name} · ${line ? line.name : "未知线"}`;
    const status = document.createElement("span");
    status.className = "dependency-status";
    status.textContent = candidate.status;
    status.style.color = statusColor(candidate.status);
    option.appendChild(checkbox);
    option.appendChild(text);
    option.appendChild(status);
    picker.appendChild(option);
    body._dependencyChecks.push({
      checkbox,
      option,
      taskId: candidate.id,
      searchText: [candidate.name, candidate.content, candidate.owner,
        candidate.goal, candidate.next_action, candidate.status, line?.name]
        .filter(Boolean).join(" ").toLocaleLowerCase(),
    });
  }
  wrapper.appendChild(picker);
  const refresh = () => {
    const keyword = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const item of body._dependencyChecks) {
      const matches = !keyword || item.searchText.includes(keyword);
      item.option.hidden = !matches;
      if (matches) visible += 1;
    }
    empty.hidden = visible > 0;
    empty.textContent = candidates.length ? "未找到匹配事务" : "暂无其他事务";
    const selectedCount = body._dependencyChecks
      .filter(({ checkbox: item }) => item.checked).length;
    count.textContent = `已选 ${selectedCount} 项`;
  };
  search.oninput = refresh;
  for (const { checkbox } of body._dependencyChecks) checkbox.onchange = refresh;
  refresh();
  field(parent, "依赖事务（可多选）", wrapper);
}

function selectedDependencyIds(body) {
  return (body._dependencyChecks || [])
    .filter(({ checkbox }) => checkbox.checked)
    .map(({ taskId }) => taskId);
}

function openTaskDependenciesModal(task) {
  if (!ensureWorkspaceEditable()) return;
  openModal(`配置依赖（${task.name}）`, (body) => {
    createDependencyPicker(body, task, prerequisiteIds(task.id));
  }, async () => {
    const body = $("#modal-body");
    await api(`/api/tasks/${task.id}`, "PATCH", {
      prerequisite_ids: selectedDependencyIds(body),
    });
    await reload();
  });
}

function createTaskContentEditor(body, task) {
  const editor = document.createElement("div");
  editor.className = "task-content-editor";
  const textarea = document.createElement("textarea");
  textarea.value = task ? task.content : "";
  textarea.placeholder = "填写事务内容；可在此直接粘贴图片";
  const hint = document.createElement("div");
  hint.className = "task-content-hint";
  hint.textContent = `支持粘贴 PNG、JPEG、GIF、WebP 图片，单张不超过 5MB，最多 ${MAX_TASK_IMAGES} 张；单击图片可放大浏览`;
  const gallery = document.createElement("div");
  gallery.className = "task-image-gallery";
  gallery.setAttribute("aria-live", "polite");
  body._content = textarea;
  body._contentImages = task ? state.taskImages
    .filter((image) => image.task_id === task.id)
    .map((image) => ({ id: image.id, src: `/api/task-images/${image.id}` })) : [];
  body._imageReadPromises = [];
  body._pendingImageCount = 0;

  const renderImages = () => {
    gallery.innerHTML = "";
    gallery.hidden = body._contentImages.length === 0;
    body._contentImages.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "task-image-item";
      const preview = document.createElement("img");
      preview.src = image.src || image.data_url;
      preview.alt = `事务内容图片 ${index + 1}`;
      const previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "task-image-preview";
      previewButton.title = "放大浏览";
      previewButton.setAttribute("aria-label", `放大浏览事务内容图片 ${index + 1}`);
      previewButton.onclick = () => openTaskImageViewer(body._contentImages, index, previewButton);
      previewButton.appendChild(preview);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "task-image-remove";
      remove.textContent = "×";
      remove.title = "移除图片";
      remove.setAttribute("aria-label", `移除事务内容图片 ${index + 1}`);
      remove.onclick = () => {
        body._contentImages.splice(index, 1);
        renderImages();
      };
      item.appendChild(previewButton);
      item.appendChild(remove);
      gallery.appendChild(item);
    });
  };

  const addImage = (file) => {
    if (!TASK_IMAGE_TYPES.has(file.type)) {
      toast("仅支持 PNG、JPEG、GIF 或 WebP 图片");
      return;
    }
    if (file.size > MAX_TASK_IMAGE_BYTES) {
      toast("单张事务图片不能超过 5MB");
      return;
    }
    if (body._contentImages.length + body._pendingImageCount >= MAX_TASK_IMAGES) {
      toast(`每个事务最多可添加 ${MAX_TASK_IMAGES} 张图片`);
      return;
    }
    body._pendingImageCount += 1;
    const pending = new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        body._pendingImageCount -= 1;
        body._contentImages.push({ data_url: reader.result });
        renderImages();
        resolve();
      };
      reader.onerror = () => {
        body._pendingImageCount -= 1;
        toast("图片读取失败，请重试");
        resolve();
      };
      reader.readAsDataURL(file);
    });
    body._imageReadPromises.push(pending);
  };

  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      textarea.setRangeText(
        pastedText, textarea.selectionStart, textarea.selectionEnd, "end"
      );
    }
    const capacity = Math.max(
      0, MAX_TASK_IMAGES - body._contentImages.length - body._pendingImageCount
    );
    files.slice(0, capacity).forEach(addImage);
    if (files.length > capacity) {
      toast(`每个事务最多可添加 ${MAX_TASK_IMAGES} 张图片`);
    }
  });

  editor.appendChild(textarea);
  editor.appendChild(hint);
  editor.appendChild(gallery);
  renderImages();
  return editor;
}

/* 新建/编辑事务 */
function openTaskModal(task, lineId = null, allowLineSelection = false) {
  if (!ensureWorkspaceEditable()) return;
  const isNew = !task;
  openModal(
    isNew && allowLineSelection ? "新建事务" :
      (isNew ? `新建事务（${lineById(lineId).name}）` : "编辑事务"),
    (body) => {
      if (isNew && allowLineSelection) {
        const rows = assignRows(true);
        const lines = [...state.lines].sort(
          (a, b) => (rows.get(a.id) ?? 0) - (rows.get(b.id) ?? 0)
        );
        const baseLabels = lines.map(lineOptionLabel);
        const labelCounts = new Map();
        for (const label of baseLabels) {
          labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        }
        const lineChoices = new Map();
        const picker = input("search");
        picker.className = "line-search-input";
        picker.placeholder = "输入名称或路径搜索";
        picker.autocomplete = "off";
        picker.setAttribute("list", "task-line-options");
        picker.setAttribute("role", "combobox");
        picker.setAttribute("aria-autocomplete", "list");
        const optionList = document.createElement("datalist");
        optionList.id = "task-line-options";
        for (const candidate of lines) {
          const option = document.createElement("option");
          const baseLabel = lineOptionLabel(candidate);
          const label = labelCounts.get(baseLabel) > 1 ?
            `${baseLabel}（ID ${candidate.id}）` : baseLabel;
          option.value = label;
          lineChoices.set(label, candidate.id);
          optionList.appendChild(option);
          if (candidate.id === lineId) picker.value = label;
        }
        const pickerWrap = document.createElement("div");
        pickerWrap.className = "line-search-picker";
        pickerWrap.appendChild(picker);
        pickerWrap.appendChild(optionList);
        field(body, "所属主线 / 支线", pickerWrap, true);
        body._line = picker;
        body._lineChoices = lineChoices;
      }
      body._name = field(body, "事务名", input("text", task ? task.name : ""), true);
      field(body, "事务内容", createTaskContentEditor(body, task), true);
      body._owner = field(body, "责任人", ownerInput(task ? task.owner : "", true), true);
      const sel = document.createElement("select");
      for (const s of state.statusEnum) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s;
        if (task && s === task.status) o.selected = true;
        sel.appendChild(o);
      }
      decorateStatusSelect(sel);
      body._status = field(body, "进展状态", sel, true);
      const initialLine = lineById(lineId);
      const initialStart = !task && initialLine && initialLine.fork_date > state.today ?
        initialLine.fork_date : state.today;
      body._start = field(body, "起始日期",
        input("date", task ? task.start_date : initialStart), true);
      body._end = field(body, "结束日期",
        input("date", task ? (task.end_date || "") : initialStart), true);

      const more = document.createElement("details");
      more.className = "task-more-details";
      const moreSummary = document.createElement("summary");
      moreSummary.textContent = "更多描述";
      more.appendChild(moreSummary);
      const priority = document.createElement("select");
      for (const p of state.priorityEnum) {
        const o = document.createElement("option");
        o.value = p; o.textContent = p;
        if ((task ? task.priority : "中") === p) o.selected = true;
        priority.appendChild(o);
      }
      body._priority = field(more, "优先级", priority);
      createDependencyPicker(body, task, task ? prerequisiteIds(task.id) : [], more);
      body._goal = field(more, "闭环目标", input("text", task ? task.goal : ""));
      body._next = field(more, "下一步动作", input("text", task ? task.next_action : ""));
      body._risk = field(more, "风险原因", input("text", task ? task.risk_reason : ""));
      body.appendChild(more);

      const syncEndDate = () => {
        body._end.min = body._start.value;
        if (body._end.value && body._end.value < body._start.value) {
          body._end.value = body._start.value;
        }
      };
      body._start.oninput = syncEndDate;
      body._start.onchange = syncEndDate;
      syncEndDate();

      if (body._line) {
        const syncStartDate = () => {
          const selectedLineId = body._lineChoices.get(body._line.value);
          const selectedLine = lineById(selectedLineId);
          if (!selectedLine) return;
          body._start.min = selectedLine.fork_date;
          if (body._start.value < selectedLine.fork_date) {
            body._start.value = selectedLine.fork_date;
          }
          syncEndDate();
        };
        body._line.oninput = syncStartDate;
        body._line.onchange = syncStartDate;
        syncStartDate();
      }

      if (!isNew) {
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "删除此事务";
        del.className = "modal-delete-button";
        del.onclick = async () => {
          await api(`/api/tasks/${task.id}`, "DELETE");
          $("#modal-mask").classList.add("hidden");
          toast("已删除事务，可按 Ctrl+Z 撤销");
          reload();
        };
        $("#modal-header-tools").appendChild(del);
      }
      body._name.focus();
    },
    async () => {
      const body = $("#modal-body");
      await Promise.all(body._imageReadPromises || []);
      const payload = {
        name: body._name.value.trim(),
        content: body._content.value,
        goal: body._goal.value,
        next_action: body._next.value,
        risk_reason: body._risk.value,
        priority: body._priority.value,
        owner: body._owner.value.trim(),
        status: body._status.value,
        start_date: body._start.value,
        end_date: body._end.value,
        prerequisite_ids: selectedDependencyIds(body),
        images: body._contentImages.map((image) => image.id ?
          { id: image.id } : { data_url: image.data_url }),
      };
      const requiredFields = [
        ["事务名", body._name], ["事务内容", body._content],
        ["责任人", body._owner], ["进展状态", body._status],
        ["起始日期", body._start], ["结束日期", body._end],
      ];
      for (const [label, element] of requiredFields) {
        if (!element.value.trim()) {
          toast(`${label}不能为空`);
          element.focus();
          return false;
        }
      }
      if (isNew) {
        const targetLineId = body._line ?
          body._lineChoices.get(body._line.value) : lineId;
        if (!targetLineId) {
          toast("请从下拉列表选择所属线");
          return false;
        }
        await api("/api/tasks", "POST", { ...payload, line_id: targetLineId });
      } else {
        await api(`/api/tasks/${task.id}`, "PATCH", payload);
      }
      reload();
    }
  );
}

function openWorkspaceModal() {
  openModal("新建项目空间", (body) => {
    body._name = field(body, "空间名称", input("text"));
    const description = document.createElement("textarea");
    description.rows = 3;
    body._description = field(body, "描述", description);
    body._name.focus();
  }, async () => {
    const body = $("#modal-body");
    const name = body._name.value.trim();
    if (!name) { toast("空间名称不能为空"); return false; }
    await api("/api/workspaces", "POST", {
      name, description: body._description.value.trim(),
    });
    resetWorkspaceState();
    await refreshSession();
    await reload();
    toast("项目空间已创建");
  });
}

function openWorkspaceDeleteModal(workspace) {
  openModal("删除项目空间", (body) => {
    const warning = document.createElement("div");
    warning.className = "workspace-delete-warning";
    warning.textContent =
      `此操作将永久删除「${workspace.name}」内的全部线、事务、成员关系和配置，且无法恢复。`;
    body.appendChild(warning);
    const confirmation = input("text");
    confirmation.placeholder = workspace.name;
    confirmation.autocomplete = "off";
    body._confirmation = field(
      body, `请输入项目名称“${workspace.name}”以确认`, confirmation, true
    );
    $("#modal-ok").textContent = "永久删除";
    $("#modal-ok").classList.add("danger");
    confirmation.focus();
  }, async () => {
    const confirmation = $("#modal-body")._confirmation.value;
    if (confirmation !== workspace.name) {
      toast("输入的项目名称不匹配");
      $("#modal-body")._confirmation.focus();
      return false;
    }
    await api(`/api/workspaces/${workspace.id}`, "DELETE", { confirmation });
    resetWorkspaceState();
    await refreshSession();
    await reload();
    toast("项目空间已删除");
    if (state.workspaces.some((item) => item.role === "admin")) {
      openWorkspaceManagementModal();
      return false;
    }
  });
}

function openWorkspaceManagementModal() {
  const managedWorkspaces = state.workspaces.filter(
    (workspace) => workspace.role === "admin"
  );
  openModal("项目空间管理", (body) => {
    $("#modal").classList.add("modal-wide");

    const heading = document.createElement("div");
    heading.className = "workspace-management-heading";
    const hint = document.createElement("span");
    hint.textContent = "归档项目仍可浏览和导出，但不能再编辑。";
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "+ 新建项目空间";
    create.onclick = openWorkspaceModal;
    heading.append(hint, create);
    body.appendChild(heading);

    const list = document.createElement("div");
    list.className = "workspace-management-list";
    for (const workspace of managedWorkspaces) {
      const row = document.createElement("div");
      row.className = "workspace-management-row";
      const info = document.createElement("div");
      info.className = "workspace-management-info";
      const nameLine = document.createElement("div");
      nameLine.className = "workspace-management-name";
      const name = document.createElement("strong");
      name.textContent = workspace.name;
      nameLine.appendChild(name);
      if (workspace.id === state.currentWorkspace?.id) {
        const current = document.createElement("span");
        current.className = "workspace-badge";
        current.textContent = "当前";
        nameLine.appendChild(current);
      }
      if (workspace.archived_at) {
        const archived = document.createElement("span");
        archived.className = "workspace-badge archived";
        archived.textContent = "已归档";
        nameLine.appendChild(archived);
      }
      const description = document.createElement("span");
      description.textContent = workspace.description || "暂无描述";
      info.append(nameLine, description);

      const actions = document.createElement("div");
      actions.className = "workspace-management-actions";
      if (workspace.archived_at) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "恢复项目";
        restore.onclick = async () => {
          await api(`/api/workspaces/${workspace.id}/restore`, "POST");
          await refreshSession();
          await reload();
          toast("项目空间已恢复");
          openWorkspaceManagementModal();
        };
        actions.appendChild(restore);
      } else {
        const archive = document.createElement("button");
        archive.type = "button";
        archive.textContent = "归档";
        archive.onclick = async () => {
          if (!confirm(
            `归档项目空间「${workspace.name}」？\n归档后项目仅可浏览和导出，不能再编辑。`
          )) return;
          await api(`/api/workspaces/${workspace.id}/archive`, "POST");
          await refreshSession();
          await reload();
          toast("项目空间已归档");
          openWorkspaceManagementModal();
        };
        actions.appendChild(archive);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "row-del";
      remove.textContent = "删除";
      remove.onclick = () => openWorkspaceDeleteModal(workspace);
      actions.appendChild(remove);
      row.append(info, actions);
      list.appendChild(row);
    }
    body.appendChild(list);
    $("#modal-ok").classList.add("hidden");
    $("#modal-cancel").textContent = "关闭";
  }, async () => true);
}

async function openMembersModal() {
  const workspace = state.currentWorkspace;
  const result = await api(`/api/workspaces/${workspace.id}/members`);
  openModal(`成员管理 · ${workspace.name}`, (body) => {
    $("#modal").classList.add("modal-wide");

    const listHeading = document.createElement("div");
    listHeading.className = "member-section-heading";
    const listTitle = document.createElement("strong");
    listTitle.textContent = "现有成员";
    const memberCount = document.createElement("span");
    memberCount.textContent = `${result.members.length} 人`;
    listHeading.append(listTitle, memberCount);
    body.appendChild(listHeading);

    const listHeader = document.createElement("div");
    listHeader.className = "member-list-header";
    for (const title of ["成员", "空间角色", "重置密码", "操作"]) {
      const label = document.createElement("span");
      label.textContent = title;
      listHeader.appendChild(label);
    }
    body.appendChild(listHeader);

    const list = document.createElement("div");
    list.className = "member-list";
    for (const member of result.members) {
      const row = document.createElement("div");
      row.className = "member-row";
      const identity = document.createElement("div");
      identity.className = "member-identity";
      const name = input("text", member.display_name);
      name.setAttribute("aria-label", `${member.username} 的姓名`);
      name.disabled = !member.can_manage_account;
      const account = document.createElement("div");
      account.className = "member-account";
      account.textContent = member.username;
      identity.appendChild(name);
      identity.appendChild(account);

      const roleGroup = document.createElement("div");
      roleGroup.className = "member-control";
      const roleLabel = document.createElement("span");
      roleLabel.className = "member-control-label";
      roleLabel.textContent = "空间角色";
      const role = document.createElement("select");
      role.setAttribute("aria-label", `${member.username} 的空间角色`);
      for (const [value, label] of [["admin", "管理员"], ["member", "普通用户"]]) {
        const option = document.createElement("option");
        option.value = value; option.textContent = label;
        option.selected = member.role === value;
        role.appendChild(option);
      }
      roleGroup.append(roleLabel, role);

      const passwordGroup = document.createElement("div");
      passwordGroup.className = "member-control";
      const passwordLabel = document.createElement("span");
      passwordLabel.className = "member-control-label";
      passwordLabel.textContent = "重置密码";
      const password = input("password");
      password.placeholder = member.can_manage_account ?
        "重置密码（可选）" : "由其他管理员维护";
      password.setAttribute("aria-label", `${member.username} 的新密码`);
      password.disabled = !member.can_manage_account;
      password.autocomplete = "new-password";
      passwordGroup.append(passwordLabel, password);

      const actions = document.createElement("div");
      actions.className = "member-actions";
      const save = document.createElement("button");
      save.type = "button"; save.textContent = "保存";
      save.onclick = async () => {
        const payload = { role: role.value };
        if (member.can_manage_account) {
          payload.display_name = name.value.trim();
          if (password.value) payload.password = password.value;
        }
        await api(
          `/api/workspaces/${workspace.id}/members/${member.id}`, "PATCH", payload
        );
        await refreshSession();
        await reload();
        toast("成员配置已保存");
        if (state.currentWorkspace?.role === "admin") openMembersModal();
        else $("#modal-mask").classList.add("hidden");
      };
      actions.appendChild(save);
      if (member.id !== state.user.id) {
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "row-del"; remove.textContent = "移除";
        remove.onclick = async () => {
          if (!confirm(`将账号「${member.username}」移出当前空间？`)) return;
          await api(`/api/workspaces/${workspace.id}/members/${member.id}`, "DELETE");
          await reload();
          toast("成员已移出项目空间");
          openMembersModal();
        };
        actions.appendChild(remove);
      }
      row.appendChild(identity);
      row.appendChild(roleGroup);
      row.appendChild(passwordGroup);
      row.appendChild(actions);
      list.appendChild(row);
    }
    body.appendChild(list);

    const add = document.createElement("div");
    add.className = "member-add";
    const addHeader = document.createElement("div");
    addHeader.className = "member-add-header";
    const addTitle = document.createElement("strong");
    addTitle.textContent = "添加成员";
    const addHint = document.createElement("span");
    addHint.textContent = "可添加已有账号，或填写初始密码创建新账号";
    addHeader.append(addTitle, addHint);
    add.appendChild(addHeader);
    const addGrid = document.createElement("div");
    addGrid.className = "member-add-grid";
    body._username = field(addGrid, "账号", input("text"));
    body._displayName = field(addGrid, "姓名", input("text"));
    body._password = field(addGrid, "初始密码（新账号至少 6 位）", input("password"));
    body._password.autocomplete = "new-password";
    const addRole = document.createElement("select");
    addRole.innerHTML = '<option value="member">普通用户</option><option value="admin">管理员</option>';
    body._role = field(addGrid, "空间角色", addRole);
    add.appendChild(addGrid);
    body.appendChild(add);
    $("#modal-ok").textContent = "添加成员";
  }, async () => {
    const body = $("#modal-body");
    const username = body._username.value.trim();
    if (!username) { toast("请输入账号"); return false; }
    await api(`/api/workspaces/${workspace.id}/members`, "POST", {
      username,
      display_name: body._displayName.value.trim() || username,
      password: body._password.value,
      role: body._role.value,
    });
    await reload();
    toast("成员已添加");
  });
}

function openPasswordModal() {
  openModal("修改密码", (body) => {
    body._current = field(body, "当前密码", input("password"));
    body._next = field(body, "新密码（至少 6 位）", input("password"));
    body._confirm = field(body, "确认新密码", input("password"));
    body._current.autocomplete = "current-password";
    body._next.autocomplete = body._confirm.autocomplete = "new-password";
    body._current.focus();
  }, async () => {
    const body = $("#modal-body");
    if (body._next.value !== body._confirm.value) {
      toast("两次输入的新密码不一致");
      return false;
    }
    await api("/api/auth/password", "PUT", {
      current_password: body._current.value,
      new_password: body._next.value,
    });
    toast("密码已修改");
  });
}

/* ============================================================== 事件绑定 */
$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const error = $("#login-error");
  error.textContent = "";
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api("/api/auth/login", "POST", {
      username: $("#login-username").value.trim(),
      password: $("#login-password").value,
    });
    applySession(data);
    await reload();
  } catch (loginError) {
    error.textContent = loginError.message;
  } finally {
    button.disabled = false;
  }
};

$("#workspace-select").onchange = async (event) => {
  const workspaceId = Number(event.target.value);
  try {
    await api(`/api/workspaces/${workspaceId}/select`, "POST");
    resetWorkspaceState();
    await refreshSession();
    await reload();
  } catch (_error) {
    if (state.currentWorkspace) event.target.value = state.currentWorkspace.id;
  }
};
$("#account-trigger").onclick = toggleAccountMenu;
document.addEventListener("click", (event) => {
  if (!$("#account-bar").contains(event.target)) closeAccountMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#account-menu").classList.contains("hidden")) {
    closeAccountMenu({ restoreFocus: true });
  }
});
$("#btn-workspaces").onclick = () => {
  closeAccountMenu();
  openWorkspaceManagementModal();
};
$("#btn-members").onclick = () => {
  closeAccountMenu();
  openMembersModal();
};
$("#btn-password").onclick = () => {
  closeAccountMenu();
  openPasswordModal();
};
$("#btn-logout").onclick = async () => {
  closeAccountMenu();
  await api("/api/auth/logout", "POST");
  showLoggedOut();
};

function switchView(v) {
  state.view = v;
  $("#btn-view-dashboard").classList.toggle("active", v === "dashboard");
  $("#btn-view-dashboard").setAttribute("aria-pressed", String(v === "dashboard"));
  $("#btn-view-canvas").classList.toggle("active", v === "canvas");
  $("#btn-view-table").classList.toggle("active", v === "table");
  $("#dashboard-view").classList.toggle("hidden", v !== "dashboard");
  $("#canvas-view").classList.toggle("hidden", v !== "canvas");
  $("#table-view").classList.toggle("hidden", v !== "table");
  $("#workbench").classList.toggle("hidden", v === "dashboard");
  savePrefs();
  render();
}

$("#btn-view-dashboard").onclick = () => switchView("dashboard");
$("#btn-view-canvas").onclick = () => switchView("canvas");
$("#btn-view-table").onclick = () => switchView("table");

$("#btn-add-mainline").onclick = () => openLineModal(null, null);
$("#btn-add-branch").onclick = () =>
  state.selectedLineId && openLineModal(null, state.selectedLineId);
$("#btn-add-task").onclick = () =>
  state.selectedLineId && openTaskModal(null, state.selectedLineId);

$("#btn-merge").onclick = () => {
  const line = lineById(state.selectedLineId);
  if (!line) return;
  openModal("反合支线到父线", (body) => {
    body._date = field(body, "反合日期", input("date", state.today));
    const hint = document.createElement("div");
    hint.className = "opt-hint";
    hint.textContent = `将「${line.name}」反合回「${lineById(line.parent_id).name}」`;
    body.appendChild(hint);
  }, async () => {
    await api(`/api/lines/${line.id}`, "PATCH", {
      merge_date: $("#modal-body")._date.value || state.today,
    });
    toast("反合成功");
    reload();
  });
};

async function deleteSelectedLine() {
  if (!ensureWorkspaceEditable()) return;
  const line = lineById(state.selectedLineId);
  if (!line) return;
  const ids = [line.id, ...descendantIds(line.id)];
  const subs = ids.length - 1;
  const n = state.tasks.filter((t) => ids.includes(t.line_id)).length;
  if (!confirm(
    `递归删除「${line.name}」？\n将同时删除其所有子支线及事务` +
    `（全部子支线 ${subs} 条、全部事务 ${n} 个）。\n删除后会进入回收站，可恢复。`)) return;
  await api(`/api/lines/${line.id}`, "DELETE");
  state.selectedLineId = null;
  state.selectedTaskId = null;
  toast("已移入回收站，可按 Ctrl+Z 撤销");
  reload();
}

$("#btn-table-add").onclick = () => {
  if (!state.lines.length) { toast("请先创建一条主线"); return; }
  const lineId = state.selectedLineId || state.lines[0].id;
  openTaskModal(null, lineId, true);
};

$("#btn-statuses").onclick = () => {
  closeAccountMenu();
  if (!ensureWorkspaceEditable()) return;
  openModal("配置进展状态", (body) => {
    const list = document.createElement("div");
    list.className = "status-config-list";
    const addRow = (name = "", color = "#6e7781") => {
      const row = document.createElement("div");
      row.className = "status-config-row";
      const colorInput = input("color", color);
      colorInput.className = "status-color-input";
      colorInput.title = "状态颜色";
      const nameInput = input("text", name);
      nameInput.placeholder = "状态名称";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "status-remove";
      remove.title = "删除状态";
      remove.textContent = "×";
      remove.onclick = () => row.remove();
      row.appendChild(colorInput);
      row.appendChild(nameInput);
      row.appendChild(remove);
      row._name = nameInput;
      row._color = colorInput;
      list.appendChild(row);
    };
    state.statusEnum.forEach((status) => addRow(status, statusColor(status)));
    body.appendChild(list);
    body._statusList = list;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "status-add";
    add.textContent = "+ 添加状态";
    add.onclick = () => {
      addRow("", LINE_COLORS[list.children.length % LINE_COLORS.length]);
      list.lastElementChild._name.focus();
    };
    body.appendChild(add);
    const hint = document.createElement("div");
    hint.className = "opt-hint";
    hint.textContent = "已有事务使用的历史状态会继续保留，避免数据无法编辑。";
    body.appendChild(hint);
    list.firstElementChild?._name.focus();
  }, async () => {
    const rows = [...$("#modal-body")._statusList.children];
    const statuses = [];
    const colors = {};
    for (const row of rows) {
      const status = row._name.value.trim();
      if (!status) continue;
      if (statuses.includes(status)) {
        toast(`状态名称不能重复：${status}`);
        return false;
      }
      statuses.push(status);
      colors[status] = row._color.value;
    }
    if (!statuses.length) {
      toast("至少保留一个进展状态");
      return false;
    }
    const result = await api("/api/statuses", "PUT", { statuses, colors });
    toast(`状态已保存（${result.statuses.length} 项）`);
    reload();
  });
};

$("#btn-trash").onclick = async () => {
  const trash = await api("/api/trash");
  openModal("回收站", (body) => {
    const archived = isWorkspaceArchived();
    if (archived) {
      const readonlyHint = document.createElement("div");
      readonlyHint.className = "opt-hint";
      readonlyHint.textContent = "项目空间已归档，回收站内容仅可查看。";
      body.appendChild(readonlyHint);
    }
    if (!trash.batches.length) {
      const empty = document.createElement("div");
      empty.className = "opt-hint";
      empty.textContent = "回收站为空。";
      body.appendChild(empty);
      return;
    }
    for (const b of trash.batches) {
      const row = document.createElement("div");
      row.className = "trash-row";
      const info = document.createElement("div");
      const names = (b.names || []).slice(0, 4).join("、");
      info.textContent =
        `批次 ${b.batch} · ${b.deleted_at || "未知日期"} · ` +
        `线 ${b.line_count} 条 · 事务 ${b.task_count} 个` +
        (names ? ` · ${names}` : "");
      const restore = document.createElement("button");
      restore.textContent = "恢复";
      restore.disabled = archived;
      restore.onclick = async () => {
        await api("/api/trash/restore", "POST", { batch: b.batch });
        $("#modal-mask").classList.add("hidden");
        toast("已从回收站恢复");
        reload();
      };
      row.appendChild(info);
      row.appendChild(restore);
      body.appendChild(row);
    }
    if (archived) return;
    const purge = document.createElement("button");
    purge.className = "row-del";
    purge.style.marginTop = "12px";
    purge.textContent = "清空回收站";
    purge.onclick = async () => {
      if (!confirm("确定永久清空回收站？此操作不可撤销。")) return;
      await api("/api/trash/purge", "POST");
      $("#modal-mask").classList.add("hidden");
      toast("回收站已清空");
      reload();
    };
    body.appendChild(purge);
  }, async () => true);
};

function setFilter(key, value) {
  state.filters[key] = value;
  state.selectedTaskIds.clear();
  render();
}

$("#filter-q").oninput = (e) => setFilter("q", e.target.value);
$("#filter-line").onchange = (e) => setFilter("line", e.target.value);
$("#filter-owner").onchange = (e) => setFilter("owner", e.target.value);
$("#filter-status").onchange = (e) => setFilter("status", e.target.value);
$("#filter-priority").onchange = (e) => setFilter("priority", e.target.value);
$("#filter-due").onchange = (e) => setFilter("due", e.target.value);
$("#sort-tasks").onchange = (e) => {
  state.sort = e.target.value;
  savePrefs();
  render();
};
$("#btn-clear-filters").onclick = () => {
  state.filters = { q: "", line: "", owner: "", status: "", priority: "", due: "" };
  state.quickFilter = "";
  state.selectedTaskIds.clear();
  renderFilterControls();
  render();
};
for (const btn of document.querySelectorAll(".summary-card")) {
  btn.onclick = () => {
    state.quickFilter = state.quickFilter === btn.dataset.quick ? "" : btn.dataset.quick;
    state.selectedTaskIds.clear();
    render();
  };
}

async function bulkUpdate(field, value) {
  if (!ensureWorkspaceEditable()) return;
  if (!value) return;
  const ids = [...state.selectedTaskIds];
  if (!ids.length) {
    toast("请先勾选事务");
    return;
  }
  await api("/api/tasks/bulk", "PATCH", { ids, patch: { [field]: value } });
  state.selectedTaskIds.clear();
  toast(`已更新 ${ids.length} 个事务`);
  await reload();
}

function responseFilename(response, fallback) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  return encodedName ? decodeURIComponent(encodedName[1]) : fallback;
}

async function downloadResponse(response, fallbackName) {
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = responseFilename(response, fallbackName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showTaskImportErrors(data) {
  openModal("导入失败", (body) => {
    $("#modal").classList.add("modal-wide");
    $("#modal-ok").classList.add("hidden");
    $("#modal-cancel").textContent = "关闭";
    const summary = document.createElement("p");
    summary.className = "import-error-summary";
    summary.textContent = data.error || "导入文件校验失败，未导入任何事务";
    body.appendChild(summary);
    const list = document.createElement("ol");
    list.className = "import-error-list";
    for (const item of data.row_errors || []) {
      const row = document.createElement("li");
      const rowNumber = document.createElement("strong");
      rowNumber.textContent = `第 ${item.row} 行`;
      row.append(rowNumber, document.createTextNode(item.message));
      list.appendChild(row);
    }
    body.appendChild(list);
    if ((data.error_count || 0) > (data.row_errors || []).length) {
      const truncated = document.createElement("p");
      truncated.className = "import-error-more";
      truncated.textContent = `仅显示前 ${(data.row_errors || []).length} 条错误，请修正后重新导入。`;
      body.appendChild(truncated);
    }
  }, async () => true);
}

async function downloadTaskImportTemplate(button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在生成...";
  try {
    const response = await fetch("/api/tasks/import-template");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) showLoggedOut();
      throw new Error(data.error || "模板下载失败");
    }
    await downloadResponse(response, "AnyLine-事务导入模板.xlsx");
    toast("导入模板已下载");
  } catch (error) {
    toast(error.message || "模板下载失败");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openTaskImportDialog() {
  if (!ensureWorkspaceEditable()) return;
  if (!state.lines.length) {
    toast("请先创建主线或支线");
    return;
  }
  openModal("导入事务", (body) => {
    const intro = document.createElement("p");
    intro.className = "import-dialog-intro";
    intro.textContent = "请选择填写完成的 Excel 文件。首次导入或字段有变化时，可先下载当前项目空间的最新模板。";
    body.appendChild(intro);

    const templatePanel = document.createElement("div");
    templatePanel.className = "import-template-panel";
    const templateText = document.createElement("div");
    const templateTitle = document.createElement("strong");
    templateTitle.textContent = "事务导入模板";
    const templateHint = document.createElement("span");
    templateHint.textContent = "包含当前项目的线路、状态、成员责任人和优先级选项";
    templateText.append(templateTitle, templateHint);
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.textContent = "下载模板";
    downloadButton.onclick = () => downloadTaskImportTemplate(downloadButton);
    templatePanel.append(templateText, downloadButton);
    body.appendChild(templatePanel);

    const dropZone = document.createElement("div");
    dropZone.className = "task-import-drop-zone";
    dropZone.tabIndex = 0;
    dropZone.setAttribute("role", "button");
    dropZone.setAttribute("aria-label", "拖拽或选择 Excel 文件");
    const dropIcon = document.createElement("span");
    dropIcon.className = "task-import-drop-icon";
    dropIcon.setAttribute("aria-hidden", "true");
    dropIcon.textContent = "⇩";
    const dropTitle = document.createElement("strong");
    dropTitle.textContent = "将 Excel 文件拖到此处";
    const dropHint = document.createElement("span");
    dropHint.textContent = "或点击此区域选择文件";
    dropZone.append(dropIcon, dropTitle, dropHint);
    dropZone.onclick = () => $("#task-import-file").click();
    dropZone.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $("#task-import-file").click();
      }
    };
    dropZone.ondragenter = dropZone.ondragover = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("is-dragover");
    };
    dropZone.ondragleave = (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("is-dragover");
    };
    dropZone.ondrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("is-dragover");
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      if (files.length > 1) {
        toast("每次只能导入一个 Excel 文件");
        return;
      }
      importTasksFromExcel(files[0], $("#btn-import-tasks"), $("#task-import-file"));
    };
    body.appendChild(dropZone);

    const note = document.createElement("p");
    note.className = "import-dialog-note";
    note.textContent = "仅支持 .xlsx 文件，大小不超过 5 MB，单次最多导入 2,000 条事务。导入前会校验全部数据。";
    body.appendChild(note);
    $("#modal-ok").classList.add("hidden");
    $("#modal-cancel").textContent = "关闭";
  }, async () => true);
}

async function importTasksFromExcel(file, button, inputElement) {
  if (!ensureWorkspaceEditable()) return;
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    toast("仅支持 .xlsx 格式的 Excel 文件");
    inputElement.value = "";
    return;
  }
  if (file.size > MAX_TASK_IMPORT_BYTES) {
    toast("导入文件不能超过 5MB");
    inputElement.value = "";
    return;
  }
  $("#modal-mask").classList.add("hidden");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在导入...";
  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/tasks/import", { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showLoggedOut();
      if (data.row_errors?.length) showTaskImportErrors(data);
      else toast(data.error || "导入失败");
      return;
    }
    state.selectedTaskIds.clear();
    toast(`成功导入 ${data.count} 个事务`);
    await reload();
  } catch (error) {
    toast(error.message || "导入失败");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    inputElement.value = "";
  }
}

async function exportTasks(scope, ids, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在导出...";
  try {
    const response = await fetch("/api/tasks/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, ids }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) showLoggedOut();
      throw new Error(data.error || "导出失败");
    }
    await downloadResponse(
      response, `AnyLine-${scope === "all" ? "全部事务" : "选中事务"}.xlsx`
    );
    toast(scope === "all" ? "已导出全部事务" : `已导出 ${ids.length} 个事务`);
  } catch (error) {
    toast(error.message || "导出失败");
  } finally {
    button.textContent = originalText;
    button.disabled = scope === "all" ? state.tasks.length === 0 :
      state.selectedTaskIds.size === 0;
  }
}

$("#btn-import-tasks").onclick = openTaskImportDialog;
$("#task-import-file").onchange = (event) => {
  const file = event.target.files?.[0];
  if (file) importTasksFromExcel(file, $("#btn-import-tasks"), event.target);
};

$("#btn-export-all").onclick = (event) =>
  exportTasks("all", null, event.currentTarget);
$("#btn-export-selected").onclick = (event) => {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) {
    toast("请先勾选事务");
    return;
  }
  exportTasks("selected", ids, event.currentTarget);
};

$("#bulk-status").onchange = async (e) => {
  await bulkUpdate("status", e.target.value);
  e.target.value = "";
};
$("#bulk-owner").onchange = async (e) => {
  await bulkUpdate("owner", e.target.value);
  e.target.value = "";
};
$("#bulk-priority").onchange = async (e) => {
  await bulkUpdate("priority", e.target.value);
  e.target.value = "";
};
$("#btn-bulk-delete").onclick = async () => {
  if (!ensureWorkspaceEditable()) return;
  const ids = [...state.selectedTaskIds];
  if (!ids.length) {
    toast("请先勾选事务");
    return;
  }
  if (!confirm(`确定删除选中的 ${ids.length} 个事务？删除后会进入回收站。`)) return;
  await api("/api/tasks/bulk", "DELETE", { ids });
  state.selectedTaskIds.clear();
  toast(`已删除 ${ids.length} 个事务，可从回收站恢复`);
  reload();
};

$("#btn-today").onclick = () => {
  const line = $("#graph .today-line");
  if (!line) return;
  centerCanvasPoint(parseFloat(line.getAttribute("x1")));
};
$("#btn-fit").onclick = () => {
  state.zoom = 1;
  state.pan = { x: 0, y: 0 };
  savePrefs();
  renderCanvas();
  $("#canvas-wrap").scrollLeft = 0;
  $("#canvas-wrap").scrollTop = 0;
};
$("#btn-toggle-children").onclick = () => {
  const id = state.selectedLineId;
  if (!id) return;
  const children = state.lines.filter((line) => line.parent_id === id);
  const allHidden = children.every((line) => state.hiddenBranchIds.has(line.id));
  for (const child of children) {
    if (allHidden) state.hiddenBranchIds.delete(child.id);
    else state.hiddenBranchIds.add(child.id);
  }
  render();
};

/* 画布显示开关 */
const SHOW_OPTS = [["#opt-name", "name"], ["#opt-status", "status"],
                   ["#opt-dur", "dur"], ["#opt-owner", "owner"]];
for (const [id, key] of SHOW_OPTS) {
  $(id).onchange = (e) => {
    state.show[key] = e.target.checked;
    updateToggleLabelsBtn();
    savePrefs();
    renderCanvas();
  };
}

/* 一键显示/隐藏全部节点标签 */
function updateToggleLabelsBtn() {
  const anyOn = Object.values(state.show).some(Boolean);
  $("#btn-toggle-labels").textContent = anyOn ? "隐藏全部标签" : "显示全部标签";
}
$("#btn-toggle-labels").onclick = () => {
  const anyOn = Object.values(state.show).some(Boolean);
  const target = !anyOn;   // 有任一开着 -> 全关；全关 -> 全开
  for (const [id, key] of SHOW_OPTS) {
    state.show[key] = target;
    $(id).checked = target;
  }
  updateToggleLabelsBtn();
  savePrefs();
  renderCanvas();
};

/* ---- 画布缩放 (Ctrl+滚轮) 与拖拽平移 (左键长按) ---- */
const wrap = $("#canvas-wrap");

let resizeFrame = null;
window.addEventListener("resize", () => {
  if (state.view !== "canvas") return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(renderCanvas);
});

wrap.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;          // 仅 Ctrl+滚轮触发缩放
  e.preventDefault();
  const old = state.zoom;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = Math.min(4, Math.max(0.25, old * factor));
  if (next === old) return;

  /* 以鼠标位置为锚点缩放：保持指针下的内容不动 */
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const cx = (wrap.scrollLeft + mx - state.pan.x) / old;
  const cy = (wrap.scrollTop + my - state.pan.y) / old;
  state.zoom = next;
  savePrefs();
  renderCanvas();
  wrap.scrollLeft = state.pan.x + cx * next - mx;
  wrap.scrollTop = state.pan.y + cy * next - my;
}, { passive: false });

/* 左键长按拖拽平移（短按仍是点击选中） */
const DRAG_HOLD_MS = 200;    // 长按判定时长
const DRAG_MOVE_PX = 5;
let drag = null;

function applyPanTransform() {
  const root = $("#canvas-root");
  if (root) {
    root.setAttribute(
      "transform",
      `translate(${state.pan.x} ${state.pan.y}) scale(${state.zoom})`
    );
  }
}

function activateDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  wrap.classList.add("grabbing");
  try {
    wrap.setPointerCapture(drag.pointerId);
  } catch (_error) {
    // 指针已释放时由 pointerup/pointercancel 完成清理。
  }
}

wrap.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (!$("#canvas-root")) return;
  if (drag) return;
  drag = {
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    panX: state.pan.x, panY: state.pan.y,
    active: false, downAt: Date.now(),
  };
  drag.timer = setTimeout(activateDrag, DRAG_HOLD_MS);
});

wrap.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.active && Math.hypot(dx, dy) > DRAG_MOVE_PX &&
      Date.now() - drag.downAt >= DRAG_HOLD_MS) {
    activateDrag();
  }
  if (drag.active) {
    e.preventDefault();
    state.pan.x = drag.panX + dx;
    state.pan.y = drag.panY + dy;
    applyPanTransform();
  }
});

function finishDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  clearTimeout(drag.timer);
  if (drag.active) {
    /* 拖拽刚结束时抑制本次 click，避免误触选中/取消选中 */
    wrap.classList.remove("grabbing");
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
  }
  if (wrap.hasPointerCapture(e.pointerId)) {
    wrap.releasePointerCapture(e.pointerId);
  }
  drag = null;
}

window.addEventListener("pointerup", finishDrag);
window.addEventListener("pointercancel", finishDrag);

let suppressNextClick = false;
wrap.addEventListener("click", (e) => {
  if (suppressNextClick) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);   // 捕获阶段拦截

/* 画布快捷键：输入控件内保留浏览器原生的删除与撤销行为。 */
document.addEventListener("keydown", async (e) => {
  if (!$("#image-lightbox").classList.contains("hidden")) {
    if (e.key === "Escape") closeTaskImageViewer();
    else if (e.key === "ArrowLeft") moveTaskImageViewer(-1);
    else if (e.key === "ArrowRight") moveTaskImageViewer(1);
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    $("#modal-mask").classList.add("hidden");
    return;
  }
  if (!document.body.classList.contains("authenticated") || state.view !== "canvas") return;
  if (!$("#modal-mask").classList.contains("hidden") ||
      !$("#account-menu").classList.contains("hidden")) return;
  const target = e.target;
  if (target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable)) return;

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.repeat) return;
    if (!ensureWorkspaceEditable()) return;
    try {
      await api("/api/undo", "POST");
      toast("已撤销上一次编辑");
      await reload();
    } catch (_error) {
      // api() 已显示没有可撤销操作或服务端错误。
    }
    return;
  }

  if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (e.repeat) return;
    if (!state.selectedLineId) {
      toast("请先选择一条线");
      return;
    }
    await deleteSelectedLine();
  }
});

/* ---- 启动：恢复界面偏好，登录后加载当前项目空间 ---- */
async function bootstrap() {
  loadPrefs();
  for (const [id, key] of SHOW_OPTS) $(id).checked = state.show[key];
  updateToggleLabelsBtn();
  switchView(state.view);
  try {
    if (await refreshSession()) await reload();
  } catch (_error) {
    showLoggedOut();
  }
}

bootstrap();
