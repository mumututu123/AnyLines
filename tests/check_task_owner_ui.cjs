// Run with node --experimental-websocket tests/check_task_owner_ui.cjs (Chrome installed).
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = mkdtempSync(path.join(tmpdir(), 'anyline-owner-ui-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('python', ['-m', 'flask', 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: {
      ...process.env,
      FLASK_APP: 'app',
      ANYLINE_DB_PATH: path.join(temporary, 'test.db'),
      ANYLINE_ADMIN_USERNAME: 'admin',
      ANYLINE_ADMIN_PASSWORD: 'admin123',
    },
  });
  let browser, socket, sequence = 0, currentStep = 'starting server';
  const pending = new Map();
  const runtimeErrors = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timeout = setTimeout(() => {
    for (const request of pending.values()) request.reject(new Error(`Browser check timed out: ${currentStep}`));
    socket?.close(); browser?.kill(); server.kill(); process.exitCode = 1;
  }, 45000);
  try {
    currentStep = 'waiting for server';
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await delay(100);
    }
    currentStep = 'starting Chrome';
    browser = spawn(
      process.env.ANYLINE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(temporary, 'browser')}`, 'about:blank'],
      { windowsHide: true, stdio: 'ignore' }
    );
    let address;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [debugPort, endpoint] = readFileSync(
          path.join(temporary, 'browser', 'DevToolsActivePort'), 'utf8'
        ).trim().split(/\r?\n/);
        address = `ws://127.0.0.1:${debugPort}${endpoint}`;
        break;
      } catch {}
      await delay(100);
    }
    if (!address) throw new Error('Chrome debugging endpoint unavailable');
    currentStep = 'connecting to Chrome';
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(data.params.exceptionDetails.text || 'Runtime.exceptionThrown');
      }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    currentStep = 'creating browser target';
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async selector => {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit !== element && !element.contains(hit)) {
          throw new Error('Element is covered: ' + ${JSON.stringify(selector)} +
            ' hit=' + (hit?.className || hit?.tagName || 'none') +
            ' rect=' + JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
        }
        return { x, y };
      })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y,
        button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y,
        button: 'left', clickCount: 1 });
    };
    const dragBefore = async (sourceSelector, targetSelector) => {
      const points = await evaluate(`(() => {
        const source = document.querySelector(${JSON.stringify(sourceSelector)});
        const target = document.querySelector(${JSON.stringify(targetSelector)});
        if (!source || !target) throw new Error('Missing drag element');
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        const sourceRect = source.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          source: { x: sourceRect.left + 10, y: sourceRect.top + sourceRect.height / 2 },
          target: { x: targetRect.left + 2, y: targetRect.top + targetRect.height / 2 },
        };
      })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...points.source,
        button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 8; step++) {
        await cdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: points.source.x + (points.target.x - points.source.x) * step / 8,
          y: points.source.y + (points.target.y - points.source.y) * step / 8,
          button: 'left', buttons: 1,
        });
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points.target,
        button: 'left', buttons: 0, clickCount: 1 });
      await delay(50);
    };
    const ownerSelector = name =>
      `#modal-body .owner-picker-options label:has(input[value=${JSON.stringify(name)}])`;
    const ownerChipSelector = name =>
      `#modal-body .owner-picker-chip[data-owner=${JSON.stringify(name)}]`;

    currentStep = 'loading login page';
    await cdp('Page.navigate', { url: base });
    await until(`document.querySelector('#login-username') && !document.body.classList.contains('auth-pending')`);
    currentStep = 'signing in';
    await evaluate(`document.querySelector('#login-username').value = 'admin';
      document.querySelector('#login-password').value = 'admin123';
      document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated') && state.today`);
    currentStep = 'creating members and opening new task';
    await evaluate(`(async () => {
      window.ownerTestLine = await api('/api/lines', 'POST', {
        name: '多责任人交互测试', fork_date: state.today
      });
      await api('/api/workspaces/' + state.currentWorkspace.id + '/members', 'POST', {
        username: 'owner_peer', display_name: '协作成员', password: 'member123', role: 'member'
      });
      await api('/api/workspaces/' + state.currentWorkspace.id + '/members', 'POST', {
        username: 'owner_later', display_name: '后续成员', password: 'member123', role: 'member'
      });
      await reload();
      switchView('table');
    })()`);
    await click('#btn-table-add');
    await until(`document.querySelector('#modal-title').textContent.startsWith('新建事务') &&
      document.querySelectorAll('#modal-body .owner-picker-options input').length === 3`);

    currentStep = 'selecting owners in new task';
    await click('#modal-body .owner-picker > summary');
    await until(`document.querySelector('#modal-body .owner-picker').open`);
    await click(ownerSelector('协作成员'));
    assert.equal(await evaluate(`document.querySelector('#modal-body .owner-picker').open`), true);
    await click(ownerSelector('系统管理员'));
    assert.equal(await evaluate(`document.querySelector('#modal-body .owner-picker').open`), true);
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['协作成员', '系统管理员']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#modal-body .owner-picker-chip-name')]
      .map(element => element.textContent)`), ['协作成员', '系统管理员']);
    assert.equal(await evaluate(`document.querySelectorAll(
      '#modal-body .owner-picker-chip-remove').length`), 2);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(
      ownerChipSelector('系统管理员')
    )}).getAttribute('role')`), 'button');
    currentStep = 'reordering owners in new task';
    await dragBefore(ownerChipSelector('系统管理员'), ownerChipSelector('协作成员'));
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['系统管理员', '协作成员']);
    await evaluate(`(() => {
      const body = document.querySelector('#modal-body');
      body._name.value = '多人负责的新事务';
      body._content.value = '验证新建事务责任人多选';
      body._start.value = state.today;
      body._end.value = state.today;
    })()`);
    currentStep = 'saving new task';
    await click('#modal-ok');
    await until(`document.querySelector('#modal-mask').classList.contains('hidden') &&
      state.tasks.some(task => task.name === '多人负责的新事务')`);
    assert.deepEqual(await evaluate(`state.tasks.find(task => task.name === '多人负责的新事务').owners`),
      ['系统管理员', '协作成员']);

    currentStep = 'opening task for edit';
    await evaluate(`switchView('canvas'); render()`);
    await until(`document.querySelector('.task-node[data-task-id="' +
      state.tasks.find(task => task.name === '多人负责的新事务').id + '"]')`);
    await evaluate(`(() => {
      const task = state.tasks.find(item => item.name === '多人负责的新事务');
      document.querySelector('.task-node[data-task-id="' + task.id + '"]')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()`);
    await until(`document.querySelector('#modal-title').textContent === '编辑事务'`);
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['系统管理员', '协作成员']);
    currentStep = 'changing owners in edit task';
    await click('#modal-body .owner-picker > summary');
    await until(`document.querySelector('#modal-body .owner-picker').open`);
    await click(ownerSelector('后续成员'));
    assert.equal(await evaluate(`document.querySelector('#modal-body .owner-picker').open`), true);
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['系统管理员', '协作成员', '后续成员']);
    currentStep = 'removing and reordering owners in edit task';
    await click(`${ownerChipSelector('协作成员')} .owner-picker-chip-remove`);
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['系统管理员', '后续成员']);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(
      '#modal-body .owner-picker-options input[value="协作成员"]'
    )}).checked`), false);
    await dragBefore(ownerChipSelector('后续成员'), ownerChipSelector('系统管理员'));
    assert.deepEqual(await evaluate(`selectedOwnerNames(document.querySelector('#modal-body')._owner)`),
      ['后续成员', '系统管理员']);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(temporary, 'task-owner-picker.png');
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log('Owner picker screenshot: ' + screenshotPath);
    currentStep = 'saving edited task';
    await click('#modal-ok');
    await until(`document.querySelector('#modal-mask').classList.contains('hidden') &&
      state.tasks.find(task => task.name === '多人负责的新事务').owners.length === 2`);
    assert.deepEqual(await evaluate(`state.tasks.find(task => task.name === '多人负责的新事务').owners`),
      ['后续成员', '系统管理员']);
    assert.deepEqual(runtimeErrors, []);
    console.log('Task owner browser checks passed: selection order, remove, drag reorder, create and edit persistence.');
  } finally {
    clearTimeout(timeout);
    socket?.close();
    browser?.kill();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
