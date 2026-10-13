// Zero-dep CDP driver for MiniAI popup (Node 22+: fetch + WebSocket global).
const CDP = 'http://127.0.0.1:9222/json';
const ART = './artifacts-e2e';
const fs = require('fs');
fs.mkdirSync(ART, { recursive: true });

let id = 0;
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const ready = new Promise((res) => { ws.onopen = res; });
  async function send(method, params = {}) {
    await ready;
    const myId = ++id;
    return new Promise((resolve) => {
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  return { send, close: () => ws.close() };
}

async function main() {
  const targets = await (await fetch(CDP)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('popup target missing: ' + JSON.stringify(targets.map(t => t.url)));
  const c = makeClient(page.webSocketDebuggerUrl);
  const ev = async (expr, awaitPromise = false) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text + ' :: ' + r.result.exceptionDetails.exception?.description);
    return r.result.result.value;
  };
  const key = async (type, k) => {
    const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
    await c.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: codes[k] || undefined });
  };
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${ART}/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('shot:', name);
  };
  const state = async () => ev(`JSON.stringify({
    active: document.activeElement && document.activeElement.id,
    input: document.getElementById('input').value,
    paletteHidden: document.getElementById('palette').classList.contains('hidden'),
    paletteItems: [...document.querySelectorAll('#palette .item')].map(e => e.textContent.trim().slice(0,60)),
    paletteActive: [...document.querySelectorAll('#palette .item')].findIndex(e => e.classList.contains('active')),
    msgs: [...document.querySelectorAll('#messages .msg')].map(e => e.textContent.trim().slice(0,120)),
    mode: document.querySelector('#modebar .tab.active') ? document.querySelector('#modebar .tab.active').textContent.trim() : 'NONE',
    placeholder: document.getElementById('input').placeholder
  })`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  global.__ctx = { ev, key, shot, state, sleep, c,
    type: async (text) => { await c.send('Input.insertText', { text }); await sleep(350); } };
  // expose for -e steps
  fs.writeFileSync(ART + '/ctx.json', JSON.stringify({ ws: page.webSocketDebuggerUrl }));
  console.log('STATE0:', await state());
  await shot('01-hidden-baseline');
  c.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
