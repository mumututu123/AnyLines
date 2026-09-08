/* 项目看板辅助分析；历史场景来自服务端，个人确认点、基线与讲解保存在当前浏览器。 */
"use strict";

const DashboardAnalysis = (() => {
  const modes = [
    { id: "changes", name: "最近变化", help: "上次确认后改了什么" },
    { id: "baseline", name: "计划偏差", help: "当前计划偏离了多少" },
    { id: "delay", name: "延期影响", help: "一个事务晚了会怎样" },
    { id: "replay", name: "历史回放", help: "项目过去是什么样" },
    { id: "tour", name: "汇报演练", help: "按顺序讲项目进展" },
    { id: "milestones", name: "里程碑验收", help: "交付还差哪些事项" },
  ];
  let context = null;
  let epoch = 0;
  let timer = null;
  let mapSequence = 0;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const note = (host, text) => host.appendChild(el("p", text, "analysis-note"));
  function toolIntro(host, title, answer, steps = []) {
    const intro = el("header", undefined, "analysis-tool-intro");
    intro.appendChild(el("p", "这个工具回答", "analysis-kicker"));
    intro.appendChild(el("h3", title));
    intro.appendChild(el("p", answer, "analysis-tool-answer"));
    if (steps.length) {
      const list = el("ol", undefined, "analysis-steps");
      steps.forEach(step => list.appendChild(el("li", step)));
      intro.appendChild(list);
    }
    host.appendChild(intro);
  }
  function metricCards(host, items) {
    const cards = el("div", undefined, "analysis-metrics");
    for (const [label, value, detail = ""] of items) {
      const card = el("div", undefined, "analysis-metric");
      card.append(el("span", label), el("strong", String(value)));
      if (detail) card.appendChild(el("small", detail));
      cards.appendChild(card);
    }
    host.appendChild(cards);
  }
  function mapLegend(host, comparison = false, currentLabel = "当前日期", previousLabel = "对比点中的原日期",
    dependencyLabel = "箭头指向前置事务") {
    const legend = el("div", undefined, "analysis-map-legend");
    const add = (className, text) => {
      const item = el("span"); item.append(el("i", undefined, className), document.createTextNode(text));
      legend.appendChild(item);
    };
    add("current", currentLabel);
    if (comparison) add("previous", previousLabel);
    add("changed", "重点关注的事务");
    add("dependency", dependencyLabel);
    host.appendChild(legend);
  }
  function delayLegend(host) {
    const legend = el("div", undefined, "analysis-delay-legend");
    const add = (className, text) => {
      const item = el("span"); item.append(el("i", undefined, className), document.createTextNode(text));
      legend.appendChild(item);
    };
    add("before", "原计划");
    add("after", "推演后");
    add("extension", "指定事务新增时间");
    host.appendChild(legend);
  }
  function mapDetails(host, scene, options = {}, label = "展开时间图查看位置变化") {
    const details = el("details", undefined, "analysis-map-details");
    details.appendChild(el("summary", label));
    const body = el("div", undefined, "analysis-map-details-body");
    mapLegend(body, Boolean(options.ghost), options.legendCurrent);
    drawMap(body, scene, options);
    details.appendChild(body);
    host.appendChild(details);
  }
  const done = task => ["已闭环", "已取消"].includes(task.status);
  const selectKeys = (item, keys) => Object.fromEntries(keys.map(key => [key, item[key] ?? null]));
  const taskKeys = ["id", "line_id", "name", "owner", "priority", "status", "start_date", "end_date"];
  const lineKeys = ["id", "name", "parent_id", "fork_date", "merge_date", "color"];
  const milestoneKeys = ["id", "line_id", "name", "target_description", "milestone_date", "acceptance_task_ids"];
  function sceneNow() {
    return JSON.parse(JSON.stringify({
      tasks: state.tasks.map(task => selectKeys(task, taskKeys)),
      lines: state.lines.map(line => selectKeys(line, lineKeys)),
      milestones: state.milestones.map(milestone => selectKeys(milestone, milestoneKeys)),
      dependencies: state.dependencies.map(edge => ({ ...edge })),
    }));
  }
  const validScene = value => value && ["tasks", "lines", "milestones", "dependencies"]
    .every(key => Array.isArray(value[key]));
  function readStored(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); }
    catch (_) { return null; }
  }
  function save(kind, value) {
    try {
      localStorage.setItem(`${context.key}.${kind}`, JSON.stringify(value));
      return true;
    } catch (_) {
      toast("浏览器存储不可用或空间不足，本次记录未保存");
      return false;
    }
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
    if (context) context.playing = false;
    const play = document.querySelector("#analysis-play");
    if (play) { play.textContent = "播放"; play.setAttribute("aria-pressed", "false"); }
  }
  function reset() {
    stop();
    epoch++;
    context = null;
    document.querySelector("#analysis-panel")?.replaceChildren();
  }
  function invalidateHistory() {
    if (context) { context.history = null; context.cache.clear(); }
  }
  function ensureContext() {
    if (!state.user || !state.currentWorkspace) return false;
    const key = `anyline.analysis.v1.${state.user.id}.${state.currentWorkspace.id}`;
    if (context?.key === key) return true;
    reset();
    const previous = readStored(`${key}.visit`);
    const baseline = readStored(`${key}.baseline`);
    const tour = readStored(`${key}.tour`);
    context = {
      key, mode: "changes", previous: validScene(previous?.scene) ? previous : null,
      baseline: validScene(baseline?.scene) ? baseline : null,
      tour: Array.isArray(tour) ? tour.filter(step => ["task", "line", "milestone"].includes(step.kind) &&
        Number.isInteger(step.id) && typeof step.note === "string").slice(0, 50) : [],
      tourIndex: -1, history: null, historyIndex: null, cache: new Map(), playing: false,
      delayTask: null, delayDays: 3, milestoneId: null,
    };
    return true;
  }
  const stampedScene = () => ({ savedAt: new Date().toISOString(), scene: sceneNow() });
  const stampText = value => new Date(value).toLocaleString();
  async function useHistoricalPoint(kind, choose, action = null) {
    if (action) action.disabled = true;
    try {
      const history = await api("/api/dashboard/history");
      const item = choose(history.snapshots || []);
      if (!item) { toast("没有符合条件的历史记录"); return; }
      const data = await api(`/api/dashboard/history/${item.snapshot_date}`);
      const saved = { savedAt: data.captured_at, scene: data.scene };
      if (!save(kind, saved)) return;
      if (kind === "visit") context.previous = saved;
      else context.baseline = saved;
      render();
      toast(`已使用 ${item.snapshot_date} 的历史记录`);
    } catch (_) {
      // api() 已展示具体错误；保留当前空状态，允许重试。
    } finally {
      if (action?.isConnected) action.disabled = false;
    }
  }
  function render() {
    const details = document.querySelector(".dashboard-supporting");
    if (!details.open || state.view !== "dashboard" || !ensureContext()) return;
    stop();
    epoch++;
    const tabs = document.querySelector("#analysis-tabs");
    tabs.replaceChildren();
    modes.forEach((mode, index) => {
      const tab = button("", () => { context.mode = mode.id; render(); document.querySelector(`#analysis-tab-${mode.id}`).focus(); });
      tab.append(el("strong", mode.name), el("small", mode.help));
      tab.id = `analysis-tab-${mode.id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "analysis-panel");
      tab.setAttribute("aria-selected", String(context.mode === mode.id));
      tab.tabIndex = context.mode === mode.id ? 0 : -1;
      tab.onkeydown = event => {
        const next = event.key === "ArrowRight" ? (index + 1) % modes.length :
          event.key === "ArrowLeft" ? (index + modes.length - 1) % modes.length :
          event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        context.mode = modes[next].id; render();
        document.querySelector(`#analysis-tab-${context.mode}`).focus();
      };
      tabs.appendChild(tab);
    });
    const host = document.querySelector("#analysis-panel");
    host.setAttribute("aria-labelledby", `analysis-tab-${context.mode}`);
    host.replaceChildren();
    ({ changes: renderChanges, baseline: renderBaseline, delay: renderDelay,
      replay: renderReplay, tour: renderTour, milestones: renderMilestones })[context.mode](host);
  }
  const dependencyKey = edge => `${edge.dependent_task_id}:${edge.prerequisite_task_id}`;
  function compareScenes(before, after) {
    const changes = [];
    const labels = { name: "名称", owner: "责任人", priority: "优先级", status: "状态",
      start_date: "起始日期", end_date: "结束日期", line_id: "所属线", parent_id: "父线",
      fork_date: "起始日期", merge_date: "反合日期", color: "颜色",
      milestone_date: "验收日期", target_description: "验收目标", acceptance_task_ids: "验收事务" };
    for (const [key, kind] of [["tasks", "事务"], ["lines", "线"], ["milestones", "里程碑"]]) {
      const old = new Map(before[key].map(item => [item.id, item]));
      for (const item of after[key]) {
        const prior = old.get(item.id);
        old.delete(item.id);
        if (!prior) { changes.push({ key, kind, item, type: "新增", fields: [] }); continue; }
        const fields = Object.keys(labels).filter(field => Object.hasOwn(item, field) &&
          JSON.stringify(item[field]) !== JSON.stringify(prior[field]))
          .map(field => ({ field, label: labels[field], before: prior[field], after: item[field] }));
        if (fields.length) changes.push({ key, kind, item, prior, type: "调整", fields });
      }
      for (const item of old.values()) changes.push({ key, kind, item, type: "移除", fields: [] });
    }
    const oldEdges = new Set(before.dependencies.map(dependencyKey));
    const newEdges = new Set(after.dependencies.map(dependencyKey));
    for (const [scene, other, type] of [[after, oldEdges, "新增"], [before, newEdges, "移除"]]) {
      const tasks = new Map(scene.tasks.map(task => [task.id, task]));
      for (const edge of scene.dependencies) if (!other.has(dependencyKey(edge))) {
        changes.push({ key: "dependencies", kind: "依赖", type, fields: [],
          item: { id: edge.dependent_task_id, name: `${tasks.get(edge.dependent_task_id)?.name || "事务"} → ${tasks.get(edge.prerequisite_task_id)?.name || "事务"}` } });
      }
    }
    return changes;
  }
  function changeList(host, changes, before, after) {
    if (!changes.length) return;
    host.appendChild(el("h4", "变化明细", "analysis-result-title"));
    const list = el("div", undefined, "analysis-list");
    const display = (field, value, scene) => {
      if (field === "line_id" || field === "parent_id") return scene.lines.find(line => line.id === value)?.name || "无";
      if (field === "acceptance_task_ids") return (value || []).map(id => scene.tasks.find(task => task.id === id)?.name || `#${id}`).join("、") || "无";
      return value || "无";
    };
    for (const change of changes) {
      const row = el("div", undefined, "analysis-change");
      const text = el("div");
      text.appendChild(el("strong", `${change.type} · ${change.kind} · ${change.item.name}`));
      for (const field of change.fields) text.appendChild(el("p",
        `${field.label}：${display(field.field, field.before, before)} → ${display(field.field, field.after, after)}`));
      row.appendChild(text);
      if (["tasks", "dependencies"].includes(change.key) && taskById(change.item.id)) {
        row.appendChild(button("定位画布", () => locateTask(change.item.id)));
      }
      list.appendChild(row);
    }
    host.appendChild(list);
  }
  function renderChanges(host) {
    const current = sceneNow();
    const previous = context.previous;
    toolIntro(host, "上次确认以后，项目改了什么？",
      "比较事务、线、依赖和里程碑的新增、移除与字段调整。这里只读取项目，不会修改任何业务数据。",
      ["查看下方变化清单", "需要时定位到画布核对", "处理完后，明确确认“全部已看”"]);
    const tools = el("div", undefined, "analysis-toolbar");
    const acknowledge = button(previous ? "全部已看，重新从现在记录" : "从现在开始记录变化", () => {
      const next = stampedScene();
      if (save("visit", next)) { context.previous = next; render(); toast("已把当前状态设为新的对比点"); }
    });
    acknowledge.title = previous ? "更新确认点后，当前变化清单会清空" : "保存当前状态，作为今后的变化对比点";
    acknowledge.className = "analysis-primary-action";
    tools.appendChild(acknowledge);
    if (!previous) tools.appendChild(button("与最近一个记录日比较", event =>
      useHistoricalPoint("visit", snapshots => [...snapshots].reverse()
        .find(item => item.snapshot_date < state.today), event.currentTarget)));
    host.appendChild(tools);
    if (!previous) {
      const empty = el("div", undefined, "analysis-callout");
      empty.append(el("strong", "还没有可比较的确认点"),
        el("p", "点击“从现在开始记录变化”。此后变化会一直保留，直到你明确点击“全部已看”。"));
      host.appendChild(empty);
      mapDetails(host, current, {}, "查看当前项目时间图");
      return;
    }
    const changes = compareScenes(previous.scene, current);
    const changedTasks = new Set(changes.filter(item => item.key === "tasks").map(item => item.item.id));
    metricCards(host, [
      ["变化总数", changes.length, `对比点：${stampText(previous.savedAt)}`],
      ["新增", changes.filter(item => item.type === "新增").length],
      ["调整", changes.filter(item => item.type === "调整").length],
      ["移除", changes.filter(item => item.type === "移除").length],
    ]);
    if (!changes.length) {
      const empty = el("div", undefined, "analysis-callout success");
      empty.append(el("strong", "没有发现变化"), el("p", `当前项目与 ${stampText(previous.savedAt)} 的对比点一致。`));
      host.appendChild(empty);
    }
    changeList(host, changes, previous.scene, current);
    mapDetails(host, current, { ghost: previous.scene, highlight: changedTasks }, "在时间图上查看这些变化");
  }
  function renderBaseline(host) {
    const baseline = context.baseline;
    toolIntro(host, "当前计划与原定计划差了多少？",
      "先保存一次计划作为基线，之后这里会列出改期、增项和移除。基线只保存在当前浏览器，不会改动项目。",
      baseline ? ["先看偏差数字和清单", "展开时间图核对位置", "确认新计划后再更新基线"] :
        ["点击保存当前计划", "项目调整后回到这里", "查看当前计划与基线的差异"]);
    const tools = el("div", undefined, "analysis-toolbar");
    const saveBaseline = button(baseline ? "确认新计划，更新基线" : "保存当前计划作为基线", () => {
      const next = stampedScene();
      if (save("baseline", next)) { context.baseline = next; render(); toast("计划基线已保存"); }
    });
    saveBaseline.title = baseline ? "用当前计划替换旧基线，现有偏差将归零" : "保存当前计划，供以后比较";
    saveBaseline.className = "analysis-primary-action";
    tools.appendChild(saveBaseline);
    if (!baseline) tools.appendChild(button("用最早的历史记录作基线", event =>
      useHistoricalPoint("baseline", snapshots => snapshots[0], event.currentTarget)));
    host.appendChild(tools);
    const current = sceneNow();
    if (!baseline) {
      const empty = el("div", undefined, "analysis-callout");
      empty.append(el("strong", "尚未保存计划基线"),
        el("p", "基线相当于给当前计划拍一张参考照片。保存后，未来的日期和范围调整才有比较对象。"));
      host.appendChild(empty);
      mapDetails(host, current, {}, "保存前先查看当前计划时间图");
      return;
    }
    const changes = compareScenes(baseline.scene, current);
    const moved = changes.filter(item => item.key === "tasks" && item.fields.some(field => ["start_date", "end_date"].includes(field.field)));
    metricCards(host, [
      ["改期事务", moved.length, `基线：${stampText(baseline.savedAt)}`],
      ["新增事项", changes.filter(item => item.type === "新增").length],
      ["移除事项", changes.filter(item => item.type === "移除").length],
      ["全部差异", changes.length],
    ]);
    if (!changes.length) {
      const empty = el("div", undefined, "analysis-callout success");
      empty.append(el("strong", "当前计划与基线一致"), el("p", "尚未发现改期、增项或移除。"));
      host.appendChild(empty);
    }
    changeList(host, changes, baseline.scene, current);
    mapDetails(host, current, { ghost: baseline.scene, highlight: new Set(moved.map(item => item.item.id)) },
      "在时间图上对照基线与当前计划");
  }
  function simulateDelay(scene, sourceId, days) {
    const tasks = new Map(scene.tasks.map(task => [task.id, task]));
    const source = tasks.get(sourceId);
    const shifts = new Map();
    if (!source || done(source) || !Number.isInteger(days) || days < 0 || days > 365) return { shifts, scene, milestones: [] };
    const prerequisites = new Map(scene.tasks.map(task => [task.id, []]));
    const next = new Map(scene.tasks.map(task => [task.id, []]));
    const indegrees = new Map(scene.tasks.map(task => [task.id, 0]));
    for (const edge of scene.dependencies) if (tasks.has(edge.dependent_task_id) && tasks.has(edge.prerequisite_task_id)) {
      prerequisites.get(edge.dependent_task_id).push(edge.prerequisite_task_id);
      next.get(edge.prerequisite_task_id).push(edge.dependent_task_id);
      indegrees.set(edge.dependent_task_id, indegrees.get(edge.dependent_task_id) + 1);
    }
    const queue = scene.tasks.filter(task => indegrees.get(task.id) === 0).map(task => task.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index], task = tasks.get(id);
      if (!done(task)) {
        let original = task.start_date, projected = original;
        for (const priorId of prerequisites.get(id)) {
          const prior = tasks.get(priorId);
          if (done(prior)) continue;
          const end = prior.end_date || prior.start_date;
          const shiftedEnd = dashboardDateIso(dashboardAddDays(end, shifts.get(priorId) || 0));
          if (end > original) original = end;
          if (shiftedEnd > projected) projected = shiftedEnd;
        }
        const amount = id === sourceId ? days : Math.max(0, daysBetween(original, projected));
        if (amount) shifts.set(id, amount);
      }
      for (const nextId of next.get(id)) {
        indegrees.set(nextId, indegrees.get(nextId) - 1);
        if (indegrees.get(nextId) === 0) queue.push(nextId);
      }
    }
    if (queue.length !== tasks.size) throw new Error("依赖关系存在循环，无法推演");
    const projectedTasks = scene.tasks.map(task => {
      const amount = shifts.get(task.id) || 0;
      if (task.id === sourceId) {
        return { ...task, end_date: dashboardDateIso(dashboardAddDays(task.end_date || task.start_date, amount)) };
      }
      return { ...task, start_date: dashboardDateIso(dashboardAddDays(task.start_date, amount)),
        end_date: task.end_date ? dashboardDateIso(dashboardAddDays(task.end_date, amount)) : task.end_date };
    });
    const projectedById = new Map(projectedTasks.map(task => [task.id, task]));
    const milestones = scene.milestones.filter(item => item.acceptance_task_ids.some(id => shifts.has(id)))
      .map(item => {
        const dates = item.acceptance_task_ids.map(id => projectedById.get(id)).filter(task => task && !done(task))
          .map(task => task.end_date || task.start_date);
        const latest = dates.sort().at(-1) || item.milestone_date;
        return { ...item, projected_date: latest > item.milestone_date ? latest : item.milestone_date,
          days: Math.max(0, daysBetween(item.milestone_date, latest)) };
      });
    return { shifts, scene: { ...scene, tasks: projectedTasks }, milestones };
  }
  function labeled(host, text, control) {
    const label = el("label", text);
    label.appendChild(control); host.appendChild(label);
    return control;
  }
  function renderDelay(host) {
    toolIntro(host, "如果一个事务延期，会影响谁和哪个里程碑？",
      "这是一次实时沙盘推演：所选事务的开始日期不变，只延长结束日期；由此造成的下游顺延会沿依赖关系继续传递。推演不会修改真实计划。",
      ["选择可能延期的事务", "填写预计延期天数", "直接查看自动刷新的影响数字、日期和甘特泳道"]);
    const candidates = state.tasks.filter(task => !done(task));
    if (!candidates.length) { dashboardEmpty(host, "暂无可推演的未完成事务"); return; }
    if (!candidates.some(task => task.id === context.delayTask)) context.delayTask = candidates[0].id;
    const tools = el("div", undefined, "analysis-toolbar");
    const select = el("select"); select.id = "analysis-delay-task";
    for (const task of candidates) { const option = el("option", task.name); option.value = task.id; select.appendChild(option); }
    select.value = context.delayTask;
    labeled(tools, "1. 哪个事务可能延期？", select);
    const days = el("input"); days.id = "analysis-delay-days"; days.type = "number";
    days.min = "0"; days.max = "365"; days.step = "1"; days.value = context.delayDays;
    labeled(tools, "2. 预计延期几天？", days);
    host.appendChild(tools);
    const assumptions = el("details", undefined, "analysis-assumptions");
    assumptions.append(el("summary", "推演按什么规则计算？"),
      el("p", "假设后续事务要等前置事务结束才能开始，并保持原工期。计划中的空档会先吸收延期；多条依赖汇合时取最晚约束；已闭环或已取消事务不会继续传递影响。没有结束日期时按起始日期估算。"));
    host.appendChild(assumptions);
    const result = el("div"); result.id = "analysis-delay-result"; result.setAttribute("aria-live", "polite"); host.appendChild(result);
    function update() {
      result.replaceChildren();
      if (days.value === "" || !days.checkValidity()) { note(result, "延期天数请输入 0–365 之间的整数"); return; }
      context.delayTask = Number(select.value); context.delayDays = Number(days.value);
      const original = sceneNow();
      let projected;
      try { projected = simulateDelay(original, context.delayTask, context.delayDays); }
      catch (error) { note(result, error.message); return; }
      const affected = projected.scene.tasks.filter(task => projected.shifts.has(task.id));
      const owners = new Set(affected.flatMap(task => taskOwners(task)));
      metricCards(result, [["受影响事务", affected.length, "包含所选起点"], ["涉及责任人", owners.size],
        ["相关里程碑", projected.milestones.length],
        ["最大顺延", affected.length ? Math.max(...projected.shifts.values()) + " 天" : "0 天"]]);
      if (!affected.length) {
        const empty = el("div", undefined, "analysis-callout success");
        empty.append(el("strong", "没有产生日期影响"),
          el("p", context.delayDays === 0 ? "延期天数为 0，计划保持不变。" : "该事务已完成，或没有可继续传递的排期影响。"));
        result.appendChild(empty);
      }
      if (affected.length) {
        const affectedIds = new Set(affected.map(task => task.id));
        const projectedMilestones = projected.milestones.map(item => {
          const milestone = original.milestones.find(candidate => candidate.id === item.id);
          return milestone ? { ...milestone, milestone_date: item.projected_date } : null;
        }).filter(Boolean);
        const lineIds = new Set([...affected.map(task => task.line_id),
          ...projectedMilestones.map(milestone => milestone.line_id)]);
        for (let index = 0; index < original.lines.length; index++) {
          for (const line of original.lines) if (lineIds.has(line.id) && line.parent_id !== null) lineIds.add(line.parent_id);
        }
        const milestoneIds = new Set(projectedMilestones.map(item => item.id));
        const affectedScene = {
          tasks: projected.scene.tasks.filter(task => affectedIds.has(task.id)),
          lines: projected.scene.lines.filter(line => lineIds.has(line.id)),
          dependencies: projected.scene.dependencies.filter(edge =>
            affectedIds.has(edge.dependent_task_id) && affectedIds.has(edge.prerequisite_task_id)),
          milestones: projectedMilestones,
        };
        const originalScene = {
          tasks: original.tasks.filter(task => affectedIds.has(task.id)),
          lines: original.lines.filter(line => lineIds.has(line.id)),
          dependencies: original.dependencies.filter(edge =>
            affectedIds.has(edge.dependent_task_id) && affectedIds.has(edge.prerequisite_task_id)),
          milestones: original.milestones.filter(item => milestoneIds.has(item.id)),
        };
        const gantt = el("section", undefined, "analysis-delay-gantt");
        gantt.appendChild(el("h4", "预计日期变化", "analysis-result-title"));
        note(gantt, "每行只对照原计划与推演后的日期；橙色突出指定事务增加的时间，行尾显示本次影响天数。主线和支线仅用于分组；双击事务或里程碑泳道可打开详情。");
        delayLegend(gantt);
        drawMap(gantt, affectedScene, { ghost: originalScene, readonly: true,
          comparisonMode: "delay", sourceId: context.delayTask, showDependencies: false,
          openDetails: true });
        result.appendChild(gantt);
      }
    }
    select.onchange = update;
    days.oninput = update;
    update();
  }
  async function renderReplay(host) {
    toolIntro(host, "项目在某一天是什么样？",
      "选择有记录的一天，查看当时的事务、依赖和里程碑。历史场景只读，不会把项目恢复到过去。",
      ["选择日期，或用上一天、下一天切换", "点击播放可按记录日自动前进", "在地图中点击节点查看当时的日期和状态"]);
    const version = epoch, active = context;
    const current = () => context === active && epoch === version && state.view === "dashboard" &&
      document.querySelector(".dashboard-supporting").open;
    const loading = el("p", "正在读取历史…", "analysis-note"); host.appendChild(loading);
    try {
      if (!active.history) {
        const data = await api("/api/dashboard/history");
        if (!current()) return;
        active.history = data.snapshots;
      }
      loading.remove();
      const history = active.history;
      if (!history.length) { dashboardEmpty(host, "暂无场景历史。重新加载项目后开始积累每日记录。"); return; }
      active.historyIndex = Math.min(active.historyIndex ?? history.length - 1, history.length - 1);
      const tools = el("div", undefined, "analysis-toolbar");
      const select = el("select"); select.id = "analysis-history-date";
      history.forEach((item, index) => { const option = el("option", item.snapshot_date); option.value = index; select.appendChild(option); });
      labeled(tools, "查看哪一天？", select);
      const previous = button("← 上一个记录日", () => { stop(); active.historyIndex--; void show(); });
      previous.id = "analysis-history-previous";
      const play = button("播放", async () => {
        if (active.playing) { stop(); return; }
        active.playing = true; play.textContent = "暂停"; play.setAttribute("aria-pressed", "true");
        if (active.historyIndex === history.length - 1) active.historyIndex = 0;
        await show();
        async function tick() {
          if (!current() || !active.playing) return;
          if (active.historyIndex >= history.length - 1) { stop(); return; }
          active.historyIndex++;
          await show();
          if (current() && active.playing) timer = setTimeout(tick, 1200);
        }
        if (current() && active.playing) timer = setTimeout(tick, 1200);
      });
      play.id = "analysis-play"; play.disabled = history.length < 2; play.setAttribute("aria-pressed", "false");
      const next = button("下一个记录日 →", () => { stop(); active.historyIndex++; void show(); });
      next.id = "analysis-history-next";
      tools.append(previous, play, next); host.appendChild(tools);
      const historyNote = el("div", undefined, "analysis-callout compact");
      historyNote.append(el("strong", `共有 ${history.length} 个记录日`), el("p",
        history.length === 1 ? "目前只能查看今天；有第二个记录日后就可以播放。" :
          `范围：${history[0].snapshot_date} 至 ${history.at(-1).snapshot_date}。没有访问项目的日期不会生成记录。`));
      host.appendChild(historyNote);
      const result = el("div"); result.id = "analysis-history-result"; host.appendChild(result);
      let request = 0;
      async function show() {
        const token = ++request;
        const item = history[active.historyIndex];
        select.value = active.historyIndex;
        previous.disabled = active.historyIndex <= 0;
        next.disabled = active.historyIndex >= history.length - 1;
        result.replaceChildren(); note(result, "正在载入场景…");
        try {
          let data = active.cache.get(item.snapshot_date);
          if (!data) {
            data = await api(`/api/dashboard/history/${item.snapshot_date}`);
            if (!current() || token !== request) return;
            active.cache.set(item.snapshot_date, data);
          }
          if (!current() || token !== request) return;
          result.replaceChildren();
          metricCards(result, [["当前回放日期", item.snapshot_date, `记录于 ${stampText(data.captured_at)}`],
            ["当时事务", data.scene.tasks.length], ["当时依赖", data.scene.dependencies.length],
            ["当时里程碑", data.scene.milestones.length]]);
          mapLegend(result, false, "该日记录的日期");
          drawMap(result, data.scene, { readonly: true });
        } catch (error) {
          if (!current() || token !== request) return;
          stop(); result.replaceChildren(); note(result, `场景读取失败：${error.message}`);
          result.appendChild(button("重试", show));
        }
      }
      select.onchange = () => { stop(); active.historyIndex = Number(select.value); void show(); };
      await show();
    } catch (error) {
      if (!current()) return;
      loading.textContent = `历史读取失败：${error.message}`;
      host.appendChild(button("重试", render));
    }
  }
  function tourObject(step, scene) {
    return scene[{ task: "tasks", line: "lines", milestone: "milestones" }[step.kind]].find(item => item.id === step.id);
  }
  function renderTour(host) {
    toolIntro(host, "开会时，按什么顺序讲最清楚？",
      "把成果、卡点和下一次交付排成一条讲解路线。路线只保存在当前浏览器，不会修改项目。",
      ["选择一个事务、线或里程碑并加入路线", "为每一步填写要讲的重点，必要时调整顺序", "点击“开始汇报”，按上一步、下一步演练"]);
    const scene = sceneNow();
    const tools = el("div", undefined, "analysis-toolbar");
    const select = el("select"); select.id = "analysis-tour-target";
    for (const [key, kind, label] of [["tasks", "task", "事务"], ["lines", "line", "线"], ["milestones", "milestone", "里程碑"]]) {
      const group = el("optgroup"); group.label = label;
      for (const item of scene[key]) { const option = el("option", item.name); option.value = `${kind}:${item.id}`; group.appendChild(option); }
      select.appendChild(group);
    }
    labeled(tools, "1. 下一步要讲什么？", select);
    const add = button("添加步骤", () => {
      if (!select.value) return;
      if (context.tour.length >= 50) { toast("最多保存 50 个讲解步骤"); return; }
      const [kind, id] = select.value.split(":");
      const next = [...context.tour, { kind, id: Number(id), note: "" }];
      if (save("tour", next)) { context.tour = next; context.tourIndex = -1; render(); }
    });
    add.disabled = !select.value;
    tools.appendChild(add);
    const start = button(context.tourIndex < 0 ? "开始汇报" : "结束汇报", () => {
      context.tourIndex = context.tourIndex < 0 ? 0 : -1; render();
    });
    start.disabled = !context.tour.length; tools.appendChild(start); host.appendChild(tools);
    if (!context.tour.length) {
      const empty = el("div", undefined, "analysis-callout");
      empty.append(el("strong", "汇报路线还是空的"),
        el("p", "建议从“本期成果”开始，再加入“当前卡点”和“下一次交付”三个步骤。"));
      host.appendChild(empty);
      return;
    }
    if (context.tourIndex >= 0) {
      const index = Math.min(context.tourIndex, context.tour.length - 1);
      const step = context.tour[index], object = tourObject(step, scene);
      const stage = el("div", undefined, "analysis-tour-stage");
      stage.appendChild(el("p", `汇报步骤 ${index + 1} / ${context.tour.length}`, "analysis-kicker"));
      stage.appendChild(el("h3", object?.name || "对象已移除"));
      stage.appendChild(el("p", step.note || "尚未填写讲解要点"));
      const nav = el("div", undefined, "analysis-toolbar");
      const prev = button("上一步", () => { context.tourIndex--; render(); }); prev.disabled = index === 0;
      const next = button("下一步", () => { context.tourIndex++; render(); }); next.disabled = index === context.tour.length - 1;
      nav.append(prev, next); stage.appendChild(nav); host.appendChild(stage);
      if (object) {
        const lineIds = new Set([step.kind === "line" ? object.id : object.line_id]);
        if (step.kind === "line") for (let i = 0; i < scene.lines.length; i++) {
          for (const line of scene.lines) if (lineIds.has(line.parent_id)) lineIds.add(line.id);
        }
        const taskIds = new Set(step.kind === "task" ? [object.id] : step.kind === "milestone" ? object.acceptance_task_ids :
          scene.tasks.filter(task => lineIds.has(task.line_id)).map(task => task.id));
        const tasks = scene.tasks.filter(task => taskIds.has(task.id));
        tasks.forEach(task => lineIds.add(task.line_id));
        drawMap(host, { ...scene, tasks, lines: scene.lines.filter(line => lineIds.has(line.id)),
          milestones: scene.milestones.filter(item => step.kind === "milestone" ? item.id === object.id : lineIds.has(item.line_id)) },
        { highlight: taskIds });
      } else note(host, "该步骤对象已被移除，可跳到下一步，或结束汇报后移除此步骤。");
      return;
    }
    note(host, `当前路线共 ${context.tour.length} 步。讲解要点在输入后离开文本框时自动保存。`);
    const kindNames = { task: "事务", line: "线", milestone: "里程碑" };
    const list = el("ol", undefined, "analysis-tour-list");
    context.tour.forEach((step, index) => {
      const item = el("li");
      const heading = el("div", undefined, "analysis-tour-heading");
      heading.append(el("span", String(index + 1)), el("strong", tourObject(step, scene)?.name || "对象已移除"),
        el("small", kindNames[step.kind]));
      item.appendChild(heading);
      item.appendChild(el("label", "这一步要讲的重点", "analysis-field-label"));
      const text = el("textarea"); text.value = step.note; text.maxLength = 1000; text.rows = 2;
      text.setAttribute("aria-label", `第 ${index + 1} 步讲解要点`); text.placeholder = "例如：接口已联调完成，当前等待业务验收";
      text.onchange = () => {
        const next = context.tour.map((old, i) => i === index ? { ...old, note: text.value } : old);
        if (save("tour", next)) context.tour = next; else text.value = step.note;
      };
      item.appendChild(text);
      const actions = el("div", undefined, "analysis-toolbar");
      const move = offset => {
        const next = [...context.tour];
        [next[index], next[index + offset]] = [next[index + offset], next[index]];
        if (save("tour", next)) { context.tour = next; render(); }
      };
      const up = button("上移", () => move(-1)); up.disabled = index === 0;
      const down = button("下移", () => move(1)); down.disabled = index === context.tour.length - 1;
      actions.append(up, down, button("移除", () => {
        const next = context.tour.filter((_, i) => i !== index);
        if (save("tour", next)) { context.tour = next; render(); }
      }));
      item.appendChild(actions); list.appendChild(item);
    });
    host.appendChild(list);
  }
  function renderMilestones(host) {
    toolIntro(host, "这个里程碑还差哪些验收事务？",
      "把验收事务按完成、推进、受阻和取消分组。点击事务可以直接打开编辑。",
      ["选择要检查的里程碑", "先看完成进度和受阻数量", "打开受阻事务，处理仍未闭环的前置事项"]);
    if (!state.milestones.length) { dashboardEmpty(host, "暂无里程碑，可在画布的线菜单中添加里程碑并配置验收事务。"); return; }
    const tools = el("div", undefined, "analysis-toolbar");
    const select = el("select"); select.id = "analysis-milestone";
    for (const item of state.milestones) { const option = el("option", `${item.name} · ${item.milestone_date}`); option.value = item.id; select.appendChild(option); }
    if (!state.milestones.some(item => item.id === context.milestoneId)) context.milestoneId = state.milestones[0].id;
    select.value = context.milestoneId;
    labeled(tools, "查看哪个里程碑？", select); host.appendChild(tools);
    select.onchange = () => { context.milestoneId = Number(select.value); render(); };
    const milestone = state.milestones.find(item => item.id === context.milestoneId);
    const tasks = milestone.acceptance_task_ids.map(taskById).filter(Boolean);
    const closed = tasks.filter(task => task.status === "已闭环").length;
    const summary = el("div", undefined, "analysis-callout compact");
    summary.append(el("strong", milestone.name), el("p", `${milestone.target_description || "未填写验收目标"} · 目标日期 ${milestone.milestone_date}`));
    host.appendChild(summary);
    if (!tasks.length) { dashboardEmpty(host, "此里程碑尚未配置验收事务"); return; }
    const groups = new Map([["已闭环", []], ["推进中", []], ["受阻", []], ["已取消", []]]);
    for (const task of tasks) {
      const blocked = prerequisiteIds(task.id).some(id => taskById(id)?.status !== "已闭环");
      groups.get(task.status === "已闭环" ? "已闭环" : task.status === "已取消" ? "已取消" : blocked ? "受阻" : "推进中").push(task);
    }
    metricCards(host, [["验收完成", `${closed} / ${tasks.length}`, "已取消不计为完成"],
      ["推进中", groups.get("推进中").length], ["受阻", groups.get("受阻").length],
      ["已取消", groups.get("已取消").length]]);
    const progressWrap = el("div", undefined, "analysis-progress");
    const progress = el("progress"); progress.max = tasks.length; progress.value = closed;
    progress.setAttribute("aria-label", "里程碑验收完成进度");
    progressWrap.append(progress, el("span", tasks.length ? `完成率 ${Math.round(closed / tasks.length * 100)}%` : "完成率 0%"));
    host.appendChild(progressWrap);
    const grid = el("div", undefined, "analysis-milestone-groups");
    for (const [name, items] of groups) {
      const descriptions = { "已闭环": "已满足验收", "推进中": "当前可继续推进", "受阻": "有前置事务未闭环", "已取消": "不计入验收完成" };
      const group = el("section", undefined, `status-${name}`);
      group.append(el("h3", `${name} · ${items.length}`), el("p", descriptions[name], "analysis-group-help"));
      for (const task of items) {
        const entry = button(`${task.name} · ${taskOwnerText(task, "未分配")} · ${task.status}`, () => openTaskModal(task));
        group.appendChild(entry);
        if (name === "受阻") note(group, "等待：" + prerequisiteIds(task.id).map(taskById)
          .filter(prior => prior && prior.status !== "已闭环").map(prior => prior.name).join("、"));
      }
      if (!items.length) note(group, "暂无事务");
      grid.appendChild(group);
    }
    host.appendChild(grid);
    const ids = new Set(tasks.map(task => task.id));
    const scene = sceneNow();
    mapDetails(host, { ...scene, tasks, lines: scene.lines.filter(line => line.id === milestone.line_id || tasks.some(task => task.line_id === line.id)),
      milestones: [milestone] }, { highlight: ids }, "展开时间图，查看验收事务的位置");
  }
  function drawMap(host, scene, { ghost = null, highlight = new Set(), readonly = false,
    dependencyDirection = "prerequisite", comparisonMode = "overlay", sourceId = null,
    showDependencies = true, openDetails = false } = {}) {
    if (!scene.tasks.length && !scene.lines.length && !ghost?.tasks.length) {
      dashboardEmpty(host, "项目地图为空，创建主线和事务后即可开始分析。"); return;
    }
    const currentIds = new Set(scene.tasks.map(task => task.id));
    const oldTasks = new Map((ghost?.tasks || []).map(task => [task.id, task]));
    const oldMilestones = new Map((ghost?.milestones || []).map(item => [item.id, item]));
    const allTasks = [...scene.tasks, ...(ghost?.tasks || []).filter(task => !currentIds.has(task.id))];
    const lines = [...scene.lines, ...(ghost?.lines || []).filter(line => !scene.lines.some(item => item.id === line.id))];
    const dates = [...allTasks.flatMap(task => [task.start_date, task.end_date]),
      ...(ghost?.tasks || []).flatMap(task => [task.start_date, task.end_date]),
      ...lines.flatMap(line => [line.fork_date, line.merge_date]),
      ...scene.milestones.map(item => item.milestone_date),
      ...(ghost?.milestones || []).map(item => item.milestone_date)].filter(Boolean).sort();
    if (!dates.length) { dashboardEmpty(host, "暂无可绘制的日期"); return; }
    const first = dates[0], last = dates.at(-1);
    const span = Math.max(1, daysBetween(first, last));
    const width = 960, left = 220, right = comparisonMode === "delay" ? 70 : 35;
    const x = value => left + daysBetween(first, value) / span * (width - left - right);
    const rows = [];
    for (const line of lines) {
      rows.push({ kind: "line", item: line });
      allTasks.filter(task => task.line_id === line.id).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id)
        .forEach(task => rows.push({ kind: "task", item: task }));
      scene.milestones.filter(item => item.line_id === line.id).forEach(item => rows.push({ kind: "milestone", item }));
    }
    const height = 60 + rows.length * 36;
    const wrap = el("div", undefined, "analysis-map"); wrap.tabIndex = 0;
    wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "可滚动项目地图");
    const delayComparison = comparisonMode === "delay";
    const dependencyDescription = dependencyDirection === "downstream" ? "箭头表示延期传递方向" : "箭头指向前置事务";
    const mapDescription = delayComparison ? "延期影响甘特图，灰色为原计划，蓝色为推演后，橙色为指定事务新增时间" :
      `项目时间地图，${dependencyDescription}，虚线为比较计划`;
    const svg = dashboardSvg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group",
      "aria-label": mapDescription }, wrap);
    let markerId = null;
    if (showDependencies) {
      const defs = dashboardSvg("defs", {}, svg);
      markerId = `analysis-arrow-${++mapSequence}`;
      const marker = dashboardSvg("marker", { id: markerId, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
      dashboardSvg("path", { d: "M0 0 L8 4 L0 8 Z", fill: "#8c959f" }, marker);
    }
    const ticks = new Set(Array.from({ length: 5 }, (_, i) => Math.round(span * i / 4)));
    for (const offset of ticks) {
      const tickDate = dashboardDateIso(dashboardAddDays(first, offset));
      const px = x(tickDate);
      dashboardSvg("line", { x1: px, x2: px, y1: 28, y2: height, class: "analysis-gridline" }, svg);
      dashboardSvg("text", { x: px, y: 18, "text-anchor": "middle", class: "analysis-axis" }, svg).textContent =
        tickDate;
    }
    const positions = new Map();
    rows.forEach((row, index) => { if (row.kind === "task" && currentIds.has(row.item.id)) positions.set(row.item.id, { x: x(row.item.start_date), y: 48 + index * 36 }); });
    for (const edge of showDependencies ? scene.dependencies : []) {
      const fromId = dependencyDirection === "downstream" ? edge.prerequisite_task_id : edge.dependent_task_id;
      const toId = dependencyDirection === "downstream" ? edge.dependent_task_id : edge.prerequisite_task_id;
      const from = positions.get(fromId), to = positions.get(toId);
      if (from && to) dashboardSvg("path", { d: `M${from.x} ${from.y} C${from.x + 30} ${from.y},${to.x + 30} ${to.y},${to.x + 7} ${to.y}`,
        class: "analysis-edge", "marker-end": `url(#${markerId})` }, svg);
    }
    const info = el("p", delayComparison ? "点击泳道查看原计划与推演后的准确日期" : "点击节点查看日期与状态", "analysis-map-info");
    info.setAttribute("aria-live", "polite");
    const openRowDetails = (kind, id) => {
      const task = kind === "task" ? taskById(id) : null;
      const milestone = kind === "milestone" ? state.milestones.find(item => item.id === id) : null;
      if (!task && !milestone) return;
      const interaction = {
        mapLeft: wrap.scrollLeft, mapTop: wrap.scrollTop,
        pageX: window.scrollX, pageY: window.scrollY,
      };
      const restore = () => requestAnimationFrame(() => {
        const nextWrap = document.querySelector(".analysis-delay-gantt .analysis-map");
        if (!nextWrap) return;
        nextWrap.scrollLeft = interaction.mapLeft;
        nextWrap.scrollTop = interaction.mapTop;
        window.scrollTo(interaction.pageX, interaction.pageY);
        const target = nextWrap.querySelector(`[data-analysis-kind="${kind}"][data-analysis-id="${id}"]`);
        (target || nextWrap).focus({ preventScroll: true });
      });
      if (task) openTaskModal(task, task.line_id, false, { onClosed: restore });
      else openMilestoneModal(milestone, milestone.line_id, null, { onClosed: restore });
    };
    const lineY = new Map(rows.map((row, i) => [row, i]).filter(([row]) => row.kind === "line")
      .map(([row, i]) => [row.item.id, 48 + i * 36]));
    rows.forEach((row, index) => {
      const item = row.item, y = 48 + index * 36;
      const group = dashboardSvg("g", {}, svg);
      const removed = row.kind === "task" && !currentIds.has(item.id);
      const shortName = item.name.length > 15 ? item.name.slice(0, 15) + "…" : item.name;
      const isSource = delayComparison && row.kind === "task" && item.id === sourceId;
      if (isSource) dashboardSvg("rect", { x: 0, y: y - 16, width, height: 32, class: "analysis-delay-source-row" }, group);
      const label = dashboardSvg("text", { x: 8, y: y + 4,
        class: `analysis-row-label ${row.kind === "line" ? "analysis-line-label" : ""}${isSource ? " analysis-source-label" : ""}` }, group);
      label.textContent = `${isSource ? "延期起点 · " : row.kind === "line" ? `${item.parent_id === null ? "主线" : "支线"} · ` : row.kind === "milestone" ? "★ " : ""}${shortName}${removed ? "（已移除）" : ""}`;
      let description;
      if (row.kind === "line") {
        if (!delayComparison) {
          const start = x(item.fork_date), end = item.merge_date ? x(item.merge_date) : width - right;
          dashboardSvg("line", { x1: start, x2: end, y1: y, y2: y, stroke: item.color || "#8c959f", "stroke-width": 2 }, group);
          if (lineY.has(item.parent_id)) dashboardSvg("line", { x1: start, x2: start, y1: lineY.get(item.parent_id), y2: y, class: "analysis-edge" }, group);
          dashboardSvg("circle", { cx: start, cy: y, r: 4, fill: item.color || "#8c959f" }, group);
          if (item.merge_date) dashboardSvg("circle", { cx: end, cy: y, r: 5, class: "analysis-ghost" }, group);
        }
        description = `${item.name} · 起始 ${item.fork_date}${item.merge_date ? ` · 反合 ${item.merge_date}` : ""}`;
      } else if (row.kind === "milestone") {
        const prior = oldMilestones.get(item.id);
        if (delayComparison) {
          const oldDate = prior?.milestone_date || item.milestone_date;
          dashboardSvg("circle", { cx: x(oldDate), cy: y - 4, r: 4, class: "analysis-milestone-before" }, group);
          dashboardSvg("rect", { x: x(item.milestone_date) - 5, y: y + 1, width: 10, height: 10,
            transform: `rotate(45 ${x(item.milestone_date)} ${y + 6})`, class: "analysis-milestone-after" }, group);
          const amount = Math.max(0, daysBetween(oldDate, item.milestone_date));
          if (amount) dashboardSvg("text", { x: Math.min(width - 34, x(item.milestone_date) + 10), y: y + 5,
            class: "analysis-delay-value" }, group).textContent = `+${amount}天`;
        } else if (prior && prior.milestone_date !== item.milestone_date) {
          dashboardSvg("line", { x1: x(prior.milestone_date), x2: x(item.milestone_date), y1: y, y2: y,
            class: "analysis-ghost" }, group);
          dashboardSvg("text", { x: x(prior.milestone_date), y: y + 6,
            class: "analysis-star analysis-star-ghost", "text-anchor": "middle" }, group).textContent = "☆";
        }
        if (!delayComparison) dashboardSvg("text", { x: x(item.milestone_date), y: y + 6, class: "analysis-star", "text-anchor": "middle" }, group).textContent = "★";
        description = `${item.name} · 目标 ${prior && prior.milestone_date !== item.milestone_date ?
          `${prior.milestone_date} → ${item.milestone_date}` : item.milestone_date} · ${item.acceptance_task_ids.length} 项验收事务`;
      } else {
        const prior = oldTasks.get(item.id);
        if (delayComparison && prior && !removed) {
          const priorEnd = prior.end_date || prior.start_date;
          const currentEnd = item.end_date || item.start_date;
          dashboardSvg("rect", { x: x(prior.start_date) - 4, y: y - 8,
            width: Math.max(8, x(priorEnd) - x(prior.start_date) + 8), height: 5, rx: 3,
            class: "analysis-plan-before" }, group);
          dashboardSvg("rect", { x: x(item.start_date) - 4, y: y + 1,
            width: Math.max(8, x(currentEnd) - x(item.start_date) + 8), height: 8, rx: 4,
            class: "analysis-plan-after" }, group);
          const amount = Math.max(0, daysBetween(isSource ? priorEnd : prior.start_date,
            isSource ? currentEnd : item.start_date));
          if (isSource && amount) dashboardSvg("rect", { x: x(priorEnd), y: y + 1,
            width: Math.max(3, x(currentEnd) - x(priorEnd) + 4), height: 8, rx: 4,
            class: "analysis-delay-extension" }, group);
          if (amount) dashboardSvg("text", { x: Math.min(width - 34, x(currentEnd) + 10), y: y + 7,
            class: "analysis-delay-value" }, group).textContent = `+${amount}天`;
        } else if (prior) {
          dashboardSvg("rect", { x: x(prior.start_date) - 4, y: y - 9, width: Math.max(8, x(prior.end_date || prior.start_date) - x(prior.start_date) + 8), height: 18, rx: 5, class: "analysis-ghost" }, group);
          if (prior.start_date !== item.start_date) dashboardSvg("line", { x1: x(prior.start_date), x2: x(item.start_date), y1: y, y2: y, class: "analysis-ghost" }, group);
        }
        if (!removed && !delayComparison) {
          const color = statusColor(item.status);
          dashboardSvg("rect", { x: x(item.start_date) - 4, y: y - 5, width: Math.max(8, x(item.end_date || item.start_date) - x(item.start_date) + 8), height: 10, rx: 5, fill: color, opacity: .5 }, group);
          if (highlight.has(item.id)) dashboardSvg("circle", { cx: x(item.start_date), cy: y, r: 11, class: "analysis-highlight" }, group);
          dashboardSvg("circle", { cx: x(item.start_date), cy: y, r: 5, fill: color }, group);
        }
        description = delayComparison && prior ? `${isSource ? "延期起点" : "受影响事务"} · ${item.name} · 原计划 ${prior.start_date} → ${prior.end_date || "未设结束日期"} · 推演后 ${item.start_date} → ${item.end_date || "未设结束日期"}` :
          `${item.name}${removed ? "（已移除）" : ""} · ${item.status} · ${taskOwnerText(item, "未分配")} · ${item.start_date} → ${item.end_date || "未设结束日期"}`;
      }
      dashboardSvg("title", {}, group).textContent = description;
      group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", description);
      const canOpenDetails = openDetails && !removed && ["task", "milestone"].includes(row.kind);
      if (canOpenDetails) {
        group.classList.add("analysis-openable-row");
        group.dataset.analysisKind = row.kind;
        group.dataset.analysisId = item.id;
        group.setAttribute("aria-label", `${description} · 双击或按回车打开详情`);
      }
      const activate = () => { info.textContent = description; };
      group.onclick = activate;
      group.onkeydown = event => {
        if (event.key === "Enter" && canOpenDetails) { event.preventDefault(); openRowDetails(row.kind, item.id); }
        else if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); }
      };
      if (canOpenDetails) group.ondblclick = event => {
        event.preventDefault();
        openRowDetails(row.kind, item.id);
      };
      if (!readonly && row.kind === "task" && !removed) group.ondblclick = () => { const task = taskById(item.id); if (task) openTaskModal(task); };
    });
    host.append(wrap, info);
  }
  document.querySelector(".dashboard-supporting").addEventListener("toggle", event => {
    if (event.target.open) render(); else { stop(); epoch++; }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  return { render, reset, stop, invalidateHistory, simulateDelay, compareScenes };
})();
