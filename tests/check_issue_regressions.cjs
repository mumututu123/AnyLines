// Run with node --experimental-websocket tests/check_issue_regressions.cjs (Chrome installed).
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = mkdtempSync(path.join(tmpdir(), 'anyline-issue-regressions-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('python', ['-m', 'flask', 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      FLASK_APP: 'app',
      ANYLINE_DB_PATH: path.join(temporary, 'test.db'),
      ANYLINE_ADMIN_USERNAME: 'admin',
      ANYLINE_ADMIN_PASSWORD: 'admin123',
    },
  });
  let browser;
  let socket;
  const pending = new Map();
  const browserErrors = [];
  let sequence = 0;
  let currentStep = 'starting';
  const timeout = setTimeout(() => {
    for (const item of pending.values()) {
      item.reject(new Error(`Browser check timed out while ${currentStep}`));
    }
    socket?.close();
    browser?.kill();
    server.kill();
    process.exitCode = 1;
  }, 45000);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  try {
    currentStep = 'waiting for the Flask server';
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(base)).ok) break;
      } catch {}
      await delay(100);
    }

    currentStep = 'launching Chrome';
    const chrome = process.env.ANYLINE_TEST_CHROME ||
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    browser = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', `--user-data-dir=${path.join(temporary, 'browser')}`,
      'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', error => {
      for (const item of pending.values()) item.reject(error);
    });

    currentStep = 'finding the Chrome debugging endpoint';
    let browserAddress;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [debugPort, endpoint] = readFileSync(
          path.join(temporary, 'browser', 'DevToolsActivePort'), 'utf8'
        ).trim().split(/\r?\n/);
        browserAddress = `ws://127.0.0.1:${debugPort}${endpoint}`;
        break;
      } catch {}
      await delay(100);
    }
    if (!browserAddress) throw new Error('Chrome did not start its debugging endpoint');

    currentStep = 'connecting to Chrome';
    socket = new WebSocket(browserAddress);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(message.params.exceptionDetails.text);
      }
      if (!pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
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

    currentStep = 'loading login page';
    await cdp('Page.navigate', { url: base });
    await until(`document.querySelector('#login-username') &&
      !document.body.classList.contains('auth-pending')`);
    currentStep = 'logging in';
    await evaluate(`document.querySelector('#login-username').value = 'admin';
      document.querySelector('#login-password').value = 'admin123';
      document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated') && state.today`);

    currentStep = 'checking the quick-start tutorial';
    await evaluate(`document.querySelector('#account-trigger').click();
      document.querySelector('#btn-quick-start').click()`);
    await until(`document.body.classList.contains('quick-start-active') &&
      !document.querySelector('#quick-start-tour').classList.contains('hidden') &&
      document.querySelector('#quick-start-popover').style.visibility === 'visible'`);
    assert.equal(await evaluate(`document.querySelectorAll('#quick-start-dots button').length`), 8);
    assert.equal(await evaluate(`quickStartTour.active`), true);
    assert.equal(await evaluate(`document.querySelector('#modal-mask').classList.contains('hidden')`), true);
    assert.equal(await evaluate(`quickStartTour.target.id`), 'view-switch');
    await evaluate(`document.querySelector('#btn-view-dashboard').click()`);
    assert.equal(await evaluate(`state.view`), 'dashboard');
    assert.equal(await evaluate(`quickStartTour.active`), true);
    await evaluate(`document.querySelector('#quick-start-next').click()`);
    await until(`quickStartTour.index === 1 && quickStartTour.target?.classList.contains('quick-start-target')`);
    assert.equal(await evaluate(`document.querySelector('#quick-start-title').textContent`),
      '先用看板判断优先级');
    assert.equal(await evaluate(`state.view`), 'dashboard');
    await evaluate(`applyTheme('dark')`);
    assert.equal(await evaluate(`getComputedStyle(
      document.querySelector('#quick-start-popover')).backgroundColor`), 'rgb(28, 33, 40)');
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await evaluate(`scheduleQuickStartPosition()`);
    await delay(50);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
    assert.equal(await evaluate(`(() => {
      const rect = document.querySelector('#quick-start-popover').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })()`), true);
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await evaluate(`applyTheme('light')`);
    const tourTargets = ['#canvas-wrap', '#canvas-opts', '#filters', '#btn-my-status', '#table-bar'];
    for (let step = 2; step < 7; step++) {
      await evaluate(`document.querySelector('#quick-start-next').click()`);
      await until(`quickStartTour.index === ${step} &&
        quickStartTour.target?.matches('${tourTargets[step - 2]}') &&
        quickStartTour.target?.classList.contains('quick-start-target')`);
    }
    assert.equal(await evaluate(`state.view`), 'table');
    assert.equal(await evaluate(`quickStartTour.active`), true);
    assert.equal(await evaluate(`quickStartTour.target.id`), 'table-bar');
    await evaluate(`document.querySelector('#quick-start-next').click()`);
    await until(`quickStartTour.index === 7 && !document.querySelector('#account-menu').classList.contains('hidden')`);
    assert.equal(await evaluate(`quickStartTour.target.id`), 'account-menu');
    await evaluate(`document.querySelector('#btn-statuses').click()`);
    await until(`!document.querySelector('#modal-mask').classList.contains('hidden')`);
    assert.equal(await evaluate(`quickStartTour.active`), true);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`document.querySelector('#modal-mask').classList.contains('hidden') &&
      !document.querySelector('#account-menu').classList.contains('hidden')`);
    await evaluate(`document.querySelector('#quick-start-exit').click()`);
    assert.equal(await evaluate(`quickStartTour.active`), false);
    assert.equal(await evaluate(`document.querySelector('#quick-start-tour').classList.contains('hidden')`), true);

    currentStep = 'checking the Swagger API documentation';
    await evaluate(`window.__apiDocsOpen = null;
      window.open = (url, target, features) => {
        window.__apiDocsOpen = { url, target, features };
        return null;
      };
      document.querySelector('#account-trigger').click();
      document.querySelector('#btn-api-docs').click()`);
    assert.deepEqual(await evaluate(`window.__apiDocsOpen`), {
      url: '/api-docs/', target: '_blank', features: 'noopener,noreferrer',
    });
    await cdp('Page.navigate', { url: `${base}/api-docs/` });
    await until(`document.querySelectorAll('.swagger-ui .opblock').length === 60`);
    assert.equal(await evaluate(`document.querySelector('.swagger-ui .info .title').textContent
      .includes('AnyLine HTTP API')`), true);
    await evaluate(`Array.from(document.querySelectorAll('.opblock-summary')).find(summary =>
      summary.querySelector('.opblock-summary-method')?.textContent === 'GET' &&
      summary.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/state')
      .querySelector('.opblock-summary-control').click()`);
    await until(`Array.from(document.querySelectorAll('.opblock')).some(block =>
      block.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/state' &&
      block.querySelector('button.execute'))`);
    await evaluate(`Array.from(document.querySelectorAll('.opblock')).find(block =>
      block.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/state')
      .querySelector('button.execute').click()`);
    await until(`Array.from(document.querySelectorAll('.opblock')).some(block => {
      if (block.querySelector('.opblock-summary-path')?.textContent.trim() !== '/api/state') return false;
      const responseText = block.querySelector('.responses-wrapper')?.textContent || '';
      return responseText.includes('Server response') && responseText.includes('200') &&
        responseText.includes('"today"');
    })`);
    await evaluate(`Array.from(document.querySelectorAll('.opblock-summary')).find(summary =>
      summary.querySelector('.opblock-summary-method')?.textContent === 'POST' &&
      summary.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/tasks')
      .querySelector('.opblock-summary-control').click()`);
    await until(`Array.from(document.querySelectorAll('.opblock')).some(block =>
      block.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/tasks' &&
      block.querySelector('.opblock-body'))`);
    await until(`Array.from(document.querySelectorAll('.opblock')).some(block =>
      block.querySelector('.opblock-summary-path')?.textContent.trim() === '/api/tasks' &&
      block.querySelector('textarea.body-param__text')?.value.includes('完成接口联调'))`);
    await cdp('Page.navigate', { url: base });
    await until(`document.body.classList.contains('authenticated') && state.today`);

    currentStep = 'checking more-metrics dismissal';
    await evaluate(`document.querySelector('#summary-more > summary').click()`);
    assert.equal(await evaluate(`document.querySelector('#summary-more').open`), true);
    await evaluate(`document.querySelector('#summary-more').dispatchEvent(
      new MouseEvent('mouseleave', { bubbles: false }))`);
    assert.equal(await evaluate(`document.querySelector('#summary-more').open`), false);

    currentStep = 'expiring the session from an open task editor';
    await evaluate(`(async () => {
      const line = await api('/api/lines', 'POST', { name: '恢复现场', fork_date: state.today });
      await reload();
      switchView('canvas');
      openTaskModal(null, line.id);
      if (!document.querySelector('#modal').classList.contains('task-editor-modal')) {
        throw new Error('Task editor modal class was not applied');
      }
      const body = document.querySelector('#modal-body');
      body._name.value = '不能丢失的事务名';
      body._content.value = 'Session 失效前尚未保存的内容';
      body._owner.querySelector('input[type="checkbox"]').click();
      body._content.focus();
      await fetch('/api/auth/logout', { method: 'POST' });
      await api('/api/state').catch(() => {});
    })()`);
    await until(`!document.body.classList.contains('authenticated')`);
    assert.equal(await evaluate(`document.querySelector('#modal-mask').classList.contains('hidden')`), true);
    assert.equal(await evaluate(`document.querySelector('#login-error').textContent.includes('继续刚才的编辑')`), true);

    currentStep = 'logging back in';
    await evaluate(`document.querySelector('#login-password').value = 'admin123';
      document.querySelector('#login-form').requestSubmit()`);
    await until(`document.body.classList.contains('authenticated') &&
      !document.querySelector('#modal-mask').classList.contains('hidden')`);
    currentStep = 'verifying the restored editor';
    assert.equal(await evaluate(`document.querySelector('#modal-body')._name.value`), '不能丢失的事务名');
    assert.equal(await evaluate(`document.querySelector('#modal-body')._content.value`),
      'Session 失效前尚未保存的内容');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('#modal-body')._content`), true);
    assert.equal(await evaluate(`state.view`), 'canvas');
    await evaluate(`document.querySelector('#modal-body')._content.value += '，重登录后继续编辑';
      document.querySelector('#modal-ok').click()`);
    await until(`document.querySelector('#modal-mask').classList.contains('hidden') &&
      state.tasks.some(task => task.name === '不能丢失的事务名')`);
    assert.equal(await evaluate(`state.tasks.find(
      task => task.name === '不能丢失的事务名').content.includes('重登录后继续编辑')`), true);
    assert.deepEqual(browserErrors, []);
    console.log('Browser checks passed: quick start, Swagger API docs, more-metrics dismissal, and session recovery.');
  } finally {
    clearTimeout(timeout);
    socket?.close();
    browser?.kill();
    server.kill();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
