// E2E: answer arrives, mouse-clicking Copy works without hiding, pin + Esc hide.
// Drives the dev build over CDP against an inline echo provider and a temp
// profile (deleted afterwards). Needs a display (CI windows/macOS runners).
// Run: node e2e/visibility-copy.js (repo root). Exits 0/1.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CDP = 'http://127.0.0.1:9223/json';
const BUDGET_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProvider() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text = 'hello back';
        try {
          const j = JSON.parse(body);
          const users = (j.messages || []).filter((m) => m.role === 'user');
          const last = users[users.length - 1];
          const c = last && last.content;
          text = typeof c === 'string' ? c.slice(0, 120) : 'hello back';
        } catch { /* canned */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text, tool_calls: [] }, finish_reason: 'stop' }] }));
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
const snap = () => ev(`(() => JSON.stringify({
  answers: [...document.querySelectorAll('#messages .msg.assistant')].map((m) => (m.textContent || '').slice(0, 60)),
  copyLabel: (document.getElementById('btn-copy') || {}).textContent,
  pinned: document.getElementById('pin-badge') && !document.getElementById('pin-badge').classList.contains('hidden'),
}))()`);

(async () => {
  try {
    const targets = await (await fetch(CDP)).json().catch(() => null);
    if (Array.isArray(targets) && targets.length) throw new Error('cdp port busy');
  } catch (e) {
    if (e && e.message === 'cdp port busy') throw e;
  }
  const { server, port } = await startProvider();
  const profile = path.join(os.tmpdir(), `nexio-vis-${Date.now()}`);
  const app = spawn(require('electron'), ['.', '--remote-debugging-port=9223', `--user-data-dir=${profile}`],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  app.stdout.on('data', (c) => { out += c; });
  app.stderr.on('data', (c) => { out += c; });
  const kill = () => {
    try { app.kill(); } catch { /* exited */ }
    try { server.close(); } catch { /* closed */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  process.on('exit', kill);
  const fail = async (why, extra = '') => { console.error(`VIS FAIL | ${why} ${extra}`); kill(); await sleep(1000); process.exit(1); };
  try {
    await connect();
    await ev(`(async () => { await window.nexio.setApiKey('openai', 'sk-vis'); await window.nexio.setSettings({ provider: 'openai', model: 'vis', baseUrl: 'http://127.0.0.1:${port}/v1', onboarded: true }); return 1; })()`);
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
    let answered = false;
    for (;;) {
      await sleep(2000);
      const s = JSON.parse(await snap());
      if (s.answers.some((t) => t.includes('hello'))) { answered = true; break; }
      if (Date.now() > deadline) await fail('no answer within budget', await snap());
    }
    if (!answered) await fail('no answer');
    // headless windows don't hit-test: dispatch real MouseEvents at the button
    // (same handler path a physical click takes)
    await ev(`(() => {
      const b = document.getElementById('btn-copy');
      const r = b.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
      b.dispatchEvent(new MouseEvent('mousedown', opts));
      b.dispatchEvent(new MouseEvent('mouseup', opts));
      b.dispatchEvent(new MouseEvent('click', opts));
      return 1;
    })()`);
    await sleep(1000);
    let s = JSON.parse(await snap());
    if (!String(s.copyLabel).includes('Copied')) await fail('copy did not confirm', await snap());
    if (/\[vis\] hide/.test(out)) await fail('window hid while clicking Copy', out.slice(-500));
    // pin on via the real Alt+P binding: badge shows; Esc with empty composer hides through the module
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 1 });
    await sleep(200);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 1 });
    await sleep(800);
    s = JSON.parse(await snap());
    if (!s.pinned) await fail('pin badge missing', await snap());
    await ev(`(() => { document.getElementById('input').value = ''; return 1; })()`);
    for (let i = 0; i < 2; i++) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(400);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(400);
    }
    await sleep(800);
    if (!/\[vis\] hide reason=esc/.test(out)) await fail('esc did not route through the visibility module', out.slice(-800));
    console.log('VIS PASS | copy clicked without hide, pin badge shown, esc routed');
    try { ws.close(); } catch { /* done */ }
    kill();
    process.exit(0);
  } catch (e) {
    console.error('VIS FAIL | ' + (e && e.message));
    try { ws.close(); } catch { /* done */ }
    kill();
    await sleep(1000);
    process.exit(1);
  }
})();
