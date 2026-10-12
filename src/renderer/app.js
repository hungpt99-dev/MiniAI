'use strict';
/* MiniAI renderer — vanilla JS. Talks to preload `window.miniAI`. */
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), inputEl = $('input'), paletteEl = $('palette');
let convId = null, paletteItems = [], paletteActive = 0, assistantDiv = null;
let mode = 'chat', runtime = 'opencode', reqSeq = 0;
let settingsProvider = 'openai';
let currentView = null; // single-panel flow: 'palette'|'messages'|'settings'|'history'|null
let drafts = { chat: '', agent: '' };

// Fail visibly, not half-wired, if the preload bridge did not load.
if (!window.miniAI) {
  messagesEl.innerHTML = '<div class="msg">Error: app bridge failed to load. Restart MiniAI.</div>';
  throw new Error('miniAI bridge missing');
}

function setMode(m, persist) {
  drafts[mode] = inputEl.value;
  mode = m;
  inputEl.value = drafts[mode] || '';
  updateModeUI();
  grow();
  if (persist !== false && window.miniAI?.setSettings) void window.miniAI.setSettings({ mode: m }).catch(() => {});
}
function updateModeUI() {
  const isChat = mode === 'chat';
  $('tab-chat').classList.toggle('active', isChat);
  $('tab-chat').setAttribute('aria-selected', String(isChat));
  $('tab-agent').classList.toggle('active', !isChat);
  $('tab-agent').setAttribute('aria-selected', String(!isChat));
  const rt = $('runtime');
  rt.textContent = runtime;
  rt.classList.toggle('hidden', isChat);
  inputEl.placeholder = isChat ? 'Ask MiniAI anything…' : `Agent (${runtime}) — describe the task…  (Tab to switch)`;
}

// why: autosize composer up to 224px, then internal scroll
function grow() {
  const bar = document.querySelector('.bar');
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 224) + 'px';
  if (bar) bar.classList.toggle('multiline', inputEl.scrollHeight > 32 || inputEl.value.includes('\n'));
  requestResize();
}

// why: keep tall pastes to one compact user row while sending the full text
function userLabel(t) {
  const first = String(t).split('\n')[0];
  return (first.length > 120 || String(t).includes('\n')) ? first.slice(0, 120) + '…' : t;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
// Readable error text: drop Electron's invoke wrapper, tolerate non-Error rejections.
function errText(e) {
  let m = (e && e.message) || e;
  if (typeof m !== 'string') m = (m && m.code) || JSON.stringify(m);
  return 'Error: ' + String(m)
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '');
}

