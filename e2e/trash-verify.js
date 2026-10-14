// Trash E2E: built-in agent moves C:\NexioTest\trash-me-1.txt via a fake
// tool-turn provider. Pass = live Electron trash path (no 'staged at').
// Needs the app running with --remote-debugging-port=9222. Run: npm run e2e:trash
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
// why: the trash sandbox must be a host-native temp dir (was C:\-only).
const SB = process.platform === 'darwin' ? path.join(os.tmpdir(), 'NexioTest') : 'C:\\NexioTest';
const FILE = path.join(SB, 'trash-me-1.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function main() {
  fs.mkdirSync(SB, { recursive: true });
  fs.writeFileSync(FILE, 'trash-me');
  let n = 0; // fake provider: OpenAI-shape turns, mirrors tests/mocks scriptFetch
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const first = n++ === 0;
      const message = first
        ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_trash', arguments: JSON.stringify({ path: FILE }) } }] }
        : { content: 'trashed it' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + fake.address().port + '/v1';
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('no-popup-target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { // cdp-driver.js pattern + awaitPromise for async IIFEs
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result.result.value;
  };
  const out = await ev('(async () => {'
    + 'const s0 = await window.nexio.getSettings();'
    + 'const keep = { provider: s0.provider, model: s0.model, baseUrl: s0.baseUrl, agentAllowedRoots: s0.agentAllowedRoots, agentCwd: s0.agentCwd, agentAlwaysAllow: s0.agentAlwaysAllow };'
    + 'await window.nexio.setSettings({ provider: \'compatible\', model: \'e2e-trash\', baseUrl: ' + JSON.stringify(base)
    + ', agentAllowedRoots: [' + JSON.stringify(SB) + '], agentCwd: ' + JSON.stringify(SB)
    + ', agentAlwaysAllow: [{ scope: \'tool-dir\', tool: \'fs_trash\', dir: ' + JSON.stringify(SB) + ' }] });'
    + 'try { const c = await window.nexio.createConversation(\'e2e-trash\');'
    + 'const r = await window.nexio.agentStart(c.id, ' + JSON.stringify('move ' + FILE + ' to the trash') + ', { cwd: ' + JSON.stringify(SB) + ' });'
    + 'return await new Promise((done) => { const off = window.nexio.onAgentEvent(({ runId, event }) => {'
    + 'if (runId !== r.runId) return;'
    + 'if (event.type === \'tool_result\') { off(); done(\'tool_result ok=\' + event.ok + \' \' + event.output); }'
    + 'else if (event.type === \'error\' || event.type === \'stopped\') { off(); done(event.type + \' \' + (event.message || \'\')); } }); });'
    + '} finally { await window.nexio.setSettings(keep); } })()');
  fake.close();
  ws.close();
  await sleep(200);
  console.log('TRASH-OUT: ' + out);
  const gone = !fs.existsSync(FILE);
  console.log((gone ? 'PASS' : 'FAIL') + ' | trash-file-gone');
  const live = /moved to trash/.test(String(out)) && !/staged at/.test(String(out));
  console.log((live ? 'PASS' : 'FAIL') + ' | trash-live-path');
  if (!gone || !live) process.exit(1);
}
main().catch((e) => { console.error('FAIL | trash-verify | ' + e.message); process.exit(1); });
