// Run with node --experimental-websocket tests/check_audit_ui.cjs (Chrome installed).
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = mkdtempSync(path.join(tmpdir(), 'anyline-audit-ui-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('python', ['-m', 'flask', 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, FLASK_APP: 'app', ANYLINE_DB_PATH: path.join(temporary, 'test.db'),
      ANYLINE_ADMIN_USERNAME: 'admin', ANYLINE_ADMIN_PASSWORD: 'admin123' },
  });
  let browser;
  let socket;
  const pending = new Map();
  const errors = [];
  let sequence = 0;
  const timeout = setTimeout(() => {
    for (const p of pending.values()) p.reject(new Error('Browser check timed out'));
    socket?.close(); browser?.kill(); server.kill(); process.exitCode = 1;
  }, 45000);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await delay(100);
    }
    const chrome = process.env.ANYLINE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', `--user-data-dir=${path.join(temporary, 'browser')}`, 'about:blank'],
      { windowsHide: true, stdio: 'ignore' });
    browser.on('error', error => { for (const p of pending.values()) p.reject(error); });
    let browserAddress;
    for (let i = 0; i < 100; i++) {
      try {
        const [debugPort, endpoint] = readFileSync(path.join(temporary, 'browser', 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
        browserAddress = `ws://127.0.0.1:${debugPort}${endpoint}`;
        break;
      } catch {}
      await delay(100);
    }
    if (!browserAddress) throw new Error('Chrome did not start its debugging endpoint');
    socket = new WebSocket(browserAddress);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
        if (pending.has(message.id)) {
          const promise = pending.get(message.id);
          pending.delete(message.id);
          message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result);
        }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    await cdp('Page.navigate', { url: base });
    await until(`document.querySelector('#login-username') && !document.body.classList.contains('auth-pending')`);
    await evaluate(`document.querySelector('#login-username').value = 'admin';
      document.querySelector('#login-password').value = 'admin123';
      document.querySelector('#login-form').requestSubmit();`);
    await until(`document.body.classList.contains('authenticated')`);
    await evaluate(`(async () => {
      for (let i = 0; i < 27; i++) await api('/api/lines', 'POST', { name: 'UI line ' + i, fork_date: '2026-09-07' });
      await api('/api/lines/1', 'PATCH', { name: '<script>not executable</script>' });
      await api('/api/workspaces/' + state.currentWorkspace.id + '/members', 'POST', {
        username: 'reader', display_name: 'Reader', password: 'member123', role: 'member'
      });
    })()`);
    await evaluate(`document.querySelector('#account-trigger').click()`);
    assert.equal(await evaluate(`document.querySelector('#btn-audit').nextElementSibling.id`), 'btn-api-docs');
    await evaluate(`document.querySelector('#btn-audit').click()`);
    await until(`document.querySelectorAll('#audit-rows tr').length === 25`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#workbench')).display`), 'none');
    await evaluate(`document.querySelector('#audit-next').click()`);
    await until(`document.querySelector('#audit-page-info').textContent.includes('2 / 2')`);
    await evaluate(`document.querySelector('#audit-filters').elements.operation.value = 'update';
      document.querySelector('#audit-filters').requestSubmit()`);
    await until(`document.querySelectorAll('#audit-rows tr').length === 1`);
    assert.equal(await evaluate(`document.querySelectorAll('#audit-rows script').length`), 0);
    await evaluate(`document.querySelector('#audit-rows button').click()`);
    await until(`document.querySelectorAll('.audit-snapshot-columns pre').length === 2`);
    assert.ok((await evaluate(`document.querySelectorAll('.audit-snapshot-columns pre')[0].textContent`)).includes('UI line 0'));
    assert.ok((await evaluate(`document.querySelectorAll('.audit-snapshot-columns pre')[1].textContent`)).includes('<script>'));
    await evaluate(`document.querySelector('#modal-cancel').click(); applyTheme('dark');`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#audit-view')).backgroundColor`), 'rgb(13, 17, 23)');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    await evaluate(`document.querySelector('#audit-filters').reset()`);
    await until(`document.querySelectorAll('#audit-rows tr').length === 25`);
    await evaluate(`document.querySelector('#audit-back').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#audit-view')).display`), 'none');
    await evaluate(`document.querySelector('#btn-audit').click()`);
    await until(`document.querySelectorAll('#audit-rows tr').length === 25`);
    await evaluate(`(async () => {
      await api('/api/workspaces', 'POST', { name: 'Another workspace' });
      resetWorkspaceState(); await refreshSession(); await reload();
    })()`);
    assert.equal(await evaluate(`document.querySelectorAll('#audit-rows tr').length`), 0);
    await evaluate(`document.querySelector('#btn-audit').click()`);
    await until(`document.querySelectorAll('#audit-rows tr').length > 0`);
    assert.equal(await evaluate(`document.querySelector('#audit-rows').textContent.includes('UI line')`), false);
    await evaluate(`document.querySelector('#btn-logout').click()`);
    await until(`!document.body.classList.contains('authenticated')`);
    await evaluate(`document.querySelector('#login-username').value = 'reader';
      document.querySelector('#login-password').value = 'member123';
      document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated')`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#btn-audit')).display`), 'none');
    assert.equal(await evaluate(`fetch('/api/audit').then(response => response.status)`), 403);
    assert.deepEqual(errors, []);
    console.log('Audit browser checks passed: admin menu, pagination, filters, before/after snapshots, XSS escaping, dark theme, mobile layout, workspace switch, member restriction.');
  } finally {
    clearTimeout(timeout);
    socket?.close();
    browser?.kill();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
