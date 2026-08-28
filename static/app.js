/* AnyLine 前端逻辑：画布视图 + 表格视图 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  lines: [], tasks: [], canUndo: false, statusEnum: [], priorityEnum: [], owners: [], today: "",
  selectedLineId: null,
  selectedTaskId: null,
  selectedTaskIds: new Set(),
  view: "canvas",
  show: { name: true, status: true, dur: true, owner: true },
  expandedClusters: new Set(),   // 已展开的同天多事务簇 key: "lineId|date"
  collapsedLineIds: new Set(),   // 画布中已折叠子支线的线
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
    toast(data.error || `请求失败 (${res.status})`);
    throw new Error(data.error || res.status);
  }
  return data;
}

function parseDate(s) { return new Date(s + "T00:00:00"); }
function fmtDays(n) {
  return n >= 1 ? `${n}天` : "今日";
}
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
function lineById(id) { return state.lines.find((l) => l.id === id); }
function isDone(t) { return DONE_STATUSES.has(t.status); }
function priorityRank(p) { return PRIORITY_WEIGHT[p] || 0; }
function statusClass(status) {
  return ["未启动", "进行中", "有风险", "等待中", "已暂停", "已闭环", "已取消"].includes(status)
    ? `st-${status}` : "st-custom";
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
  state.canUndo = d.can_undo;
  state.statusEnum = d.status_enum;
  state.priorityEnum = d.priority_enum || ["低", "中", "高", "紧急"];
  state.owners = d.owners || [];
  state.today = d.today;
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
  $("#btn-add-branch").disabled = !sel;
  $("#btn-add-task").disabled = !sel;
  $("#btn-rename").disabled = !sel;
  $("#btn-delete-line").disabled = !sel;
  $("#btn-merge").disabled = !sel || sel.parent_id === null || sel.merge_date;
  $("#btn-undo").disabled = !state.canUndo;
  $("#btn-toggle-children").disabled = !sel ||
    !state.lines.some((l) => l.parent_id === sel.id);
  $("#btn-toggle-children").textContent =
    sel && state.collapsedLineIds.has(sel.id) ? "展开子支线" : "折叠子支线";
  $("#sel-info").textContent = sel
    ? `已选中：${sel.name}${sel.parent_id === null ? "（主线）" : "（支线）"}`
    : "未选中任何线";
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
function assignRows() {
  const roots = state.lines.filter((l) => l.parent_id === null);
  const children = (pid) =>
    state.lines.filter((l) => l.parent_id === pid)
      .sort((a, b) => a.fork_date.localeCompare(b.fork_date) || a.id - b.id);
  const rows = new Map();
  let row = 0;
  function walk(line) {
    rows.set(line.id, row++);
    if (state.collapsedLineIds.has(line.id)) return;
    for (const c of children(line.id)) walk(c);
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
  const rows = assignRows();
  const canvasTasks = filteredTasks();

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

  const contentWidth = Math.max(x(stop.toISOString().slice(0, 10)) + CV.padR, 900);
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
  const colorOf = (l) => LINE_COLORS[rows.get(l.id) % LINE_COLORS.length];

  for (const line of visibleLines) {
    const y = lineY(line.id);
    const color = colorOf(line);
    const x1 = x(line.fork_date);
    const endDate = lineEnd(line);
    const x2 = Math.max(x(endDate), x1 + 30);
    const selected = line.id === state.selectedLineId;
    const parent = line.parent_id !== null ? lineById(line.parent_id) : null;

    let d = "";
    if (parent) {
      /* 从父线拉出的贝塞尔分叉 */
      const py = lineY(parent.id);
      d += `M ${x1} ${py} C ${x1 + 16} ${py}, ${x1} ${y}, ${x1 + 24} ${y} `;
      d += `L ${x2} ${y}`;
    } else {
      d = `M ${x1} ${y} L ${x2} ${y}`;
    }
    /* 反合回父线 */
    if (parent && line.merge_date) {
      const py = lineY(parent.id);
      const mx = x(line.merge_date);
      d += ` C ${mx + 24} ${y}, ${mx + 8} ${py}, ${mx + 32} ${py}`;
    }

    const path = svgEl("path", {
      d, stroke: color,
      class: "line-path" + (selected ? " selected" : ""),
    }, gLines);
    /* 加宽的透明命中区域 */
    const hit = svgEl("path", { d, class: "line-hit" }, gLines);
    const lineTip = svgEl("title", {}, hit);
    lineTip.textContent = `${line.name}\n${line.description || "暂无描述"}`;
    const select = () => {
      state.selectedLineId = line.id;
      state.selectedTaskId = null;
      render();
    };
    hit.addEventListener("click", select);
    path.addEventListener("click", select);
    hit.addEventListener("dblclick", () => openLineModal(line));

    /* 分叉点 / 反合点 */
    if (parent) {
      svgEl("circle", {
        cx: x1, cy: lineY(parent.id), r: 4.5, fill: color, class: "fork-dot",
      }, gLines);
    }
    if (parent && line.merge_date) {
      svgEl("circle", {
        cx: x(line.merge_date) + 32, cy: lineY(parent.id),
        r: 4.5, fill: color, class: "merge-dot",
      }, gLines);
    }

    /* 线名标签 */
    const childCount = state.lines.filter((l) => l.parent_id === line.id).length;
    const lbl = svgEl("text", {
      x: x2 + 10, y: y + 4, fill: color, class: "line-label",
    }, gLines);
    lbl.textContent = line.name +
      (line.merge_date ? " ✓已反合" : "") +
      (childCount && state.collapsedLineIds.has(line.id) ? `（已折叠 ${childCount}）` : "");
    lbl.addEventListener("click", select);
  }

  /* ---- 事务节点（同线同天多事务折叠为聚合节点，点击展开/折叠） ---- */
  const gTasks = svgEl("g", {}, root);

  /*
   * 节点横坐标：支线的水平段从 x(fork_date)+24 才开始（前 24px 是从父线
   * 拉下来的贝塞尔曲线），事务日期为分叉当日时需向右钳制，确保节点落在线上。
   */
  const BRANCH_CURVE_W = 24;
  const nodeX = (t) => {
    const ln = lineById(t.line_id);
    const lineStart = x(ln.fork_date) +
      (ln.parent_id !== null ? BRANCH_CURVE_W : 0);
    return Math.max(x(t.start_date), lineStart);
  };

  /* 单个事务节点 + 标签 */
  const drawTask = (t, y, labelRight) => {
    const line = lineById(t.line_id);
    const cx = nodeX(t);

    if (t.end_date && t.end_date > t.start_date) {
      svgEl("rect", {
        x: cx, y: y - 4, width: Math.max(x(t.end_date) - cx, 2), height: 8,
        rx: 4, class: `task-bar ${statusClass(t.status)}`,
      }, gTasks);
    }

    const health = taskHealth(t);
    const selectedTask = state.selectedTaskId === t.id;
    const node = svgEl("circle", {
      cx, cy: y, r: selectedTask ? 10 : 7,
      "data-task-id": t.id,
      class: `task-node ${statusClass(t.status)} ${health.className}`,
    }, gTasks);
    state.canvasTaskPositions.set(t.id, { x: cx, y });
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedLineId = line.id;
      state.selectedTaskId = t.id;
      render();
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
      /* 底层双环暗示"这是一叠节点" */
      svgEl("circle", { cx: cx + 3, cy: baseY + 3, r: 9, class: `task-node ${statusClass(st)} ${clusterHealth}`, opacity: .35 }, g);
      const node = svgEl("circle", { cx, cy: baseY, r: 9, class: `task-node ${statusClass(st)} ${clusterHealth}` }, g);
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
    tdSt.appendChild(selSt);
    tr.appendChild(tdSt);

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
      toast("已删除事务，可点「撤销删除」恢复");
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
    td.colSpan = 15;
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
  const body = $("#modal-body");
  body.innerHTML = "";
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
      if (!name) { toast("线名不能为空"); return false; }
      if (isNew) {
        const r = await api("/api/lines", "POST", {
          name, description, parent_id: parentId,
          fork_date: body._date.value || state.today,
        });
        state.selectedLineId = r.id;
      } else {
        await api(`/api/lines/${line.id}`, "PATCH", {
          name, description, fork_date: body._date.value,
        });
      }
      reload();
    }
  );
}

