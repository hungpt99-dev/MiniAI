// Repro focus issue with exception capture.
const { execFile } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function main() {
  const t = await (await fetch('http://127.0.0.1:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  const pend = new Map(); const events = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m); };
  await new Promise((r) => { ws.onopen = r; });
  const send = (m, pr = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('to ' + m)), 8000); pend.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
  await send('Runtime.enable');
  const hotkey = () => new Promise((res) => execFile('python', ['-c', "import time\nfrom pywinauto import keyboard\nkeyboard.send_keys('%{SPACE}')\ntime.sleep(2)"], () => res()));
  // ensure hidden first
  await ev(`document.hasFocus()`);
  await hotkey(); // toggle (hide if shown)
  await sleep(500);
  const vis0 = await ev(`document.hasFocus()`);
  await ev(`window.__order=[]; window.addEventListener('focus',()=>window.__order.push('probe-focus')); document.getElementById('input').addEventListener('focus',()=>window.__order.push('probe-input-focus'))`);
  await hotkey(); // show
  console.log('hasFocus-after-show:', await ev(`document.hasFocus()`));
  console.log('active-after-show:', await ev(`(document.activeElement||{}).id||(document.activeElement||{}).tagName`));
  console.log('order:', await ev(`JSON.stringify(window.__order)`));
  console.log('exceptions:', JSON.stringify(events.filter((e) => e.method === 'Runtime.exceptionThrown')).slice(0, 500));
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
