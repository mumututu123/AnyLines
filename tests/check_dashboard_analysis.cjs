// Run with node tests/check_dashboard_analysis.cjs.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../static/dashboard-analysis.js'), 'utf8');
const sandbox = vm.createContext({
  document: { querySelector: () => ({ addEventListener() {} }), addEventListener() {} },
  dashboardDateIso: value => value.toISOString().slice(0, 10),
  dashboardAddDays: (value, days) => new Date(Date.parse(value) + days * 86400000),
  daysBetween: (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000),
});
const analysis = vm.runInContext(source + '\nDashboardAnalysis;', sandbox);
const task = (id, start, end, status = '进行中') => ({
  id, name: `Task ${id}`, status, start_date: `2026-09-${start}`, end_date: `2026-09-${end}`,
});
const edge = (from, to) => ({ prerequisite_task_id: from, dependent_task_id: to });
const scene = {
  lines: [], tasks: [task(1, '01', '03'), task(2, '04', '06'), task(3, '05', '07'),
    task(4, '08', '10'), task(5, '11', '13', '已闭环'), task(6, '14', '16'),
    task(7, '02', '04'), task(8, '25', '26')],
  dependencies: [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4), edge(4, 5), edge(5, 6), edge(1, 7), edge(1, 8)],
  milestones: [{ id: 1, milestone_date: '2026-09-11', acceptance_task_ids: [4] }],
};
const before = JSON.stringify(scene);
const result = analysis.simulateDelay(scene, 1, 5);
assert.deepEqual(Array.from(result.shifts, pair => Array.from(pair)), [[1, 5], [2, 4], [3, 3], [7, 5], [4, 2]]);
assert.equal(result.scene.tasks.find(item => item.id === 1).start_date, '2026-09-01', 'Delayed source keeps its start date');
assert.equal(result.scene.tasks.find(item => item.id === 1).end_date, '2026-09-08', 'Delayed source extends only its end date');
assert.equal(result.scene.tasks.find(item => item.id === 2).start_date, '2026-09-08', 'Affected downstream task shifts its start date');
assert.equal(result.scene.tasks.find(item => item.id === 2).end_date, '2026-09-10', 'Affected downstream task keeps its duration');
assert.equal(result.milestones[0].days, 1);
assert.equal(result.milestones[0].projected_date, '2026-09-12');
assert.equal(JSON.stringify(scene), before, 'Simulation must not mutate the actual plan');
assert.equal(analysis.simulateDelay(scene, 1, 0).shifts.size, 0);
assert.equal(analysis.simulateDelay(scene, 5, 5).shifts.size, 0);
assert.equal(analysis.simulateDelay(scene, 999, 5).shifts.size, 0);
assert.equal(analysis.simulateDelay(scene, 1, 2.5).shifts.size, 0);
const cycle = { ...scene, dependencies: [...scene.dependencies, edge(4, 1)] };
assert.throws(() => analysis.simulateDelay(cycle, 1, 1), /循环/);
const diamond = { ...scene, tasks: [task(1, '01', '03'), task(2, '03', '05'), task(3, '03', '05'), task(4, '05', '07')],
  dependencies: [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)] };
assert.equal(analysis.simulateDelay(diamond, 1, 3).shifts.get(4), 3, 'Merged branches must not double count delays');
const changes = analysis.compareScenes(scene, { ...scene,
  tasks: scene.tasks.filter(item => item.id !== 8).map(item => item.id === 1 ? { ...item, name: 'Renamed' } : item),
  dependencies: scene.dependencies.slice(1),
});
assert.equal(changes.length, 3);
assert.equal(changes.filter(item => item.type === '移除').length, 2);
assert.equal(changes.find(item => item.type === '调整').fields[0].label, '名称');
console.log('Dashboard analysis checks passed: buffers, merged branches, existing conflicts, closed barriers, milestone dates, zero/invalid input, cycles, immutable plan and change comparison.');