/* 新建/编辑事务 */
function openTaskModal(task, lineId = null) {
  const isNew = !task;
  openModal(
    isNew ? `新建事务（${lineById(lineId).name}）` : "编辑事务",
    (body) => {
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
      body._status = field(body, "进展状态", sel);
      body._start = field(body, "起始日期",
        input("date", task ? task.start_date : state.today)); // 默认当天
      body._end = field(body, "结束日期", input("date", task && task.end_date || ""));

      if (!isNew) {
        const del = document.createElement("button");
        del.textContent = "删除此事务";
        del.className = "row-del";
        del.style.marginTop = "4px";
        del.onclick = async () => {
          await api(`/api/tasks/${task.id}`, "DELETE");
          $("#modal-mask").classList.add("hidden");
          toast("已删除事务，可点「撤销删除」恢复");
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
      };
      if (!payload.name) { toast("事务名不能为空"); return false; }
      if (isNew) {
        await api("/api/tasks", "POST", { ...payload, line_id: lineId });
      } else {
        await api(`/api/tasks/${task.id}`, "PATCH", payload);
      }
      reload();
    }
  );
}

/* ============================================================== 事件绑定 */
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
$("#btn-rename").onclick = () =>
  state.selectedLineId && openLineModal(lineById(state.selectedLineId));

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

$("#btn-delete-line").onclick = async () => {
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
  toast("已移入回收站，可撤销或从回收站恢复");
  reload();
};

$("#btn-undo").onclick = async () => {
  await api("/api/undo", "POST");
  toast("已撤销上一次删除");
  reload();
};

$("#btn-table-add").onclick = () => {
  if (!state.lines.length) { toast("请先创建一条主线"); return; }
  const lineId = state.selectedLineId || state.lines[0].id;
  openTaskModal(null, lineId);
};

/* 责任人名单配置 */
$("#btn-owners").onclick = () => {
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
  openModal("配置进展状态", (body) => {
    const ta = document.createElement("textarea");
    ta.rows = 8;
    ta.value = state.statusEnum.join("\n");
    body._statuses = field(body, "进展状态（每行一个）", ta);
    const hint = document.createElement("div");
    hint.className = "opt-hint";
    hint.textContent = "已有事务使用的历史状态会继续保留，避免数据无法编辑。";
    body.appendChild(hint);
    ta.focus();
  }, async () => {
    const statuses = $("#modal-body")._statuses.value
      .split("\n").map((s) => s.trim()).filter(Boolean);
    await api("/api/statuses", "PUT", { statuses });
    toast(`状态已保存（${statuses.length} 项）`);
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
  if (state.collapsedLineIds.has(id)) state.collapsedLineIds.delete(id);
  else state.collapsedLineIds.add(id);
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

/* Esc 关闭弹窗 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal-mask").classList.add("hidden");
});

/* ---- 启动：恢复上次的界面偏好并同步控件状态 ---- */
loadPrefs();
for (const [id, key] of SHOW_OPTS) $(id).checked = state.show[key];
updateToggleLabelsBtn();
switchView(state.view);   // 恢复视图模式（内部会调用 render）
reload();
