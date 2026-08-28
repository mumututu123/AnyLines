/* AnyLine 前端逻辑：画布视图 + 表格视图 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  lines: [], tasks: [], canUndo: false, statusEnum: [], owners: [], today: "",
  selectedLineId: null,
  view: "canvas",
  show: { name: true, status: true, dur: true, owner: true },
  expandedClusters: new Set(),   // 已展开的同天多事务簇 key: "lineId|date"
  zoom: 1,                       // 画布缩放倍数 (Ctrl+滚轮)
};

/* ---------------------------------------------- 界面偏好记忆 (localStorage) */
const PREFS_KEY = "anyline.prefs";

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      show: state.show,
      view: state.view,
      zoom: state.zoom,
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
  const res = await fetch(url, opt);
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

/* ---------------------------------------------------------------- data */
async function reload() {
  const d = await api("/api/state");
  state.lines = d.lines;
  state.tasks = d.tasks;
  state.canUndo = d.can_undo;
  state.statusEnum = d.status_enum;
  state.owners = d.owners || [];
  state.today = d.today;
  if (state.selectedLineId && !lineById(state.selectedLineId)) {
    state.selectedLineId = null;
  }
  render();
}

function render() {
  renderToolbar();
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
  $("#sel-info").textContent = sel
    ? `已选中：${sel.name}${sel.parent_id === null ? "（主线）" : "（支线）"}`
    : "未选中任何线";
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
function buildClusters() {
  const clusters = new Map();
  for (const t of state.tasks) {
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
  svg.innerHTML = "";
  const rows = assignRows();

  if (!state.lines.length) {
    svg.setAttribute("width", 800);
    svg.setAttribute("height", 400);
    const t = svgEl("text", { x: 60, y: 80, fill: "#8c959f", "font-size": 15 }, svg);
    t.textContent = "还没有任何线，点击左上角「+ 主线」开始。";
    return;
  }

  /* 时间范围 */
  let minD = state.today, maxD = state.today;
  for (const l of state.lines) {
    if (l.fork_date < minD) minD = l.fork_date;
    const e = lineEnd(l);
    if (e > maxD) maxD = e;
  }
  for (const t of state.tasks) {
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
  const clusters = buildClusters();
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

  const width = Math.max(x(stop.toISOString().slice(0, 10)) + CV.padR, 900);
  const height = cursorY + 60;
  const z = state.zoom;
  svg.setAttribute("width", width * z);
  svg.setAttribute("height", height * z);

  /* 根容器：整体缩放 */
  const root = svgEl("g", { transform: `scale(${z})` }, svg);

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
    stroke: "#fb8f44", "stroke-width": 1, "stroke-dasharray": "4 4", opacity: .6,
  }, gGrid);

  /* ---- 线 ---- */
  const gLines = svgEl("g", {}, root);
  const colorOf = (l) => LINE_COLORS[rows.get(l.id) % LINE_COLORS.length];

  for (const line of state.lines) {
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
    const select = () => { state.selectedLineId = line.id; render(); };
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
    const lbl = svgEl("text", {
      x: x2 + 10, y: y + 4, fill: color, class: "line-label",
    }, gLines);
    lbl.textContent = line.name + (line.merge_date ? " ✓已反合" : "");
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
        rx: 4, class: `task-bar st-${t.status}`,
      }, gTasks);
    }

    const node = svgEl("circle", {
      cx, cy: y, r: 7, class: `task-node st-${t.status}`,
    }, gTasks);
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedLineId = line.id; render();
    });
    node.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openTaskModal(t);
    });
    const title = svgEl("title", {}, node);
    title.textContent =
      `${t.name}\n状态：${t.status}\n责任人：${t.owner || "—"}\n` +
      `${t.start_date} ~ ${t.end_date || "…"}\n内容：${t.content || "—"}\n闭环目标：${t.goal || "—"}`;

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
    if (!line) continue;
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
      const g = svgEl("g", { class: "cluster-node" }, gTasks);
      /* 底层双环暗示"这是一叠节点" */
      svgEl("circle", { cx: cx + 3, cy: baseY + 3, r: 9, class: `task-node st-${st}`, opacity: .35 }, g);
      const node = svgEl("circle", { cx, cy: baseY, r: 9, class: `task-node st-${st}` }, g);
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
    if (e.target === svg) { state.selectedLineId = null; render(); }
  };
}

/* ============================================================== 表格视图 */
function renderTable() {
  const tbody = $("#task-tbody");
  tbody.innerHTML = "";
  const sorted = [...state.tasks].sort(
    (a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);

  for (const t of sorted) {
    const tr = document.createElement("tr");

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

    /* 删除 */
    const tdDel = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "row-del";
    btn.textContent = "删除";
    btn.onclick = async () => {
      await api(`/api/tasks/${t.id}`, "DELETE");
      toast("已删除事务，可点「撤销删除」恢复");
      reload();
    };
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  }
  if (!sorted.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.style.color = "#8c959f";
    td.textContent = "暂无事务，点击「+ 新增事务」添加。";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function saveTask(id, patch) {
  await api(`/api/tasks/${id}`, "PATCH", patch);
  reload();
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
    if (await onOk() !== false) close();
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
      if (!name) { toast("线名不能为空"); return false; }
      if (isNew) {
        const r = await api("/api/lines", "POST", {
          name, parent_id: parentId, fork_date: body._date.value || state.today,
        });
        state.selectedLineId = r.id;
      } else {
        await api(`/api/lines/${line.id}`, "PATCH", {
          name, fork_date: body._date.value,
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
  const subs = state.lines.filter((l) => l.parent_id === line.id).length;
  const n = state.tasks.filter((t) => t.line_id === line.id).length;
  if (!confirm(
    `递归删除「${line.name}」？\n将同时删除其所有子支线及事务` +
    `（直属支线 ${subs} 条、直属事务 ${n} 个）。\n删除后可立即撤销。`)) return;
  await api(`/api/lines/${line.id}`, "DELETE");
  state.selectedLineId = null;
  toast("已递归删除，可点「撤销删除」恢复");
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
  const cx = (wrap.scrollLeft + mx) / old;   // 指针处的画布坐标
  const cy = (wrap.scrollTop + my) / old;
  state.zoom = next;
  savePrefs();
  renderCanvas();
  wrap.scrollLeft = cx * next - mx;
  wrap.scrollTop = cy * next - my;
}, { passive: false });

/* 左键长按拖拽平移（短按仍是点击选中） */
const DRAG_HOLD_MS = 200;    // 长按判定时长
const DRAG_MOVE_PX = 5;      // 或按住后移动超过该距离即进入拖拽
let drag = null;

wrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  drag = {
    startX: e.clientX, startY: e.clientY,
    scrollL: wrap.scrollLeft, scrollT: wrap.scrollTop,
    active: false, downAt: Date.now(),
  };
  drag.timer = setTimeout(() => {
    if (drag) { drag.active = true; wrap.classList.add("grabbing"); }
  }, DRAG_HOLD_MS);
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.active && Math.hypot(dx, dy) > DRAG_MOVE_PX &&
      Date.now() - drag.downAt >= DRAG_HOLD_MS) {
    drag.active = true;
    wrap.classList.add("grabbing");
  }
  if (drag.active) {
    e.preventDefault();
    wrap.scrollLeft = drag.scrollL - dx;
    wrap.scrollTop = drag.scrollT - dy;
  }
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.active) {
    /* 拖拽刚结束时抑制本次 click，避免误触选中/取消选中 */
    wrap.classList.remove("grabbing");
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
  }
  drag = null;
});

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
