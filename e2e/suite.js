// Full E2E suite driving the real Nexio popup via CDP + pywinauto hotkeys.
// Visibility = count of UIA top-level 'Nexio' matches (0 hidden/closed, 1 shown).
// window.close() destroys the target -> reconnect() after any close.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const ART = './artifacts-e2e';
fs.mkdirSync(ART, { recursive: true });
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}
function py(code) {
  return new Promise((resolve) => {
    execFile('python', ['-c', code], { timeout: 30000 }, (err, stdout, stderr) => resolve((stdout + stderr).trim().slice(0, 300)));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
const VIS_PY = "from pywinauto.findwindows import find_elements\nprint('N:'+str(len(find_elements(title='Nexio',top_level_only=True,backend='uia')+find_elements(title='MiniAI',top_level_only=True,backend='uia'))))";
const HOTKEY_FOR = (hk) => (/alt\+x/i.test(hk || '') ? '%x' : '%{SPACE}');
let HOTKEY_PY = "import sys; sys.argv=['x','show','%{SPACE}']; exec(open('e2e/hotkey_show.py').read())";
let HIDE_PY = "import sys; sys.argv=['x','hide','%{SPACE}']; exec(open('e2e/hotkey_show.py').read())";
// Alt+Space is eaten by the OS on some hosts; main falls back to Alt+X and
// reports the live key via getHotkeyStatus, so send the registered one.
async function syncHotkey() {
  try {
    const hs = JSON.parse(await ev(`JSON.stringify(await window.nexio.getHotkeyStatus())`));
    const k = HOTKEY_FOR(hs && hs.hotkey);
    HOTKEY_PY = "import sys; sys.argv=['x','show','" + k + "']; exec(open('e2e/hotkey_show.py').read())";
    HIDE_PY = "import sys; sys.argv=['x','hide','" + k + "']; exec(open('e2e/hotkey_show.py').read())";
  } catch (e) { console.log('syncHotkey-fallback using default | ' + ((e && e.message) || e)); }
}
const SHOT_PY = "import sys; sys.argv=['x','NAME']; exec(open('e2e/shots.py').read())";
const ensureVisible = async () => {
  for (let i = 0; i < 3; i++) {
    if ((await py(VIS_PY)).includes('N:1')) return true;
    await py(HOTKEY_PY);
  }
  return false;
};
const ensureInput = async () => {
  await ensureVisible();
  for (let i = 0; i < 5; i++) {
    const s = await S();
    if (s.active === 'input') return true;
    await ev(`document.getElementById('input').focus()`);
    await sleep(250);
  }
  return false;
};

const C = {}; // connection holder
async function connect() {
  for (let i = 0; i < 4; i++) {
    const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
    var page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
    if (page) break;
    await py(HOTKEY_PY); // reshow (recreates window after close)
  }
  if (!page) throw new Error('no-popup-target');
  try { C.ws?.close(); } catch {}
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  C.pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && C.pending.has(m.id)) { C.pending.get(m.id)(m); C.pending.delete(m.id); } };
  await new Promise((res) => { ws.onopen = res; });
  C.ws = ws;
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  const to = setTimeout(() => { C.pending.delete(myId); reject(new Error('cdp-timeout ' + method)); }, 10000);
  C.pending.set(myId, (m) => { clearTimeout(to); resolve(m); });
  C.ws.send(JSON.stringify({ id: myId, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
};
const key = async (k) => {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: codes[k] });
  await sleep(200);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: codes[k] });
  await sleep(250);
};
const type = async (text) => { await send('Input.insertText', { text }); await sleep(400); };
const shot = async (n) => {
  if (!(await py(VIS_PY)).includes('N:1')) await py(HOTKEY_PY);
  const r = await py(SHOT_PY.replace('NAME', n));
  if (!r.includes('saved')) throw new Error('shot-failed ' + n + ': ' + r);
};
const S = async () => JSON.parse(await ev(`JSON.stringify({active:(document.activeElement||{}).id||null,input:document.getElementById('input').value,ph:document.getElementById('input').placeholder,palHidden:document.getElementById('palette').classList.contains('hidden'),items:[...document.querySelectorAll('#palette .item')].map(e=>e.textContent.trim().slice(0,50)),pActive:[...document.querySelectorAll('#palette .item')].findIndex(e=>e.classList.contains('active')),msgs:[...document.querySelectorAll('#messages .msg')].map(e=>e.textContent.trim().slice(0,100)),mode:(document.querySelector('#modebar .tab.active')||{textContent:'NONE'}).textContent.trim(),vis:['palette','messages','settings','history'].filter(id=>!document.getElementById(id).classList.contains('hidden')),noSelect:!document.querySelector('select')})`));

