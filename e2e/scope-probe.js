// Verify /model in agent mode reports scope message (not Unknown command).
let id = 0;
async function main() {
  const t = await (await fetch('http://127.0.0.1:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (m, pr = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('to ' + m)), 10000); pend.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
  console.log(await ev(`(async () => { const r = await (window.nexio).slashResolve('/model', 'agent'); return JSON.stringify({found: r.found && r.found.trigger, scope: r.found && r.found.scope, sug: (r.suggestions||[]).length}); })()`));
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
