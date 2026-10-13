// Acceptance screenshots: idle bar, 300-char paste, 15-line paste.
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
  const shot = async (n) => {
    const r = await py("import sys; sys.argv=['x','" + n + "']; exec(open('e2e/shots.py').read())");
    console.log(n, r);
  };
  const show = () => py("import sys; sys.argv=['x','show','%{SPACE}']; exec(open('e2e/hotkey_show.py').read())");
  await show();
  await ev(`document.getElementById('input').value=''; document.getElementById('input').dispatchEvent(new Event('input'))`);
  await sleep(600);
  await shot('acc-idle');
  await show();
  const para = 'MiniAI is a keyboard-first personal assistant for Windows. '.repeat(6).slice(0, 300);
  await send('Input.insertText', { text: para });
  await sleep(800);
  await show();
  await shot('acc-paste300');
  console.log('multiline:', await ev(`document.querySelector('.bar').classList.contains('multi')`));
  await show();
  await ev(`document.getElementById('input').value=''`);
  await send('Input.insertText', { text: Array.from({ length: 15 }, (_, i) => 'line ' + (i + 1)).join('\n') });
  await sleep(800);
  console.log('height15:', await ev(`document.getElementById('input').style.height`));
  await show();
  await shot('acc-paste15');
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
