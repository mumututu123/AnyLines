// Run with node --experimental-websocket tests/check_dashboard_analysis_ui.cjs (Chrome installed).
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = mkdtempSync(path.join(tmpdir(), 'anyline-analysis-ui-'));
  const db = path.join(temporary, 'test.db');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('python', ['-m', 'flask', 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, FLASK_APP: 'app', ANYLINE_DB_PATH: db,
      ANYLINE_ADMIN_USERNAME: 'admin', ANYLINE_ADMIN_PASSWORD: 'admin123' },
  });
  let browser, socket, sequence = 0;
  const pending = new Map(), errors = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timeout = setTimeout(() => {
    for (const p of pending.values()) p.reject(new Error('Browser check timed out'));
    socket?.close(); browser?.kill(); server.kill(); process.exitCode = 1;
  }, 60000);
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await delay(100);
    }
    browser = spawn(process.env.ANYLINE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(temporary, 'browser')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', error => { errors.push(error.message); });
    let address;
    for (let i = 0; i < 100; i++) {
      try {
        const [debugPort, endpoint] = readFileSync(path.join(temporary, 'browser', 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
        address = `ws://127.0.0.1:${debugPort}${endpoint}`; break;
      } catch {}
      await delay(100);
    }
    if (!address) throw new Error('Chrome debugging endpoint unavailable');
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(data.params.exceptionDetails));
      if (pending.has(data.id)) {
        const p = pending.get(data.id); pending.delete(data.id);
        data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const callTimeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method} ${JSON.stringify(params).slice(0, 250)}`)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(callTimeout); resolve(value); },
        reject: error => { clearTimeout(callTimeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Runtime.enable'); await cdp('Page.enable');
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
      throw new Error(`Timed out: ${expression}`);
    };
    const clickText = text => evaluate(`(() => {
      const button = [...document.querySelectorAll('#analysis-panel button')].find(item => item.textContent === ${JSON.stringify(text)});
      if (!button) throw new Error('Button missing: ' + ${JSON.stringify(text)});
      button.click();
    })()`);
    const tab = mode => evaluate(`document.querySelector('#analysis-tab-${mode}').click()`);
    await cdp('Page.navigate', { url: base });
    console.log('Browser loaded; signing in.');
    await until(`document.querySelector('#login-username') && !document.body.classList.contains('auth-pending')`);
    await evaluate(`document.querySelector('#login-username').value = 'admin'; document.querySelector('#login-password').value = 'admin123'; document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated') && state.today`);
    console.log('Signed in; creating fixture.');
    await evaluate(`(async () => {
      const line = await api('/api/lines', 'POST', { name: '发布主线', fork_date: '2026-09-01' });
      const branch = await api('/api/lines', 'POST', { name: '交付支线', parent_id: line.id, fork_date: '2026-09-01' });
      const create = (name, start, end, extra = {}) => api('/api/tasks', 'POST', {
        line_id: line.id, name, content: '内容', owner: '系统管理员', status: '进行中',
        start_date: start, end_date: end, ...extra,
      });
      const first = await create('方案确认', '2026-09-01', '2026-09-03');
      const next = await create('联调验收', '2026-09-04', '2026-09-06', { line_id: branch.id, prerequisite_ids: [first.id] });
      await create('完成事项', '2026-09-02', '2026-09-04', { status: '已闭环' });
      const cancelled = await create('取消事项', '2026-09-01', '2026-09-05', { status: '已取消' });
      await api('/api/milestones', 'POST', { line_id: branch.id, name: '正式发布', milestone_date: '2026-09-07',
        target_description: '验收通过', acceptance_task_ids: [next.id, cancelled.id] });
      await api('/api/workspaces/' + state.currentWorkspace.id + '/members', 'POST', {
        username: 'reader', display_name: 'Reader', password: 'member123', role: 'member'
      });
      await reload(); switchView('dashboard'); document.querySelector('.dashboard-supporting').open = true;
    })()`);
    execFileSync('python', ['-c', "import sqlite3,sys; from datetime import date,timedelta; db=sqlite3.connect(sys.argv[1]); today=date.today().isoformat(); yesterday=(date.today()-timedelta(days=1)).isoformat(); db.execute('INSERT INTO dashboard_snapshots SELECT workspace_id,?,total,done,overdue,risk,blocked,status_counts,scene,captured_at FROM dashboard_snapshots WHERE snapshot_date=?',(yesterday,today)); db.commit(); db.close()", db], { windowsHide: true });
    await evaluate(`DashboardAnalysis.invalidateHistory(); reload()`);
    await until(`document.querySelectorAll('#analysis-tabs button').length === 6`);
    console.log('Checking analysis tools.');
    assert.equal(await evaluate(`document.querySelectorAll('#analysis-tabs small').length`), 6);
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('还没有可比较的确认点'));
    assert.equal(await evaluate(`Object.keys(localStorage).some(key => key.endsWith('.visit'))`), false);
    await clickText('与最近一个记录日比较');
    await until(`document.querySelector('#analysis-panel').textContent.includes('变化总数')`);
    assert.equal(await evaluate(`Object.keys(localStorage).some(key => key.endsWith('.visit'))`), true);
    await clickText('全部已看，重新从现在记录');
    await tab('baseline'); await clickText('用最早的历史记录作基线');
    await until(`document.querySelector('#analysis-panel').textContent.includes('全部差异')`);
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('当前计划与原定计划差了多少'));
    await evaluate(`api('/api/tasks/1', 'PATCH', { start_date: '2026-09-02', name: '<img src=x onerror=alert(1)>方案改期' }).then(reload)`);
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('改期事务1'));
    assert.equal(await evaluate(`document.querySelectorAll('#analysis-panel img').length`), 0);
    await tab('changes');
    await evaluate(`api('/api/tasks/1', 'PATCH', { name: '方案再次调整' }).then(reload)`);
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('方案再次调整'));
    await tab('delay');
    await until(`document.querySelector('.analysis-delay-gantt .analysis-map svg')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#analysis-panel button')].some(item => item.textContent === '3. 查看影响')`), false);
    assert.ok((await evaluate(`document.querySelector('#analysis-delay-result').textContent`)).includes('受影响事务2'));
    assert.ok((await evaluate(`document.querySelector('.analysis-delay-gantt svg').textContent`)).includes('主线 · 发布主线'));
    assert.ok((await evaluate(`document.querySelector('.analysis-delay-gantt svg').textContent`)).includes('支线 · 交付支线'));
    assert.equal(await evaluate(`document.querySelectorAll('.analysis-delay-gantt .analysis-edge, .analysis-delay-gantt .analysis-ghost').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('.analysis-delay-gantt .analysis-plan-before').length`), 2);
    assert.equal(await evaluate(`document.querySelectorAll('.analysis-delay-gantt .analysis-delay-extension').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('.analysis-delay-gantt .analysis-milestone-before').length`), 1);
    assert.ok((await evaluate(`document.querySelector('.analysis-delay-gantt svg').textContent`)).includes('延期起点 · 方案再次调整'));
    assert.equal(await evaluate(`state.tasks.find(item => item.id === 2).start_date`), '2026-09-04');
    await evaluate(`(() => {
      const map = document.querySelector('.analysis-delay-gantt .analysis-map');
      map.scrollLeft = 90;
      map.querySelector('[data-analysis-kind="task"][data-analysis-id="1"]')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()`);
    await until(`!document.querySelector('#modal-mask').classList.contains('hidden') && document.querySelector('#modal-title').textContent === '编辑事务'`);
    assert.equal(await evaluate(`document.querySelector('#modal-body')._name.value`), '方案再次调整');
    await evaluate(`document.querySelector('#modal-ok').click()`);
    await until(`document.querySelector('#modal-mask').classList.contains('hidden') && document.querySelector('.analysis-delay-gantt [data-analysis-kind="task"][data-analysis-id="1"]')`);
    await delay(100);
    assert.equal(await evaluate(`document.querySelector('#analysis-tab-delay').getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(`document.querySelector('#analysis-delay-days').value`), '3');
    assert.equal(await evaluate(`document.activeElement?.dataset.analysisId`), '1');
    assert.equal(await evaluate(`document.querySelector('.analysis-delay-gantt .analysis-map').scrollLeft`), 90);
    await evaluate(`document.querySelector('.analysis-delay-gantt [data-analysis-kind="milestone"][data-analysis-id="1"]')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until(`!document.querySelector('#modal-mask').classList.contains('hidden') && document.querySelector('#modal-title').textContent === '编辑里程碑'`);
    assert.equal(await evaluate(`document.querySelector('#modal-body')._name.value`), '正式发布');
    await evaluate(`document.querySelector('#modal-cancel').click()`);
    await until(`document.querySelector('#modal-mask').classList.contains('hidden')`);
    await delay(50);
    assert.equal(await evaluate(`document.activeElement?.dataset.analysisKind`), 'milestone');
    await evaluate(`document.querySelector('#analysis-delay-days').value = '-1'; document.querySelector('#analysis-delay-days').dispatchEvent(new Event('input'))`);
    assert.ok((await evaluate(`document.querySelector('#analysis-delay-result').textContent`)).includes('整数'));
    await evaluate(`document.querySelector('#analysis-delay-days').value = '0'; document.querySelector('#analysis-delay-days').dispatchEvent(new Event('input'))`);
    assert.ok((await evaluate(`document.querySelector('#analysis-delay-result').textContent`)).includes('受影响事务0'));
    await tab('milestones');
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('受阻 · 1'));
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('已取消 · 1'));
    assert.equal(await evaluate(`document.querySelector('#analysis-panel progress').value`), 0);
    await tab('tour'); await clickText('添加步骤');
    await evaluate(`document.querySelector('#analysis-panel textarea').value = '先讲清本周卡点'; document.querySelector('#analysis-panel textarea').dispatchEvent(new Event('change'));
      document.querySelector('#analysis-tour-target').value = 'milestone:1';`);
    await clickText('添加步骤'); await clickText('开始汇报');
    assert.ok((await evaluate(`document.querySelector('.analysis-tour-stage').textContent`)).includes('先讲清本周卡点'));
    await clickText('下一步');
    assert.ok((await evaluate(`document.querySelector('.analysis-tour-stage').textContent`)).includes('正式发布'));
    await clickText('结束汇报'); await clickText('上移');
    // A failed history request must expose retry, and a late response must not replace another tab.
    await evaluate(`window.analysisOriginalFetch = window.fetch; window.fetch = function(url, options) {
      if (url === '/api/dashboard/history') return Promise.resolve(new Response(JSON.stringify({ error: '模拟读取失败' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      return window.analysisOriginalFetch(url, options);
    }; DashboardAnalysis.invalidateHistory()`);
    await tab('replay'); await until(`document.querySelector('#analysis-panel').textContent.includes('历史读取失败')`);
    await evaluate(`window.fetch = window.analysisOriginalFetch`);
    await clickText('重试'); await until(`document.querySelector('#analysis-history-result svg')`);
    await tab('baseline');
    await evaluate(`window.fetch = function(url, options) {
      if (url === '/api/dashboard/history') return new Promise(resolve => { window.releaseAnalysisHistory = () => resolve(window.analysisOriginalFetch(url, options)); });
      return window.analysisOriginalFetch(url, options);
    }; DashboardAnalysis.invalidateHistory()`);
    await tab('replay'); await tab('baseline');
    await evaluate(`window.releaseAnalysisHistory(); window.fetch = window.analysisOriginalFetch`);
    await delay(100);
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('当前计划与原定计划差了多少'));
    await tab('replay'); await until(`document.querySelector('#analysis-history-result svg')`);
    console.log('Checking history playback and persistence.');
    assert.equal(await evaluate(`document.querySelector('#analysis-play').disabled`), false);
    await evaluate(`reload()`); await until(`document.querySelectorAll('#analysis-history-date option').length === 2 && document.querySelector('#analysis-history-result svg')`);
    await clickText('播放');
    await until(`document.querySelector('#analysis-play').textContent === '暂停'`);
    await evaluate(`document.querySelector('.dashboard-supporting').open = false`);
    await until(`document.querySelector('#analysis-play').textContent === '播放'`);
    await evaluate(`document.querySelector('.dashboard-supporting').open = true`);
    await tab('baseline');
    await cdp('Page.reload');
    await until(`typeof state !== 'undefined' && state.today && document.body.classList.contains('authenticated')`);
    await evaluate(`document.querySelector('.dashboard-supporting').open = true`);
    await until(`document.querySelector('#analysis-tab-baseline')`);
    await tab('baseline');
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('改期事务1'));
    await tab('tour'); assert.equal(await evaluate(`document.querySelectorAll('.analysis-tour-list li').length`), 2);
    // Quota errors must be visible and must not claim a successful save.
    await tab('baseline');
    await evaluate(`window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new DOMException('Full', 'QuotaExceededError'); }`);
    await clickText('确认新计划，更新基线');
    assert.ok((await evaluate(`document.querySelector('#toast').textContent`)).includes('未保存'));
    await evaluate(`Storage.prototype.setItem = window.originalSetItem`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    console.log('Checking responsive layouts and themes.');
    for (const mode of ['changes', 'baseline', 'delay', 'tour', 'milestones', 'replay']) {
      await tab(mode);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, mode);
    }
    await tab('delay');
    await evaluate(`document.querySelector('#analysis-delay-days').value = '3'; document.querySelector('#analysis-delay-days').dispatchEvent(new Event('input')); applyTheme('dark')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.analysis-delay-gantt .analysis-map')).backgroundColor`), 'rgb(22, 27, 34)');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`applyTheme('light'); document.querySelector('#toast').classList.add('hidden'); document.querySelector('#analysis-delay-days').value = '3'; document.querySelector('#analysis-delay-days').dispatchEvent(new Event('input')); document.querySelector('#dashboard-analysis').scrollIntoView()`);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(temporary, 'dashboard-analysis.png');
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot: ' + screenshotPath);
    await evaluate(`(async () => { await api('/api/workspaces', 'POST', { name: '另一个空间' }); resetWorkspaceState(); await refreshSession(); await reload(); })()`);
    await tab('baseline');
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('保存当前计划作为基线'));
    await tab('tour'); assert.equal(await evaluate(`document.querySelectorAll('.analysis-tour-list li').length`), 0);
    await tab('milestones'); assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('暂无里程碑'));
    await evaluate(`document.querySelector('#btn-logout').click()`);
    await until(`!document.body.classList.contains('authenticated')`);
    await evaluate(`document.querySelector('#login-username').value = 'reader'; document.querySelector('#login-password').value = 'member123'; document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated') && state.user?.username === 'reader' && state.tasks.length > 0`);
    await evaluate(`switchView('dashboard'); document.querySelector('.dashboard-supporting').open = true; DashboardAnalysis.render()`);
    await tab('baseline');
    assert.ok((await evaluate(`document.querySelector('#analysis-panel').textContent`)).includes('保存当前计划作为基线'));
    await tab('replay'); await until(`document.querySelector('#analysis-history-result svg')`);
    assert.equal(await evaluate(`fetch('/api/audit').then(response => response.status)`), 403);
    assert.deepEqual(errors, []);
    console.log('Dashboard browser checks passed: six tools, persisted baseline/tour, changes, delay preview, replay/playback, milestone cancellation, XSS text, quota feedback, themes/mobile, account/workspace isolation, member history access.');
  } finally {
    clearTimeout(timeout); socket?.close(); browser?.kill(); server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
