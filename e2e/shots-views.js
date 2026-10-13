// Acceptance: settings single panel + view swaps.
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
  const shot = async (n) => { await show(); console.log(n, await py("import sys; sys.argv=['x','" + n + "']; exec(open('e2e/shots.py').read())")); };
  const visStates = () => ev(`JSON.stringify({win:[window.outerWidth,window.outerHeight],views:{palette:document.getElementById('palette').classList.contains('hidden')?'H':'V',messages:document.getElementById('messages').classList.contains('hidden')?'H':'V',settings:document.getElementById('settings').classList.contains('hidden')?'H':'V',history:document.getElementById('history').classList.contains('hidden')?'H':'V'}})`);
  await show();
  await ev(`document.getElementById('btn-settings').click()`);
  await sleep(600);
  console.log('settings-state:', await visStates());
  await shot('vw-settings');
  await ev(`document.getElementById('btn-settings-back').click()`);
  await sleep(400);
  await ev(`document.getElementById('input').value=''; document.getElementById('input').focus()`);
  await send('Input.insertText', { text: '/sum' });
  await sleep(600);
  console.log('palette-state:', await visStates());
  await shot('vw-palette');
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
