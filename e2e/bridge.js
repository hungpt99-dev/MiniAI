// Use bridge to read settings + set hotkey, proving preload works end-to-end.
let id = 0;
async function main() {
  const t = await (await fetch('http://127.0.0.1:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('index.html'));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (m, pr = {}) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error('to ' + m)), 15000); pend.set(i, (x) => { clearTimeout(to); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
  const ev = async (e, ap = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: ap })).result;
  const raw = async (e, ap = false) => await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: ap });
  const mode = process.argv[2] || 'read';
  if (mode === 'read') {
    const r = await raw(`(async () => { try { return { ok: true, v: await window.miniAI.getSettings() }; } catch (e) { return { ok: false, err: String(e) }; } })()`, true);
    console.log('SETTINGS:', JSON.stringify(r.result));
  } else {
    const hk = process.argv[3] || 'Alt+X';
    const r = await raw(`(async () => { try { await window.miniAI.setSettings({hotkey:'${hk}'}); return { ok: true, v: await window.miniAI.getSettings() }; } catch (e) { return { ok: false, err: String(e) }; } })()`, true);
    console.log('SET:', JSON.stringify(r.result));
    const r2 = await ev(`window.miniAI.getSettings()`, true);
    console.log('SETTINGS:', JSON.stringify(r2.value));
  }
  ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
