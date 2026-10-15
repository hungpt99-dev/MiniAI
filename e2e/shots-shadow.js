// Acceptance: no-shadow + slim scrollbars.
const { execFile } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
function py(code) {
  return new Promise((resolve) => {
    execFile('python', ['-c', code], { timeout: 30000 }, (err, stdout) => resolve(stdout.trim()));
  });
}
async function main() {
  const t = await (await fetch('http://127.0.0.1:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (m, pr = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('to ' + m)), 10000); pend.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
  const show = () => py("import sys; sys.argv=['x','show','%{SPACE}']; exec(open('e2e/hotkey_show.py').read())");
  const shot = async (n) => console.log(n, await py("import sys; sys.argv=['x','" + n + "']; exec(open('e2e/shots.py').read())"));
  await show();
  console.log('panel-shadow:', await ev(`getComputedStyle(document.querySelector('.panel')).boxShadow`));
  console.log('win-size:', await ev(`JSON.stringify({w: window.outerWidth, h: window.outerHeight, panel: document.querySelector('.panel').getBoundingClientRect().toJSON()})`));
  await ev(`document.getElementById('input').value=''; document.getElementById('input').dispatchEvent(new Event('input'))`);
  await sleep(400);
  await show();
  await shot('sh-idle');
  // 15 lines into textarea
  await ev(`document.getElementById('input').focus()`);
  await send('Input.insertText', { text: Array.from({ length: 15 }, (_, i) => 'scroll line ' + (i + 1)).join('\n') });
  await sleep(600);
  console.log('ta-scroll:', await ev(`JSON.stringify({h: document.getElementById('input').style.height, sh: document.getElementById('input').scrollHeight, st: document.getElementById('input').scrollTop})`));
  // hover textarea via OS mouse for :hover thumb
  console.log(await py("from pywinauto import mouse, Desktop\nfrom pywinauto.findwindows import find_elements\nels=find_elements(title='Nexio',top_level_only=True,backend='uia')\nr=Desktop(backend='uia').window(handle=els[0].handle).rectangle()\nmouse.move(coords=(r.left+600, r.top+120))\nprint('hover-moved')"));
  await sleep(600);
  await show();
  await shot('sh-paste15');
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
