// No-click focus probe: hide popup, trigger show via second-instance event, check DOM focus.
const { execFile, spawn } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
function py(code) {
  return new Promise((resolve) => {
    execFile('python', ['-c', code], { timeout: 30000 }, (err, stdout) => resolve(stdout.trim()));
  });
}
async function main() {
  await py("import sys; sys.argv=['x','hide']; exec(open('e2e/hotkey_show.py').read())");
  const t = await (await fetch('http://127.0.0.1:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (m, pr = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('to ' + m)), 8000); pend.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
  // second instance -> single-instance event -> togglePopup (no clicks anywhere)
  const child = spawn('npx', ['electron', '.'], { cwd: 'D:\\my-project\\Nexio', shell: true });
  await sleep(4000);
  try { child.kill(); } catch {}
  console.log('V:', await py("from pywinauto.findwindows import find_elements\nprint('N:'+str(len(find_elements(title='Nexio',top_level_only=True,backend='uia'))))"));
  console.log('active:', await ev(`(document.activeElement||{}).id||(document.activeElement||{}).tagName`));
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
