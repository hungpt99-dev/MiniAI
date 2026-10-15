// CI smoke: launch the dev build, answer "hello" in Do mode through a slow
// fake provider, fail if no answer appears within 30s (stuck-run regression).
// Run: node e2e/smoke-hello.js (repo root). Exits 0 on pass, 1 on fail.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CDP = 'http://127.0.0.1:9222/json';
const DELAY_MS = 2500; // slower than the tasks/list round-trip: the stuck run only shows with a slow provider
const BUDGET_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProvider() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let stream = false; let memClassify = false;
        try {
          const j = JSON.parse(body);
          stream = j.stream === true;
          memClassify = JSON.stringify(j.messages || []).includes('classify one user message');
        } catch { /* canned reply either way */ }
        setTimeout(() => {
          if (stream) {
            const payload = memClassify
              ? '{"intent":"none","text":"","kind":"fact","language":"en"}'
              : 'ANSWER';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: {"choices":[{"delta":{"content":${JSON.stringify(payload)}},"finish_reason":null}]}\n\ndata: [DONE]\n\n`);
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello to you too', tool_calls: [] }, finish_reason: 'stop' }] }));
          }
        }, DELAY_MS);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((res) => { server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })); });
}

let id = 0; let ws; const pending = new Map();
async function connect() {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const targets = await (await fetch(CDP)).json();
      const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return;
      }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('cdp never came up');
    await sleep(500);
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  const to = setTimeout(() => { pending.delete(myId); reject(new Error('cdp-timeout ' + method)); }, 20000);
  pending.set(myId, (m) => { clearTimeout(to); resolve(m); });
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const snap = () => ev(`(async () => JSON.stringify({
  assistant: [...document.querySelectorAll('#messages .msg.assistant')].map((m) => m.textContent || ''),
  steps: document.getElementById('agent-steps').children.length,
  stopVisible: (() => { const b = document.getElementById('btn-stop'); return !!(b && !b.classList.contains('hidden')); })(),
  stopCaps: document.getElementById('stop-hint') ? document.getElementById('stop-hint').textContent : '',
  tasksIcon: (() => { const b = document.getElementById('btn-tasks'); return !!(b && b.querySelector('svg') && !b.querySelector('.task-label')); })(),
  terminal: await window.nexio.tasks({ action: 'list' }).then((r) => r.tasks.every((t) => ['done', 'failed', 'stopped', 'interrupted'].includes(t.state))),
}))()`);

(async () => {
  const { server, port } = await startProvider();
  // Never drive a foreign instance: a stale app on the CDP port would make
  // the smoke pass (or fail) against the wrong build.
  try {
    const targets = await (await fetch(CDP)).json();
    if (Array.isArray(targets) && targets.length) throw new Error('cdp port busy');
  } catch (e) {
    if (e && e.message === 'cdp port busy') throw e;
  }
  const profile = path.join(os.tmpdir(), `nexio-smoke-${Date.now()}`);
  const app = spawn(require('electron'), ['.', '--remote-debugging-port=9222', `--user-data-dir=${profile}`],
    { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: false });
  const kill = () => {
    try { app.kill(); } catch { /* exited */ }
    try { server.close(); } catch { /* closed */ }
    // why: temp profiles must never accumulate (or leak settings/keys).
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  process.on('exit', kill);
  try {
    await connect();
    await ev(`(async () => { await window.nexio.setApiKey('openai', 'sk-smoke'); await window.nexio.setSettings({ provider: 'openai', model: 'smoke', baseUrl: 'http://127.0.0.1:${port}/v1' }); return 1; })()`);
    // Fresh profiles open onboarding (composer disabled): mark onboarded and
    // reload so the smoke drives the real idle composer like a set-up user.
    await ev(`(async () => { await window.nexio.setSettings({ onboarded: true }); return 1; })()`);
    await send('Page.reload', {});
    ws.close();
    await sleep(3000);
    await connect();
    await ev(`(() => { document.getElementById('input').focus(); try { selectMode('agent'); } catch {} return 1; })()`);
    await send('Input.insertText', { text: 'hello' });
    await sleep(300);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(150);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const deadline = Date.now() + BUDGET_MS;
    let last = '';
    for (;;) {
      await sleep(2000);
      last = await snap();
      const s = JSON.parse(last);
      const answered = s.assistant.some((t) => t.includes('hello to you too'));
      if (answered && s.terminal && !s.stopVisible) {
        if (!s.tasksIcon) throw new Error('tasks footer is not the icon button: ' + last);
        if ((s.stopCaps || '').replace(/\s+/g, '') !== 'Esc') throw new Error('stop hint is not a single Esc cap: ' + last);
        console.log('SMOKE PASS | do-hello answered, run ended, footer clean | ' + last);
        try { ws.close(); } catch { /* done */ }
        kill();
        process.exit(0);
      }
      if (Date.now() > deadline) throw new Error('no answer within 30s (stuck run): ' + last);
    }
  } catch (e) {
    console.error('SMOKE FAIL | ' + (e && e.message));
    try { ws.close(); } catch { /* done */ }
    kill();
    await sleep(1000);
    try { if (process.platform === 'win32') require('child_process').execSync('taskkill /F /IM electron.exe /T'); } catch { /* best-effort */ }
    process.exit(1);
  }
})();
