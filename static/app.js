/* AnyLine 前端逻辑：画布视图 + 表格视图 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  lines: [], tasks: [], dependencies: [], canUndo: false, statusEnum: [], statusColors: {},
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
const CREATE_WORKSPACE_OPTION = "__create_workspace__";
const DONE_STATUSES = new Set(["已闭环", "已取消"]);
const RISK_STATUSES = new Set(["有风险"]);
const PRIORITY_WEIGHT = { "低": 1, "中": 2, "高": 3, "紧急": 4 };
const DEFAULT_STATUS_COLORS = {
  "未启动": "#8c959f", "进行中": "#0969da", "有风险": "#d4a72c",
  "等待中": "#0e7490", "已暂停": "#8250df", "已闭环": "#1a7f37",
  "已取消": "#57606a",
};

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
    if (p.view === "canvas" || p.view === "table") state.view = p.view;
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
  document.body.classList.remove("authenticated");
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
    option.textContent = workspace.name;
    option.selected = workspace.id === state.currentWorkspace.id;
    select.appendChild(option);
  }
  const isCurrentAdmin = state.currentWorkspace?.role === "admin";
  const canCreateWorkspace = state.workspaces.some((workspace) => workspace.role === "admin");
  if (canCreateWorkspace) {
    const createOption = document.createElement("option");
    createOption.value = CREATE_WORKSPACE_OPTION;
    createOption.textContent = "+";
    select.appendChild(createOption);
  }
  $("#btn-members").classList.toggle("hidden", !isCurrentAdmin);
  const displayName = (state.user.display_name || state.user.username || "").trim();
  const accountName = state.user.username || displayName;
  $("#account-avatar").textContent = Array.from(displayName)[0]?.toLocaleUpperCase() || "用";
  $("#account-trigger").setAttribute("aria-label", `${displayName}，打开账号菜单`);
  $("#current-user").textContent = displayName;
  $("#current-username").textContent = accountName === displayName ? "" : accountName;
  $("#current-username").classList.toggle("hidden", accountName === displayName);
  $("#current-user-role").textContent = isCurrentAdmin ? "管理员" : "普通用户";
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
  const owners = new Set(state.owners);
  for (const t of state.tasks) if (t.owner) owners.add(t.owner);
  return [...owners].sort((a, b) => a.localeCompare(b, "zh-CN"));
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
  if (state.view === "canvas") renderCanvas();
  else renderTable();
}

/* ---------------------------------------------------------------- toolbar */
function renderToolbar() {
  const sel = state.selectedLineId ? lineById(state.selectedLineId) : null;
  const selectedTask = state.selectedTaskId ? taskById(state.selectedTaskId) : null;
  const children = sel ? state.lines.filter((line) => line.parent_id === sel.id) : [];
  const allChildrenHidden = children.length > 0 &&
    children.every((line) => state.hiddenBranchIds.has(line.id));
  $("#btn-add-branch").disabled = !sel;
  $("#btn-add-task").disabled = !sel;
  $("#btn-merge").disabled = !sel || sel.parent_id === null || sel.merge_date;
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
    id: "dependency-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4,
    markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse",
  }, defs);
  svgEl("path", { d: "M 0 0 L 8 4 L 0 8 z", class: "dependency-arrow-head" }, dependencyArrow);

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
    const lbl = svgEl("text", {
      x: (merge ? merge.end.x : x2) + 10,
      y: (merge ? merge.end.y : y) + 4,
      fill: color, class: "line-label",
    }, gLines);
    lbl.textContent = 
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
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const start = state.canvasTaskPositions.get(sourceTask.id);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    let moved = false;
    const preview = svgEl("line", {
      x1: start.x, y1: start.y, x2: start.x, y2: start.y,
      class: "dependency-line dependency-preview",
      "marker-end": "url(#dependency-arrow)",
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
      `优先级：${t.priority || "中"}\n` +
      `${t.start_date} ~ ${t.end_date || "…"}\n内容：${t.content || "—"}\n` +
      `闭环目标：${t.goal || "—"}\n下一步：${t.next_action || "—"}\n风险原因：${t.risk_reason || "—"}`;

    const parts1 = [], parts2 = [];
    if (state.show.name) parts1.push(t.name);
    if (state.show.status) parts2.push(t.status);
    if (state.show.dur) parts2.push(fmtDays(daysBetween(t.status_since, state.today)));
    if (state.show.owner && t.owner) parts2.push("@" + t.owner);
    if (t.priority === "高" || t.priority === "紧急") parts2.push(t.priority);

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
      svgEl("circle", { cx, cy: topY, r: 8, class: "cluster-collapse-btn" }, g);
      const tx = svgEl("text", {
        x: cx, y: topY + 3.5, "text-anchor": "middle", class: "cluster-collapse-x",
      }, g);
      tx.textContent = "▾";
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
      "marker-end": "url(#dependency-arrow)",
    }, gDependencies);
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
    selLine.onchange = () => saveTask(t.id, { line_id: +selLine.value });
    tdLine.appendChild(selLine);
    tr.appendChild(tdLine);

    /* 文本字段 */
    const textField = (key, val) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.value = val || "";
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
    selPriority.onchange = () => saveTask(t.id, { priority: selPriority.value });
    tdPriority.appendChild(selPriority);
    tr.appendChild(tdPriority);

    /* 责任人：配置了名单则下拉选择，否则文本输入 */
    const tdOwner = document.createElement("td");
    const ownerEl = ownerInput(t.owner);
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
    decorateStatusSelect(selSt);
    tdSt.appendChild(selSt);
    tr.appendChild(tdSt);

    const tdDependencies = document.createElement("td");
    const dependencyIds = prerequisiteIds(t.id);
    const dependencyButton = document.createElement("button");
    dependencyButton.type = "button";
    dependencyButton.className = "dependency-config-button";
    dependencyButton.textContent = dependencyIds.length ? `${dependencyIds.length} 项` : "配置";
    dependencyButton.title = dependencyIds.length
      ? dependencyIds.map((id) => taskById(id)?.name).filter(Boolean).join("、")
      : "配置依赖事务";
    dependencyButton.onclick = () => openTaskDependenciesModal(t);
    tdDependencies.appendChild(dependencyButton);
    tr.appendChild(tdDependencies);

    /* 日期 */
    const dateField = (key, val) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "date";
      inp.value = val || "";
      inp.onchange = () => saveTask(t.id, { [key]: inp.value || null });
      td.appendChild(inp);
      return td;
    };
    tr.appendChild(dateField("start_date", t.start_date));
    tr.appendChild(dateField("end_date", t.end_date));

    const tdUpdated = document.createElement("td");
    tdUpdated.className = "muted-cell";
    tdUpdated.textContent = t.updated_at || "—";
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
    btn.onclick = async () => {
      await api(`/api/tasks/${t.id}`, "DELETE");
      toast("已删除事务，可从回收站恢复");
      reload();
    };
    tdDel.appendChild(locate);
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  }
  if (!sorted.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 16;
    td.style.color = "#8c959f";
    td.textContent = state.tasks.length ? "没有匹配筛选条件的事务。" : "暂无事务，点击「+ 新增事务」添加。";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function saveTask(id, patch) {
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
  $("#modal").classList.remove("modal-wide");
  $("#modal-ok").textContent = "确定";
  const body = $("#modal-body");
  body.innerHTML = "";
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

function field(parent, labelText, el) {
  const div = document.createElement("div");
  div.className = "field";
  const lb = document.createElement("label");
  lb.textContent = labelText;
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

/*
 * 责任人输入控件：
 * - 配置了名单 -> 下拉选择（含"（不指定）"；当前值不在名单时保留为一项以免丢数据）
 * - 未配置名单 -> 普通文本框
 */
function ownerInput(value = "") {
  if (!state.owners.length) return input("text", value);
  const sel = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（不指定）";
  sel.appendChild(empty);
  const names = [...state.owners];
  if (value && !names.includes(value)) names.unshift(value);  // 保留历史值
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n + (state.owners.includes(n) ? "" : "（不在名单）");
    if (n === value) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

/* 新建/编辑线 */
function openLineModal(line, parentId = null) {
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

function createDependencyPicker(body, task, selectedIds = []) {
  const selected = new Set(selectedIds);
  const candidates = state.tasks
    .filter((candidate) => !task || candidate.id !== task.id)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
  const picker = document.createElement("div");
  picker.className = "dependency-picker";
  body._dependencyChecks = [];
  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.className = "dependency-empty";
    empty.textContent = "暂无其他事务";
    picker.appendChild(empty);
  }
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
    body._dependencyChecks.push({ checkbox, taskId: candidate.id });
  }
  field(body, "依赖事务", picker);
}

function selectedDependencyIds(body) {
  return (body._dependencyChecks || [])
    .filter(({ checkbox }) => checkbox.checked)
    .map(({ taskId }) => taskId);
}

function openTaskDependenciesModal(task) {
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

/* 新建/编辑事务 */
function openTaskModal(task, lineId = null, allowLineSelection = false) {
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
        field(body, "所属主线 / 支线", pickerWrap);
        body._line = picker;
        body._lineChoices = lineChoices;
      }
      body._name = field(body, "事务名", input("text", task ? task.name : ""));
      const ta = document.createElement("textarea");
      ta.value = task ? task.content : "";
      body._content = field(body, "事务内容", ta);
      body._goal = field(body, "闭环目标", input("text", task ? task.goal : ""));
      body._next = field(body, "下一步动作", input("text", task ? task.next_action : ""));
      body._risk = field(body, "风险原因", input("text", task ? task.risk_reason : ""));
      const priority = document.createElement("select");
      for (const p of state.priorityEnum) {
        const o = document.createElement("option");
        o.value = p; o.textContent = p;
        if ((task ? task.priority : "中") === p) o.selected = true;
        priority.appendChild(o);
      }
      body._priority = field(body, "优先级", priority);
      body._owner = field(body, "责任人", ownerInput(task ? task.owner : ""));
      const sel = document.createElement("select");
      for (const s of state.statusEnum) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s;
        if (task && s === task.status) o.selected = true;
        sel.appendChild(o);
      }
      decorateStatusSelect(sel);
      body._status = field(body, "进展状态", sel);
      const initialLine = lineById(lineId);
      const initialStart = !task && initialLine && initialLine.fork_date > state.today ?
        initialLine.fork_date : state.today;
      body._start = field(body, "起始日期",
        input("date", task ? task.start_date : initialStart));
      body._end = field(body, "结束日期", input("date", task && task.end_date || ""));
      createDependencyPicker(body, task, task ? prerequisiteIds(task.id) : []);

      if (body._line) {
        const syncStartDate = () => {
          const selectedLineId = body._lineChoices.get(body._line.value);
          const selectedLine = lineById(selectedLineId);
          if (!selectedLine) return;
          body._start.min = selectedLine.fork_date;
          if (body._start.value < selectedLine.fork_date) {
            body._start.value = selectedLine.fork_date;
          }
        };
        body._line.oninput = syncStartDate;
        body._line.onchange = syncStartDate;
        syncStartDate();
      }

      if (!isNew) {
        const del = document.createElement("button");
        del.textContent = "删除此事务";
        del.className = "row-del";
        del.style.marginTop = "4px";
        del.onclick = async () => {
          await api(`/api/tasks/${task.id}`, "DELETE");
          $("#modal-mask").classList.add("hidden");
          toast("已删除事务，可按 Ctrl+Z 撤销");
          reload();
        };
        body.appendChild(del);
      }
      body._name.focus();
    },
    async () => {
      const body = $("#modal-body");
      const payload = {
        name: body._name.value.trim(),
        content: body._content.value,
        goal: body._goal.value,
        next_action: body._next.value,
        risk_reason: body._risk.value,
        priority: body._priority.value,
        owner: body._owner.value.trim(),
        status: body._status.value,
        start_date: body._start.value || state.today,
        end_date: body._end.value || null,
        prerequisite_ids: selectedDependencyIds(body),
      };
      if (!payload.name) { toast("事务名不能为空"); return false; }
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

async function openMembersModal() {
  const workspace = state.currentWorkspace;
  const result = await api(`/api/workspaces/${workspace.id}/members`);
  openModal(`成员管理 · ${workspace.name}`, (body) => {
    $("#modal").classList.add("modal-wide");
    const list = document.createElement("div");
    list.className = "member-list";
    for (const member of result.members) {
      const row = document.createElement("div");
      row.className = "member-row";
      const identity = document.createElement("div");
      const name = input("text", member.display_name);
      name.disabled = !member.can_manage_account;
      const account = document.createElement("div");
      account.className = "member-account";
      account.textContent = member.username;
      identity.appendChild(name);
      identity.appendChild(account);
      const role = document.createElement("select");
      for (const [value, label] of [["admin", "管理员"], ["member", "普通用户"]]) {
        const option = document.createElement("option");
        option.value = value; option.textContent = label;
        option.selected = member.role === value;
        role.appendChild(option);
      }
      const password = input("password");
      password.placeholder = member.can_manage_account ?
        "重置密码（可选）" : "由其他管理员维护";
      password.disabled = !member.can_manage_account;
      password.autocomplete = "new-password";
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
          toast("成员已移出项目空间");
          openMembersModal();
        };
        actions.appendChild(remove);
      }
      row.appendChild(identity);
      row.appendChild(role);
      row.appendChild(password);
      row.appendChild(actions);
      list.appendChild(row);
    }
    body.appendChild(list);

    const add = document.createElement("div");
    add.className = "member-add";
    const title = document.createElement("div");
    title.className = "opt-title"; title.textContent = "添加账号";
    add.appendChild(title);
    body._username = field(add, "账号", input("text"));
    body._displayName = field(add, "姓名", input("text"));
    body._password = field(add, "初始密码（新账号至少 6 位）", input("password"));
    body._password.autocomplete = "new-password";
    const addRole = document.createElement("select");
    addRole.innerHTML = '<option value="member">普通用户</option><option value="admin">管理员</option>';
    body._role = field(add, "空间角色", addRole);
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
  if (event.target.value === CREATE_WORKSPACE_OPTION) {
    event.target.value = state.currentWorkspace.id;
    openWorkspaceModal();
    return;
  }
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
  $("#btn-view-canvas").classList.toggle("active", v === "canvas");
  $("#btn-view-table").classList.toggle("active", v === "table");
  $("#canvas-view").classList.toggle("hidden", v !== "canvas");
  $("#table-view").classList.toggle("hidden", v !== "table");
  savePrefs();
  render();
}

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

/* 责任人名单配置 */
$("#btn-owners").onclick = () => {
  closeAccountMenu();
  openModal("配置责任人名单", (body) => {
    const ta = document.createElement("textarea");
    ta.rows = 8;
    ta.placeholder = "每行一个责任人姓名，留空则不启用下拉选择";
    ta.value = state.owners.join("\n");
    body._owners = field(body, "责任人名单（每行一个）", ta);
    const hint = document.createElement("div");
    hint.className = "opt-hint";
    hint.textContent =
      "配置生效后，事务的责任人改为下拉选择；清空名单可恢复自由输入。" +
      "已有事务中不在名单里的责任人不会丢失。";
    body.appendChild(hint);
    ta.focus();
  }, async () => {
    const owners = $("#modal-body")._owners.value
      .split("\n").map((s) => s.trim()).filter(Boolean);
    await api("/api/owners", "PUT", { owners });
    toast(owners.length ? `名单已保存（${owners.length} 人）` : "名单已清空，恢复自由输入");
    reload();
  });
};

$("#btn-statuses").onclick = () => {
  closeAccountMenu();
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
    const disposition = response.headers.get("Content-Disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filename = encodedName ? decodeURIComponent(encodedName[1]) :
      `AnyLine-${scope === "all" ? "全部事务" : "选中事务"}.xlsx`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(scope === "all" ? "已导出全部事务" : `已导出 ${ids.length} 个事务`);
  } catch (error) {
    toast(error.message || "导出失败");
  } finally {
    button.textContent = originalText;
    button.disabled = scope === "all" ? state.tasks.length === 0 :
      state.selectedTaskIds.size === 0;
  }
}

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