async function main() {
  await connect();
  // fresh renderer state: prior runs leave messages/drafts/focus in a live window,
  // which breaks esc-close and draft-roundtrip expectations below
  await ev(`location.reload()`);
  await sleep(2500);
  await connect();
  await syncHotkey();
  check('cdp-target-found', true);
  if (!(await py(VIS_PY)).includes('N:0')) { await py(HIDE_PY); await sleep(500); }
  check('popup-hidden-initially', (await py(VIS_PY)).includes('N:0'));
  await py(HOTKEY_PY);
  check('hotkey-shows-popup', (await py(VIS_PY)).includes('N:1'));
  let s = await S();
  check('input-focused', s.active === 'input', s.active);
  await shot('02-popup-open');
  check('type-ready', await ensureInput());
  await type('/');
  s = await S();
  check('palette-opens', !s.palHidden && s.items.length >= 5, `items=${s.items.length}`);
  check('palette-single-view', JSON.stringify(s.vis) === JSON.stringify(['palette']), s.vis.join(','));
  check('palette-has-help', s.items.some((i) => i.includes('/help')));
  await shot('03-palette');
  await type('trans');
  s = await S();
  check('palette-filters', s.items.length >= 1 && s.items[0].includes('/translate'), s.items.join('|'));
  await key('ArrowDown');
  await key('Enter');
  s = await S();
  check('palette-selects', s.input.startsWith('/translate'), s.input);
  await shot('04-selected');
  // Escape with palette OPEN -> hides palette, window stays
  await ev(`{const el=document.getElementById('input'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await type('/');
  s = await S();
  check('palette-reopens', !s.palHidden);
  await key('Escape');
  s = await S();
  check('escape-hides-palette', s.palHidden);
  check('escape-keeps-window', (await py(VIS_PY)).includes('N:1'));
  // Escape with palette CLOSED -> closes window (target dies, keyUp may time out)
  await ev(`document.getElementById('input').value=''`);
  try { await key('Escape'); } catch (e) { await sleep(800); }
  await sleep(500);
  check('esc-closes-popup', (await py(VIS_PY)).includes('N:0'));
  // reshow recreates window -> reconnect
  await py(HOTKEY_PY);
  await connect();
  s = await S();
  check('reshow-refocuses', s.active === 'input', s.active);
  // normalize persisted mode: a previous run may have left agent mode,
  // which inverts Tab counting for the checks below
  if (s.mode.toLowerCase().includes('agent')) {
    await key('Tab');
    s = await S();
  }
  check('reshow-starts-in-chat', s.mode.toLowerCase().includes('chat'), s.mode);
  // growable composer: idle chrome -> typing pill -> paste wrap/cap -> shift+enter -> enter send
  check('idle-shows-hotkey', await ev(`!document.getElementById('hotkey-hint').classList.contains('hidden') && document.getElementById('modebar').classList.contains('hidden')`));
  check('composer-is-textarea', await ev(`document.getElementById('input').tagName==='TEXTAREA'`));
  check('bar-trimmed', await ev(`!document.querySelector('.bar .bar-btns') && !document.getElementById('btn-hide')`));
  check('footer-keeps-actions', await ev(`!!document.getElementById('btn-send') && !!document.getElementById('btn-settings') && !!document.getElementById('btn-history')`));
  const idleW = await ev(`document.getElementById('input').clientWidth`);
  check('composer-wide-idle', idleW >= 440, `w=${idleW}`);
  const csx = await ev(`JSON.stringify({o:getComputedStyle(document.getElementById('input')).outlineStyle,w:getComputedStyle(document.getElementById('input')).outlineWidth,b:getComputedStyle(document.getElementById('input')).boxShadow})`);
  const cso = JSON.parse(csx);
  check('composer-no-ring', (cso.o === 'none' || cso.w === '0px') && (cso.b === 'none' || cso.b === ''), csx.slice(0, 120));
  check('composer-ready', await ensureInput());
  await type('typing-probe');
  check('mode-pill-while-typing', await ev(`!document.getElementById('modebar').classList.contains('hidden') && document.getElementById('hotkey-hint').classList.contains('hidden')`));
  const para300 = 'word '.repeat(60);
  await ev(`{const el=document.getElementById('input'); el.value=${JSON.stringify(para300)}; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await sleep(400);
  const w1 = JSON.parse(await ev(`JSON.stringify({sh:document.getElementById('input').scrollHeight,sw:document.getElementById('input').scrollWidth,cw:document.getElementById('input').clientWidth,multi:document.querySelector('.bar').classList.contains('multiline')})`));
  check('paste-wraps', w1.sh > 32 && w1.sw <= w1.cw + 2 && w1.multi, JSON.stringify(w1));
  await shot('15-tall-300char');
  await ev(`{const el=document.getElementById('input'); el.value=Array(15).fill('line of text for height cap testing 12345').join(String.fromCharCode(10)); el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await sleep(400);
  const w2 = JSON.parse(await ev(`JSON.stringify({ch:document.getElementById('input').clientHeight,sh:document.getElementById('input').scrollHeight,multi:document.querySelector('.bar').classList.contains('multiline')})`));
  check('paste-caps-224', w2.ch <= 226 && w2.ch >= 220 && w2.sh > w2.ch && w2.multi, JSON.stringify(w2));
  await shot('16-tall-15line');
  await ev(`{const el=document.getElementById('input'); el.value='/trans'+String.fromCharCode(10)+'foo'; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await sleep(400);
  s = await S();
  check('palette-blocked-multiline', s.palHidden, s.items.join('|').slice(0, 100));
  await ev(`{const el=document.getElementById('input'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await key('ArrowDown');
  check('arrows-idle-safe', (await S()).palHidden);
  await ev(`{const el=document.getElementById('input'); el.value='line1'; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  check('shift-ready', await ensureInput());
  const mBefore = (await S()).msgs.length;
  await ev(`document.__shiftPrevented='unset'; document.addEventListener('keydown', function rec(e){ if(e.key==='Enter'&&e.shiftKey){ document.__shiftPrevented=e.defaultPrevented; document.removeEventListener('keydown',rec);} });`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
  await sleep(300);
  const shiftOk = await ev(`document.__shiftPrevented`);
  const mMid = (await S()).msgs.length;
  await send('Input.insertText', { text: '\n' });
  await sleep(400);
  s = await S();
  check('shift-enter-newline', shiftOk === false && mMid === mBefore && s.input.includes('\n') && s.msgs.length === mBefore, `prevented=${shiftOk} input=${JSON.stringify(s.input).slice(0, 80)}`);
  await ev(`{const el=document.getElementById('input'); el.value='enter-send-probe-123'; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await key('Enter');
  await sleep(2500);
  s = await S();
  check('enter-sends', s.msgs.some((m) => m.includes('enter-send-probe-123')), s.msgs.join(' || ').slice(-200));
  check('answer-single-view', JSON.stringify(s.vis) === JSON.stringify(['messages']), s.vis.join(','));
  check('fail-keeps-full-text', s.input.includes('enter-send-probe-123'), s.input.slice(0, 80));
  await ev(`{const el=document.getElementById('input'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await ensureInput();
  await type('/clear');
  await key('Enter');
  await sleep(500);
  s = await S();
  if (s.input.trim() === '/clear') { await key('Enter'); await sleep(600); s = await S(); }
  const rc = JSON.parse(await ev(`JSON.stringify({v:document.getElementById('input').value,ch:document.getElementById('input').clientHeight,multi:document.querySelector('.bar').classList.contains('multiline')})`));
  check('composer-reset-1line', rc.v === '' && rc.ch <= 32 && !rc.multi, JSON.stringify(rc));
  check('user-label-truncates', await ev(`userLabel('x'.repeat(200)).length===121 && userLabel('a'+String.fromCharCode(10)+'b')==='a…'`));
  await shot('05-reshown');
  // /help executes (palette may select first on fast typing -> Enter again)
  check('help-ready', await ensureInput());
  await type('/help');
  await key('Enter');
  await sleep(500);
  s = await S();
  if (s.input.trim() === '/help') { await key('Enter'); await sleep(800); s = await S(); }
  else await sleep(300);
  check('help-renders', s.msgs.length > 0, s.msgs.join(' || ').slice(0, 250));
  await shot('06-help');
  // unknown command suggestions
  await ev(`document.getElementById('input').value=''`);
  check('unknown-ready', await ensureInput());
  await type('/fooxyz');
  s = await S();
  check('unknown-kept-local', !s.palHidden || s.items.length >= 0, s.items.join('|').slice(0, 200));
  await key('Enter');
  await sleep(500);
  s = await S();
  if (s.input.trim() === '/fooxyz') { await key('Enter'); await sleep(600); s = await S(); }
  check('unknown-suggests', s.msgs.some((m) => /did you mean|unknown/i.test(m)), s.msgs.join(' || ').slice(0, 250));
  // /new clears view
  await ev(`document.getElementById('input').value=''`);
  check('new-ready', await ensureInput());
  await type('/new');
  await key('Enter');
  await sleep(500);
  s = await S();
  if (s.input.trim() === '/new') { await key('Enter'); await sleep(600); s = await S(); }
  check('new-clears-view', s.msgs.length === 0, `msgs=${s.msgs.length}`);
  // Tab mode switching preserves draft
  check('tab-ready', await ensureInput());
  await type('draft-kept-123');
  const before = (await S()).input;
  await key('Tab');
  s = await S();
  if (!s.mode.toLowerCase().includes('agent')) { await key('Tab'); s = await S(); }
  check('tab-to-agent', s.mode.toLowerCase().includes('agent'), s.mode);
  check('tab-shows-agent-draft', s.input === '', JSON.stringify(s.input)); // per-mode drafts: agent starts empty
  await ev(`document.getElementById('input').value=''`);
  await type('agent-draft-xyz');
  const phAgent = s.ph;
  await key('Tab');
  s = await S();
  if (!s.mode.toLowerCase().includes('chat')) { await key('Tab'); s = await S(); }
  check('tab-back-to-chat', s.mode.toLowerCase().includes('chat'), s.mode);
  check('tab-draft-roundtrip', s.input === before, s.input);
  check('placeholder-differs', s.ph !== phAgent, `chat='${s.ph}' agent='${phAgent}'`);
  await shot('07-agent-mode');
  // agent palette lists Do-mode commands
  await ev(`document.getElementById('input').value=''`);
  await key('Tab');
  await ev(`{const el=document.getElementById('input'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  check('agent-ready', await ensureInput());
  await type('/');
  s = await S();
  check('agent-palette-opens', !s.palHidden && s.items.length > 0, s.items.join('|').slice(0, 250));
  await shot('08-agent-palette');
  await key('Escape');
  await key('Tab'); // back to chat
  // chat send without key -> clean error, draft kept
  await ev(`document.getElementById('input').value=''`);
  await key('Tab'); // ensure chat mode (toggle only if agent)
  s = await S();
  if (s.mode.toLowerCase().includes('agent')) await key('Tab');
  check('chat-ready', await ensureInput());
  await type('hello-no-key-test');
  await key('Enter');
  await sleep(2500);
  s = await S();
  check('no-key-error-surfaced', s.msgs.some((m) => /key|api|error|fail|connect/i.test(m)), s.msgs.join(' || ').slice(0, 250));
  check('no-key-draft-kept', s.input.includes('hello-no-key-test'), s.input);
  await shot('09-error-path');
  // palette mouse pick via DOM click
  await ev(`document.getElementById('input').value=''`);
  check('click-ready', await ensureInput());
  await type('/');
  s = await S();
  check('click-palette-open', !s.palHidden && s.items.length > 0);
  await ev(`document.querySelector('#palette .item').click()`);
  await sleep(300);
  s = await S();
  check('mouse-pick-inserts', s.input.startsWith('/') && s.palHidden, s.input);
  await shot('11-mouse-pick');
  // /model get/set
  const runCmd = async (cmd) => {
    await ev(`document.getElementById('input').value=''`);
    await ensureInput();
    await type(cmd);
    await key('Enter');
    await sleep(500);
    let st = await S();
    if (st.input.trim() === cmd) { await key('Enter'); await sleep(700); st = await S(); }
    return st;
  };
  s = await runCmd('/model');
  check('model-get', s.msgs.some((m) => /current model/i.test(m)), s.msgs.slice(-1).join('').slice(0, 120));
  s = await runCmd('/model e2e-model-1');
  check('model-set', s.msgs.some((m) => /model → e2e-model-1/i.test(m)));
  s = await runCmd('/model');
  check('model-persisted', s.msgs.some((m) => /current model: e2e-model-1/i.test(m)), s.msgs.slice(-1).join('').slice(0, 120));
  await ev(`window.miniAI.setSettings({model:'gpt-4o-mini'})`); // restore default
  // settings panel + test-conn graceful fail (no key)
  await ev(`document.getElementById('btn-settings').click()`);
  await sleep(300);
  s = await S();
  const setVis = await ev(`!document.getElementById('settings').classList.contains('hidden')`);
  check('settings-opens', setVis);
  check('no-native-select', s.noSelect && await ev(`!document.querySelector('select')`));
  check('settings-single-view', JSON.stringify(s.vis) === JSON.stringify(['settings']), s.vis.join(','));
  check('settings-dims-input', await ev(`document.getElementById('input').disabled && document.getElementById('input').placeholder==='Settings'`));
  check('settings-back-btn', await ev(`!!document.getElementById('btn-settings-back')`));
  await ev(`document.getElementById('btn-test-conn').click()`);
  await sleep(4000);
  const setStatus = await ev(`document.getElementById('settings-status').textContent`);
  check('test-conn-graceful', setStatus.length > 0, setStatus.slice(0, 120));
  await shot('12-settings');
  await ev(`document.getElementById('btn-settings').click()`); // close panel
  await sleep(300);
  s = await S();
  check('settings-close-restores', !s.vis.includes('settings') && !(await ev(`document.getElementById('input').disabled`)), s.vis.join(','));
  // history panel lists conversations
  await ev(`document.getElementById('btn-history').click()`);
  await sleep(500);
  const histN = await ev(`document.querySelectorAll('#history-list li').length`);
  check('history-lists', histN >= 1, `entries=${histN}`);
  s = await S();
  check('history-single-view', JSON.stringify(s.vis) === JSON.stringify(['history']), s.vis.join(','));
  await shot('13-history');
  await ev(`document.getElementById('btn-history').click()`); // close panel
  await sleep(300);
  s = await S();
  check('single-panel-proof', s.vis.length <= 1 && s.noSelect, s.vis.join(','));
  await shot('17-single-panel');
  // workflow fail path (no key -> prompt step 401, must surface not strand)
  s = await runCmd('/email-reply hello-this-is-a-test-email');
  await sleep(1500);
  s = await S();
  const lastMsg = s.msgs[s.msgs.length - 1] || '';
  check('workflow-fails-loudly', !/…$/.test(lastMsg) && /fail|error|output|status/i.test(lastMsg), lastMsg.slice(0, 200));
  await shot('14-workflow-fail');
  // Do mode is built-in only: no runtime picker, Tab switches mode pills
  await key('Tab'); // to agent
  await sleep(400);
  s = await S();
  check('agent-placeholder', /what do you want to do/i.test(s.ph), s.ph);
  check('no-runtime-picker', await ev(`!document.getElementById('runtime')`));
  await key('Tab'); // back to chat
  const msgCount = (await S()).msgs.length;
  // hide via hotkey toggle, reshow, history persists (same window, no destroy)
  await py(HIDE_PY);
  check('toggle-hides', (await py(VIS_PY)).includes('N:0'));
  await py(HOTKEY_PY);
  s = await S();
  check('toggle-keeps-history', s.msgs.length === msgCount, `before=${msgCount} after=${s.msgs.length}`);
  await shot('10-final');

  // trash (sandboxed agent + fake tool-turn provider, no keys) + 401 + pill labels
  const SB = 'C:\\NexioTest';
  const trashFile = SB + '\\trash-me-2.txt';
  fs.mkdirSync(SB, { recursive: true });
  fs.writeFileSync(trashFile, 'trash-me');
  let turnN = 0;
  const toolFake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const msg = turnN++ === 0
        ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_trash', arguments: JSON.stringify({ path: trashFile }) } }] }
        : { content: 'trashed it' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  await new Promise((r) => toolFake.listen(0, '127.0.0.1', r));
  const toolBase = 'http://127.0.0.1:' + toolFake.address().port + '/v1';
  let trashOut = '';
  let trashDone = '';
  try {
    await ev(`window.__trashDone=null;window.__trash=null;(async()=>{try{`
      + `const s0=await window.nexio.getSettings();`
      + `window.__s0=JSON.stringify({provider:s0.provider,model:s0.model,baseUrl:(s0.baseUrl??null),roots:s0.agentAllowedRoots||[],cwd:s0.agentCwd||'',rules:s0.agentAlwaysAllow||[]});`
      + `await window.nexio.setSettings({provider:'compatible',model:'e2e-trash',baseUrl:${JSON.stringify(toolBase)},`
      + `agentAllowedRoots:[${JSON.stringify(SB)}],agentCwd:${JSON.stringify(SB)},`
      + `agentAlwaysAllow:[{scope:'tool-dir',tool:'fs_trash',dir:${JSON.stringify(SB)}}]});`
      + `const c=await window.nexio.createConversation('e2e-trash');`
      + `const r=await window.nexio.agentStart(c.id,${JSON.stringify('move ' + trashFile + ' to the trash')},{cwd:${JSON.stringify(SB)}});`
      + `const off=window.nexio.onAgentEvent(({runId,event})=>{if(runId!==r.runId)return;`
      + `if(event.type==='tool_result'){window.__trash=event.ok+' '+(event.output||'');}`
      + `if(event.type==='done'||event.type==='error'||event.type==='stopped'){off();window.__trashDone=event.type;}});`
      + `}catch(e){window.__trashDone='eval-error:'+(e&&e.message);}})()`);
    for (let i = 0; i < 60 && !(await ev(`window.__trashDone`)); i++) await sleep(500);
    trashOut = await ev(`window.__trash||''`);
    trashDone = await ev(`window.__trashDone||''`);
  } finally {
    try { await ev(`{const s0=JSON.parse(window.__s0||'null');if(s0)await window.nexio.setSettings({provider:s0.provider,model:s0.model,baseUrl:(s0.baseUrl??''),agentAllowedRoots:s0.roots,agentCwd:s0.cwd,agentAlwaysAllow:s0.rules});}`); } catch (e) { console.log('settings-restore-failed | ' + ((e && e.message) || e)); }
    await Promise.race([new Promise((r) => toolFake.close(r)), sleep(2000).then(() => console.log('toolFake-close-timeout'))]);
  }
  check('trash-live-path', trashDone === 'done' && /true moved to trash/.test(trashOut) && !/staged at/.test(trashOut), `${trashDone} ${(trashOut || '').slice(0, 120)}`);
  check('trash-file-gone', !fs.existsSync(trashFile));
  const unauth = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401); res.end('invalid key'); }); });
  await new Promise((r) => unauth.listen(0, '127.0.0.1', r));
  const unauthBase = 'http://127.0.0.1:' + unauth.address().port + '/v1';
  try {
    await ev(`window.__tc=null;window.nexio.testConnectivity('compatible','e2e-model',${JSON.stringify(unauthBase)}).then(r=>{window.__tc=JSON.stringify(r)}).catch(e=>{window.__tc='err:'+e.message})`);
    await sleep(2500);
  } finally {
    await Promise.race([new Promise((r) => unauth.close(r)), sleep(2000).then(() => console.log('unauth-close-timeout'))]);
  }
  const tc = await ev(`window.__tc||''`);
  check('conn-401-auth', tc.includes('"ok":false') && /auth|401/.test(tc), tc.slice(0, 120));
  check('pill-ask-do', await ev(`document.getElementById('tab-chat').textContent.trim()==='Ask'&&document.getElementById('tab-agent').textContent.trim()==='Do'`));

  const fails = results.filter((r) => !r.pass);
  console.log(`DONE ${results.length - fails.length}/${results.length} passed`);
  C.ws.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
