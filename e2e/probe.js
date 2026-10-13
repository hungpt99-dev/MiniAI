// Probe: activeElement + focus-event firing after hotkey.
const { execFile } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res) => { ws.onopen = res; });
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('timeout ' + m)), 8000); pending.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
  await ev(`window.__focusLog=[]; window.addEventListener('focus',()=>window.__focusLog.push('win-focus:'+Date.now())); document.getElementById('input').addEventListener('focus',()=>window.__focusLog.push('input-focus:'+Date.now()))`);
  console.log('before-hotkey active:', await ev(`(document.activeElement||{}).id||document.activeElement.tagName`));
  await new Promise((res) => execFile('python', ['-c', "import time\nfrom pywinauto import keyboard\nkeyboard.send_keys('%{SPACE}')\ntime.sleep(2)"], () => res()));
  console.log('after-hotkey active:', await ev(`(document.activeElement||{}).id||document.activeElement.tagName`));
  console.log('focusLog:', await ev(`JSON.stringify(window.__focusLog)`));
  console.log('hasFocus:', await ev(`document.hasFocus()`));
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