// markdown-lite: code blocks, inline code, bold, italic, links, line breaks
function mdLite(src) {
  const blocks = [];
  let html = esc(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  html = html
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, text, href) => (/^https?:\/\/[^"'\s<>]+$/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text))
    .replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = role === 'assistant' ? mdLite(content) : esc(content);
  messagesEl.appendChild(div);
  const view = $('view');
  if (view) view.scrollTop = view.scrollHeight; // .view is the only scroller
  if (currentView !== 'messages') showView('messages');
  return div;
}

async function ensureConv() {
  if (convId) return convId;
  const c = await window.miniAI.createConversation('New chat');
  convId = c.id;
  void refreshHistory();
  return convId;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  grow();
  hidePalette();
  if (text.startsWith('/')) {
    const [trigger, ...rest] = text.split(' ');
    const r = await window.miniAI.slashResolve(trigger, mode);
    if (r.found) {
      if (r.found.scope && r.found.scope !== 'all' && r.found.scope !== mode) {
        addMsg('assistant', `${esc(trigger)} is only available in ${esc(r.found.scope)} mode.`);
        return;
      }
      if (r.found.source === 'workflow') {
        addMsg('user', text);
        assistantDiv = addMsg('assistant', '…');
        try {
          const out = await window.miniAI.runWorkflow(trigger, { text: rest.join(' ') });
          assistantDiv.innerHTML = mdLite(out.outputs.__output || JSON.stringify(out));
        } catch (e) {
          assistantDiv.innerHTML = mdLite(errText(e));
          inputEl.value = text; // keep unsent input after failures
          drafts[mode] = text;
          grow();
        }
        return;
      }
      if (trigger === '/new') return void newChat();
      if (trigger === '/clear') { messagesEl.innerHTML = ''; assistantDiv = null; showView(null); return; }
      if (trigger === '/help') {
        addMsg('assistant', '**Commands:** /help /new /clear /model /history /settings + prompt templates + workflows.\nType `/` to browse.');
        return;
      }
      if (trigger === '/history') return void togglePanel('history');
      if (trigger === '/settings') return void togglePanel('settings');
      if (trigger === '/model') {
        if (rest[0]) { await window.miniAI.setSettings({ model: rest[0] }); addMsg('assistant', `Model → ${esc(rest[0])}`); }
        else { const s = await window.miniAI.getSettings(); addMsg('assistant', `Current model: ${esc(s.model)}`); }
        return;
      }
      addMsg('user', text);
      // prompt template: send rendered via chat
      const id = await ensureConv();
      assistantDiv = addMsg('assistant', '…');
      try {
        await window.miniAI.send(id, text, { mode, runtimeId: runtime, sessionId: id, requestId: `r${Date.now()}-${++reqSeq}` });
      } catch (e) {
        assistantDiv.innerHTML = mdLite(errText(e));
        inputEl.value = text; // keep unsent input after failures
        drafts[mode] = text;
        grow();
      }
      return;
    }
    addMsg('assistant', `Unknown command ${esc(trigger)}. Did you mean: ${(r.suggestions || []).map((s) => esc(s.trigger)).join(', ') || '—'}?`);
    return;
  }
  addMsg('user', userLabel(text));
  const id = await ensureConv();
  assistantDiv = addMsg('assistant', '…');
  try {
    const requestId = `r${Date.now()}-${++reqSeq}`;
    await window.miniAI.send(id, text, { mode, runtimeId: runtime, sessionId: id, requestId });
  } catch (e) {
    assistantDiv.innerHTML = mdLite(errText(e));
    inputEl.value = text; // keep unsent input after failures
    drafts[mode] = text;
    grow();
  }
}

window.miniAI.onStream((ev) => {
  if (ev.done) return;
  if (!assistantDiv) assistantDiv = addMsg('assistant', '');
  assistantDiv.dataset.raw = (assistantDiv.dataset.raw || '') + ev.token;
  assistantDiv.innerHTML = mdLite(assistantDiv.dataset.raw);
  const view = $('view');
  if (view) view.scrollTop = view.scrollHeight;
});

// launcher behavior: refocus composer when popup regains OS focus,
// unless user is already in another field (settings/history inputs)
window.addEventListener('focus', () => {
  const a = document.activeElement;
  if (a !== inputEl && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) inputEl.focus();
});

// slash palette
let paletteTimer = null;
inputEl.addEventListener('input', () => {
  drafts[mode] = inputEl.value;
  grow();
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(async () => {
    const v = inputEl.value;
    if (!/^\/[A-Za-z0-9_-]*$/.test(v)) return hidePalette(); // single-line slash token only
    paletteItems = await window.miniAI.slashQuery(v, mode);
    if (!paletteItems.length) return hidePalette();
    paletteActive = 0;
    renderPalette();
  }, 80);
});
inputEl.addEventListener('paste', () => setTimeout(grow, 0));
inputEl.addEventListener('keydown', (e) => {
  const paletteOpen = !paletteEl.classList.contains('hidden');
  if (e.key === 'Tab' && document.activeElement === inputEl && !paletteOpen && !e.isComposing) {
    e.preventDefault();
    setMode(mode === 'chat' ? 'agent' : 'chat');
    return;
  }
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); e.stopPropagation(); setMode(mode === 'chat' ? 'agent' : 'chat'); return; }
  if (e.altKey && e.key === '1') { e.preventDefault(); e.stopPropagation(); setMode('chat'); return; }
  if (e.altKey && e.key === '2') { e.preventDefault(); e.stopPropagation(); setMode('agent'); return; }
  if (!paletteEl.classList.contains('hidden')) {
    if (e.key === 'Tab') { e.preventDefault(); hidePalette(); inputEl.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive = (paletteActive + 1) % paletteItems.length; renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = (paletteActive - 1 + paletteItems.length) % paletteItems.length; renderPalette(); }
    else if (e.key === 'Enter') {
      if (e.shiftKey || e.isComposing) return; // Shift+Enter newline, no preventDefault
      e.preventDefault(); pickPalette(paletteActive);
    }
    else if (e.key === 'Escape') { hidePalette(); }
  } else if (e.key === 'Enter') {
    if (e.shiftKey || e.isComposing) return; // Shift+Enter newline, no preventDefault
    e.preventDefault(); void send();
  }
  else if (e.key === 'Escape') window.close?.();
});
function renderPalette() {
  paletteEl.innerHTML = '';
  paletteItems.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'item' + (i === paletteActive ? ' active' : '');
    d.innerHTML = `<b>${esc(it.trigger)}</b> ${esc(it.label)}<small>${esc(it.description || '')}</small>`;
    d.onclick = () => pickPalette(i);
    paletteEl.appendChild(d);
  });
  paletteEl.classList.remove('hidden');
}
function pickPalette(i) {
  const it = paletteItems[i];
  if (!it) return;
  inputEl.value = it.trigger + ' ';
  drafts[mode] = inputEl.value;
  hidePalette();
  grow();
  inputEl.focus();
}
function hidePalette() { paletteEl.classList.add('hidden'); paletteItems = []; }
document.addEventListener('click', (e) => { if (!paletteEl.contains(e.target) && e.target !== inputEl) hidePalette(); });

$('btn-send').onclick = () => void send();
$('tab-chat').onclick = () => setMode('chat');
$('tab-agent').onclick = () => setMode('agent');
const RUNTIMES = ['opencode', 'claude', 'codex'];
// why: single compact cycle button replaces the native runtime select (same persist semantics)
$('runtime').onclick = () => {
  runtime = RUNTIMES[(RUNTIMES.indexOf(runtime) + 1) % RUNTIMES.length];
  updateModeUI();
  if (window.miniAI?.setSettings) void window.miniAI.setSettings({ agentRuntime: runtime }).catch(() => {});
};
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); setMode(mode === 'chat' ? 'agent' : 'chat'); }
  else if (e.altKey && e.key === '1') { e.preventDefault(); setMode('chat'); }
  else if (e.altKey && e.key === '2') { e.preventDefault(); setMode('agent'); }
});
function defaultView() { return messagesEl.children.length ? 'messages' : null; }
// why: single-panel flow — exactly one view visible; every switch re-syncs chrome + size
function showView(name) {
  currentView = name;
  paletteEl.classList.toggle('hidden', name !== 'palette');
  messagesEl.classList.toggle('hidden', name !== 'messages');
  $('settings').classList.toggle('hidden', name !== 'settings');
  $('history').classList.toggle('hidden', name !== 'history');
  if ($('view')) $('view').classList.toggle('hidden', !name);
  const wasDisabled = inputEl.disabled;
  inputEl.disabled = name === 'settings';
  if (name === 'settings') inputEl.placeholder = 'Settings';
  else if (wasDisabled) updateModeUI(); // restores mode placeholder
  syncChrome();
  requestResize();
}
function togglePanel(which) {
  if (currentView === which) showView(defaultView());
  else { showView(which); if (which === 'history') void refreshHistory(); }
}
$('btn-settings').onclick = async () => {
  togglePanel('settings');
  const s = await window.miniAI.getSettings();
  settingsProvider = s.provider || 'openai';
  paintProv();
  $('set-model').value = s.model;
  $('set-baseurl').value = s.baseUrl || '';
  $('set-opencode').value = s.opencodeBaseUrl || ''; $('set-claudebin').value = s.claudeBin || '';
  $('set-codexbin').value = s.codexBin || ''; $('set-agentcwd').value = s.agentCwd || '';
  document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
};
$('btn-settings-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
$('btn-history-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
$('btn-history').onclick = () => togglePanel('history');
$('btn-save-settings').onclick = async () => {
  const patch = {
    provider: settingsProvider,
    model: $('set-model').value,
    opencodeBaseUrl: $('set-opencode').value.trim(),
    claudeBin: $('set-claudebin').value.trim(),
    codexBin: $('set-codexbin').value.trim(),
    agentCwd: $('set-agentcwd').value.trim(),
  };
  if (settingsProvider === 'compatible' && $('set-baseurl').value.trim()) patch.baseUrl = $('set-baseurl').value.trim();
  await window.miniAI.setSettings(patch);
  if ($('set-apikey').value) await window.miniAI.setApiKey(patch.provider, $('set-apikey').value);
  $('set-apikey').value = '';
  $('settings-status').textContent = 'Saved';
  setTimeout(() => ($('settings-status').textContent = ''), 1500);
};
$('btn-test-conn').onclick = async () => {
  $('settings-status').textContent = 'Testing…';
  const r = await window.miniAI.testConnectivity(settingsProvider, $('set-model').value, $('set-baseurl').value || undefined);
  $('settings-status').textContent = r.ok ? 'OK' : ('Fail: ' + (r.error?.code || '') + ' ' + (r.error?.message || ''));
};
$('btn-new').onclick = () => void newChat();
async function newChat() {
  const c = await window.miniAI.createConversation('New chat');
  convId = c.id; messagesEl.innerHTML = ''; assistantDiv = null;
  showView(null);
  void refreshHistory();
}
async function refreshHistory() {
  const list = await window.miniAI.listConversations();
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.textContent = c.title || c.id;
    li.onclick = async () => {
      convId = c.id; messagesEl.innerHTML = '';
      const msgs = await window.miniAI.getMessages(c.id);
      for (const m of msgs) addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
      showView('messages');
    };
    ul.appendChild(li);
  }
}
(async () => {
  try {
    const s = await window.miniAI.getSettings();
    document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
    mode = s.mode === 'agent' ? 'agent' : 'chat';
    runtime = s.agentRuntime || 'opencode';
    try {
      const caps = await window.miniAI.runtimeList?.();
      if (Array.isArray(caps)) {
        const cur = caps.find((c) => c.id === runtime);
        if (cur && !cur.available) $('runtime').title = `Agent runtime: ${runtime} (unavailable)`;
      }
    } catch { /* runtime list optional */ }
    updateModeUI();
    try {
      if (window.miniAI.isEncryptionAvailable && !(await window.miniAI.isEncryptionAvailable())) {
        const b = document.createElement('div');
        b.textContent = 'Warning: encryption unavailable — API keys will not be securely stored.';
        b.style.cssText = 'background:#fef3c7;color:#92400e;padding:6px 10px;font-size:12px;text-align:center';
        $('app').prepend(b);
      }
    } catch { /* encryption check optional */ }
    await refreshHistory();
  } catch { /* preload unavailable in plain browser preview */ }
  try { requestResize(); syncChrome(); } catch { /* preview */ }
  setTimeout(() => { try { requestResize(); syncChrome(); } catch {} }, 300);
})();

/* --- Spotlight chrome (appended): auto-resize, grouped palette, answer actions, Esc collapse --- */
let _lastH = 0, _rafOn = false;
function requestResize() {
  if (_rafOn) return;
  _rafOn = true;
  requestAnimationFrame(() => {
    _rafOn = false;
    try {
      const panel = $('panel');
      const h = panel ? panel.scrollHeight : ($('app') ? $('app').scrollHeight : 0); // all views in-flow now
      if (!h || Math.abs(h - _lastH) < 2) return; // +2px filter
      _lastH = h;
      if (window.miniAI && typeof window.miniAI.resize === 'function') window.miniAI.resize(h);
    } catch { /* preview without bridge */ }
  });
}
function syncChrome() {
  const hasMsgs = messagesEl.children.length > 0;
  const palOpen = currentView === 'palette';
  const panelOpen = currentView === 'settings' || currentView === 'history';
  const idle = !inputEl.value && !hasMsgs && !palOpen && !panelOpen;
  if ($('panel')) $('panel').classList.toggle('has-results', hasMsgs || palOpen);
  if ($('hotkey-hint')) $('hotkey-hint').classList.toggle('hidden', !idle);
  if ($('modebar')) $('modebar').classList.toggle('hidden', idle);
  const multi = !palOpen && !hasMsgs && !!inputEl.value && (inputEl.value.includes('\n') || inputEl.scrollHeight > 32);
  if ($('hint-nav')) $('hint-nav').classList.toggle('hidden', multi);
  if ($('hint-multi')) $('hint-multi').classList.toggle('hidden', !multi);
  const hasAnswer = currentView === 'messages' && !!messagesEl.querySelector('.msg.assistant');
  if ($('answer-meta')) $('answer-meta').classList.toggle('hidden', !hasAnswer);
  if ($('actions')) $('actions').classList.toggle('hidden', !hasAnswer);
  if ($('hints')) $('hints').classList.toggle('hidden', idle);
  // single Tab keycap beside the pill: only when composer focused-and-empty (hover handled in CSS)
  document.body.classList.toggle('show-tabkey', document.activeElement === inputEl && !inputEl.value && !inputEl.disabled);
}
// why: keep artboard grouped palette + selected accent + enter cap without touching core logic
renderPalette = function () {
  paletteEl.innerHTML = '';
  const groups = [['PROMPTS', paletteItems.filter((it) => it.source !== 'workflow')], ['WORKFLOWS', paletteItems.filter((it) => it.source === 'workflow')]];
  const idxOf = new Map(paletteItems.map((it, i) => [it, i]));
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const lb = document.createElement('div');
    lb.className = 'lb';
    lb.textContent = label;
    paletteEl.appendChild(lb);
    for (const it of items) {
      const i = idxOf.get(it);
      const d = document.createElement('div');
      d.className = 'item' + (i === paletteActive ? ' active' : '');
      d.setAttribute('role', 'option');
      d.setAttribute('aria-selected', String(i === paletteActive));
      d.innerHTML = `<span class="cm">${esc(it.trigger)}</span> <span>${esc(it.label || '')}</span><small>${esc(it.description || '')}</small>` +
        (i === paletteActive ? '<span class="k" style="margin-left:auto">↵</span>' : '');
      d.onclick = () => pickPalette(i);
      paletteEl.appendChild(d);
    }
  }
  paletteEl.classList.remove('hidden');
  showView('palette');
};
const _hidePalette = hidePalette;
hidePalette = function () {
  if (paletteEl.classList.contains('hidden')) return; // no view yank on unrelated clicks
  _hidePalette();
  showView(defaultView());
};
const _updateModeUI = updateModeUI;
updateModeUI = function () { _updateModeUI(); syncChrome(); requestResize(); };
const _togglePanel = togglePanel;
togglePanel = function (which) { _togglePanel(which); syncChrome(); requestResize(); };
const _newChat = newChat;
newChat = async function () { await _newChat(); assistantDiv = null; syncChrome(); requestResize(); };
if (window.miniAI && typeof window.miniAI.onStream === 'function') {
  window.miniAI.onStream((ev) => {
    if (ev.done) {
      if (assistantDiv) assistantDiv.classList.remove('streaming');
      syncChrome();
      requestResize();
      return;
    }
    if (assistantDiv) assistantDiv.classList.add('streaming');
    syncChrome();
    requestResize();
  });
}
inputEl.addEventListener('input', () => { syncChrome(); requestResize(); });
inputEl.addEventListener('focus', () => syncChrome());
inputEl.addEventListener('blur', () => syncChrome());
// re-assert size on show (resizes sent while hidden are ignored by main)
window.addEventListener('focus', () => requestResize());
if (typeof MutationObserver !== 'undefined' && $('panel')) {
  new MutationObserver(() => { syncChrome(); requestResize(); })
    .observe($('panel'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
async function refreshModelName() {
  try {
    const s = await window.miniAI.getSettings();
    if ($('model-name') && s.model) $('model-name').textContent = s.model;
  } catch { /* preview */ }
}
void refreshModelName();
// focus composer on load: window-focus may have fired before listeners attached,
// leaving a fresh window with body focused until the next focus event
try { inputEl.focus(); } catch { /* preview */ }
setTimeout(() => { try { if (document.activeElement !== inputEl) inputEl.focus(); } catch {} }, 60);
if ($('btn-save-settings')) $('btn-save-settings').addEventListener('click', () => setTimeout(() => { void refreshModelName(); requestResize(); }, 100));
if ($('btn-copy')) $('btn-copy').addEventListener('click', async () => {
  const divs = messagesEl.querySelectorAll('.msg.assistant');
  const last = divs[divs.length - 1];
  if (!last) return;
  const text = (last.dataset && last.dataset.raw) || last.textContent || '';
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
});
if ($('btn-followup')) $('btn-followup').addEventListener('click', () => inputEl.focus());
if ($('btn-newchat')) $('btn-newchat').addEventListener('click', () => void newChat());
// segmented provider is the only provider control (native select deleted);
// Base URL row shows only for Custom
function paintProv() {
  const seg = $('set-prov-seg');
  if (seg) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.prov === settingsProvider));
  const fb = $('fld-baseurl');
  if (fb) fb.classList.toggle('hidden', settingsProvider !== 'compatible');
}
(function () {
  const seg = $('set-prov-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); settingsProvider = b.dataset.prov; paintProv(); }));
  paintProv();
})();
// Esc: results showing -> collapse + clear; second Esc hides (capture runs before core closer)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const palOpen = !paletteEl.classList.contains('hidden');
  if (palOpen) { e.stopPropagation(); hidePalette(); inputEl.focus(); return; }
  const setOpen = currentView === 'settings';
  const histOpen = currentView === 'history';
  if (setOpen || histOpen) { // dismiss panels before collapsing results
    e.stopPropagation();
    showView(defaultView());
    syncChrome(); requestResize(); inputEl.focus(); return;
  }
  if (messagesEl.children.length > 0) {
    e.stopPropagation();
    messagesEl.innerHTML = '';
    assistantDiv = null;
    showView(null);
    syncChrome();
    requestResize();
    inputEl.focus();
  }
}, true);
