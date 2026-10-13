'use strict';
/* Nexio renderer — vanilla JS. Talks to preload `window.nexio`. */
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), inputEl = $('input'), paletteEl = $('palette');
let convId = null, paletteItems = [], paletteActive = 0, assistantDiv = null;
let mode = 'chat', reqSeq = 0;
let settingsProvider = 'openai';
// True once the user explicitly picks a pill this session (wins over intent routing).
let modeExplicitSession = false;
function selectMode(m) { modeExplicitSession = true; setMode(m); }
let currentView = null; // single-panel flow: 'palette'|'messages'|'settings'|'history'|null
let drafts = { chat: '', agent: '' };

// Fail visibly, not half-wired, if the preload bridge did not load.
if (!window.nexio) {
  messagesEl.innerHTML = '<div class="msg">Error: app bridge failed to load. Restart Nexio.</div>';
  throw new Error('nexio bridge missing');
}

function setMode(m, persist) {
  drafts[mode] = inputEl.value;
  mode = m;
  inputEl.value = drafts[mode] || '';
  updateModeUI();
  grow();
  if (persist !== false && window.nexio?.setSettings) void window.nexio.setSettings({ mode: m }).catch(() => {});
}
function updateModeUI() {
  const isChat = mode === 'chat';
  $('tab-chat').classList.toggle('active', isChat);
  $('tab-chat').setAttribute('aria-selected', String(isChat));
  $('tab-agent').classList.toggle('active', !isChat);
  $('tab-agent').setAttribute('aria-selected', String(!isChat));
  const chip = $('agent-cwd');
  if (chip) chip.classList.toggle('hidden', isChat);
  inputEl.placeholder = isChat ? 'Ask anything…' : 'What do you want to do?';
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
  const c = await window.nexio.createConversation('New chat');
  convId = c.id;
  void refreshHistory();
  return convId;
}

let sending = false;
async function send() {
  // Serialize submissions: the agentRunning() check below races with the
  // first await inside (two rapid Enters would orphan the first run —
  // its tools keep executing with no UI and no way to stop it).
  if (sending) return;
  sending = true;
  try {
    await sendInner();
  } finally {
    sending = false;
  }
}

async function sendInner() {
  if (inputEl.disabled) return; // settings/onboard own the composer; Esc/Back re-enables
  const text = inputEl.value.trim();
  if (!text) return;
  if (agentRunning()) return; // one run at a time; Stop first
  inputEl.value = '';
  hideSuggest();
  grow();
  hidePalette();
  if (mode === 'agent' && !text.startsWith('/')) {
    // An armed skill body goes in as context for this run only.
    if (pendingSkill) {
      const armed = pendingSkill;
      pendingSkill = null;
      return void startAgentRun(`Following skill "${armed.name}":\n${armed.body}\n\nUser task: ${text}`);
    }
    return void startAgentRun(text);
  }
  if (text.startsWith('/')) {
    const [trigger, ...rest] = text.split(' ');
    const r = await window.nexio.slashResolve(trigger, mode);
    if (r.found) {
      if (r.found.scope && r.found.scope !== 'all' && r.found.scope !== mode) {
        addMsg('assistant', `${esc(trigger)} is only available in ${esc(r.found.scope)} mode.`);
        return;
      }
      if (r.found.source === 'workflow') {
        // v1 extension workflows open an input form; legacy ones run directly.
        try {
          const info = await window.nexio.ext({ action: 'workflowInfo', trigger });
          if (info && info.kind === 'ext') return void openWorkflowForm(trigger, info);
        } catch { /* fall through to legacy path */ }
        addMsg('user', text);
        assistantDiv = addMsg('assistant', '…');
        try {
          const out = await window.nexio.runWorkflow(trigger, { text: rest.join(' ') });
          assistantDiv.innerHTML = mdLite(out.outputs.__output || JSON.stringify(out));
        } catch (e) {
          assistantDiv.innerHTML = mdLite(errText(e));
          inputEl.value = text; // keep unsent input after failures
          drafts[mode] = text;
          grow();
        }
        return;
      }
      if (r.found.source === 'skill') return void runSkillCommand(trigger);
      if (r.found.source === 'mcp') return void runMcpPrompt(trigger);
      if (trigger === '/new') return void newChat();
      if (trigger === '/clear') { messagesEl.innerHTML = ''; assistantDiv = null; showView(null); return; }
      if (trigger === '/help') {
        addMsg('assistant', '**Commands:** /help /new /clear /model /history /settings /log /extensions + prompt templates + workflows + skills.\nType `/` to browse.');
        return;
      }
      if (trigger === '/log') return void showAgentLog();
      if (trigger === '/extensions') return void openExtensions();
      if (trigger === '/history') return void togglePanel('history');
      if (trigger === '/settings') return void togglePanel('settings');
      if (trigger === '/model') {
        if (rest[0]) { await window.nexio.setSettings({ model: rest[0] }); addMsg('assistant', `Model → ${esc(rest[0])}`); }
        else { const s = await window.nexio.getSettings(); addMsg('assistant', `Current model: ${esc(s.model)}`); }
        return;
      }
      addMsg('user', text);
      // prompt template: send rendered via chat
      const id = await ensureConv();
      assistantDiv = addMsg('assistant', '…');
      try {
        await window.nexio.send(id, text, { mode, sessionId: id, requestId: `r${Date.now()}-${++reqSeq}`, explicit: modeExplicitSession });
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
    await window.nexio.send(id, text, { mode, sessionId: id, requestId, explicit: modeExplicitSession });
  } catch (e) {
    assistantDiv.innerHTML = mdLite(errText(e));
    inputEl.value = text; // keep unsent input after failures
    drafts[mode] = text;
    grow();
  }
}

window.nexio.onStream((ev) => {
  if (ev.done) return;
  if (!assistantDiv) assistantDiv = addMsg('assistant', '');
  assistantDiv.dataset.raw = (assistantDiv.dataset.raw || '') + ev.token;
  assistantDiv.innerHTML = mdLite(assistantDiv.dataset.raw);
  const view = $('view');
  if (view) view.scrollTop = view.scrollHeight;
});

// launcher behavior: refocus composer when popup regains OS focus,
// unless the user is typing elsewhere — or deciding on an approval card.
window.addEventListener('focus', () => {
  const a = document.activeElement;
  const inAppr = !!(a && typeof a.closest === 'function' && a.closest('.appr'));
  if (inAppr) return; // keep Deny/Allow focus; see shared/focus.ts
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
    if (inputEl.disabled) return hidePalette(); // no slash palette while a panel owns the composer
    if (!/^\/[A-Za-z0-9_-]*$/.test(v)) return hidePalette(); // single-line slash token only
    paletteItems = await window.nexio.slashQuery(v, mode);
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
    selectMode(mode === 'chat' ? 'agent' : 'chat');
    return;
  }
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); e.stopPropagation(); selectMode(mode === 'chat' ? 'agent' : 'chat'); return; }
  if (e.altKey && e.key === '1') { e.preventDefault(); e.stopPropagation(); selectMode('chat'); return; }
  if (e.altKey && e.key === '2') { e.preventDefault(); e.stopPropagation(); selectMode('agent'); return; }
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
$('tab-chat').onclick = () => selectMode('chat');
$('tab-agent').onclick = () => selectMode('agent');
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); selectMode(mode === 'chat' ? 'agent' : 'chat'); }
  else if (e.altKey && e.key === '1') { e.preventDefault(); selectMode('chat'); }
  else if (e.altKey && e.key === '2') { e.preventDefault(); selectMode('agent'); }
});
function defaultView() { return messagesEl.children.length ? 'messages' : null; }
// why: single-panel flow — exactly one view visible; every switch re-syncs chrome + size
function showView(name) {
  currentView = name;
  paletteEl.classList.toggle('hidden', name !== 'palette');
  messagesEl.classList.toggle('hidden', name !== 'messages');
  $('settings').classList.toggle('hidden', name !== 'settings');
  $('history').classList.toggle('hidden', name !== 'history');
  $('extensions').classList.toggle('hidden', name !== 'extensions');
  $('onboard').classList.toggle('hidden', name !== 'onboard');
  if ($('view')) $('view').classList.toggle('hidden', !name);
  const wasDisabled = inputEl.disabled;
  inputEl.disabled = name === 'settings' || name === 'onboard';
  if (name === 'settings') {
    inputEl.placeholder = 'Settings';
    hidePalette(); hideSuggest(); // clear /c: no slash palette or suggestions behind settings
  } else if (wasDisabled) updateModeUI(); // restores mode placeholder
  syncChrome();
  requestResize();
}
function togglePanel(which) {
  if (currentView === which) showView(defaultView());
  else { showView(which); if (which === 'history') void refreshHistory(); }
}
$('btn-settings').onclick = async () => {
  togglePanel('settings');
  const s = await window.nexio.getSettings();
  settingsProvider = s.provider || 'openai';
  paintProv();
  $('set-model').value = s.model;
  $('set-baseurl').value = s.baseUrl || '';
  if ($('set-sendtemp')) $('set-sendtemp').checked = s.sendTemperature !== false;
  void refreshModelSuggestions();
  $('set-agentcwd').value = s.agentCwd || '';
  $('set-stophotkey').value = s.agentStopHotkey || 'Ctrl+Alt+Esc';
  $('set-maxcalls').value = s.agentMaxCalls || 25;
  $('set-reqapprove').checked = s.requireApprovalForWrites !== false;
  $('set-suggest').value = (s.suggestions || []).join('\n');
  if ($('set-hotkey')) $('set-hotkey').value = s.hotkey || currentToggleHotkey;
  if ($('set-stophotkey') && s.agentStopHotkey) currentStopHotkey = s.agentStopHotkey;
  if ($('set-login')) $('set-login').checked = s.launchAtLogin === true;
  void refreshHotkeyStatus();
  paintAgentRoots(s.agentAllowedRoots || []);
  paintAgentRules(s.agentAlwaysAllow || []);
  document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
};
$('btn-settings-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
$('btn-history-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
$('btn-history').onclick = () => togglePanel('history');
$('btn-save-settings').onclick = async () => {
  const patch = {
    provider: settingsProvider,
    model: $('set-model').value,
    agentCwd: $('set-agentcwd').value.trim(),
  };
  if (settingsProvider === 'compatible' && $('set-baseurl').value.trim()) patch.baseUrl = $('set-baseurl').value.trim();
  else if (settingsProvider !== 'compatible') patch.baseUrl = '';
  if (settingsProvider === 'compatible' && $('set-sendtemp')) patch.sendTemperature = $('set-sendtemp').checked;
  patch.agentStopHotkey = $('set-stophotkey').value.trim() || 'Ctrl+Alt+Esc';
  const mc = parseInt($('set-maxcalls').value, 10);
  if (Number.isFinite(mc)) patch.agentMaxCalls = Math.min(100, Math.max(1, mc));
  patch.requireApprovalForWrites = $('set-reqapprove').checked; // shell_run always needs approval regardless
  const hk = $('set-hotkey') && $('set-hotkey').value.trim();
  if (hk) patch.hotkey = hk;
  if ($('set-login')) patch.launchAtLogin = $('set-login').checked;
  const sug = $('set-suggest').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  if (sug.length) patch.suggestions = sug;
  suggestCache = null;
  await window.nexio.setSettings(patch);
  if ($('set-apikey').value) await window.nexio.setApiKey(patch.provider, $('set-apikey').value);
  $('set-apikey').value = '';
  currentStopHotkey = $('set-stophotkey').value.trim() || 'Ctrl+Alt+Esc';
  void refreshHotkeyStatus();
  void loadPlatform(); // re-read toggle/stop labels (hotkeys may have changed)
  $('settings-status').textContent = 'Saved';
  $('settings-status').classList.remove('ok', 'err');
  setTimeout(() => ($('settings-status').textContent = ''), 1500);
};
$('btn-test-conn').onclick = async () => {
  const btn = $('btn-test-conn');
  if (btn.disabled) return;
  btn.disabled = true;
  const status = $('settings-status');
  status.textContent = 'Testing… (15s max)';
  status.classList.remove('ok', 'err');
  // Main aborts at 15s; this timer only re-enables the UI if invoke never settles.
  const timer = setTimeout(() => {
    status.textContent = 'Test timed out after 15s — check base URL and network.';
    status.classList.add('err');
    btn.disabled = false;
  }, 16000);
  try {
    // Unsaved panel values go straight through; the key field is never logged.
    const r = await window.nexio.testConnectivity(
      settingsProvider, $('set-model').value.trim(),
      $('set-baseurl').value.trim() || undefined, $('set-apikey').value);
    clearTimeout(timer);
    if (r.ok) {
      const d = r.details || {};
      status.textContent = `Works: ${d.provider || settingsProvider} ${d.model || ''} ${d.ms || 0}ms tools ${d.toolsOk === false ? 'fallback' : 'ok'}`;
      status.classList.add('ok');
    } else {
      const act = r.error && r.error.action ? ` — ${testAction(r.error.action)}` : '';
      status.textContent = `Fail: ${(r.error && r.error.message) || 'unknown'}${act}`;
      status.classList.add('err');
    }
  } catch (e) {
    clearTimeout(timer);
    status.textContent = errText(e);
    status.classList.add('err');
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
};
function testAction(a) {
  if (a === 'check-key') return 'check the API key';
  if (a === 'check-model') return 'check the model name';
  if (a === 'shorten') return 'shorten the conversation';
  if (a === 'retry-later') return 'wait and retry';
  if (a === 'reset-fixes') return 'try Reset fixes';
  if (a === 'check-base-url') return 'check the base URL';
  return '';
}
if ($('btn-reset-fixes')) $('btn-reset-fixes').onclick = async () => {
  try { await window.nexio.resetProviderFixes(); } catch { /* best-effort */ }
  const status = $('settings-status');
  status.textContent = 'Provider fixes cleared.';
  status.classList.remove('ok', 'err');
};
// Model suggestions from listModels (best-effort, Anthropic has no listing).
async function refreshModelSuggestions() {
  const dl = $('model-list');
  if (!dl || !window.nexio.listModels) return;
  try {
    const models = await window.nexio.listModels(settingsProvider, $('set-baseurl').value.trim() || undefined);
    dl.innerHTML = '';
    for (const m of (models || []).slice(0, 100)) {
      const o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    }
  } catch { /* suggestions never block settings */ }
}
$('btn-new').onclick = () => void newChat();
async function newChat() {
  const c = await window.nexio.createConversation('New chat');
  convId = c.id; messagesEl.innerHTML = ''; assistantDiv = null;
  showView(null);
  void refreshHistory();
}
async function refreshHistory() {
  const list = await window.nexio.listConversations();
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.textContent = c.title || c.id;
    li.onclick = async () => {
      convId = c.id; messagesEl.innerHTML = '';
      const msgs = await window.nexio.getMessages(c.id);
      for (const m of msgs) addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
      showView('messages');
    };
    ul.appendChild(li);
  }
}
(async () => {
  try {
    const s = await window.nexio.getSettings();
    document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
    mode = s.mode === 'agent' ? 'agent' : 'chat';
    updateModeUI();
    try {
      if (window.nexio.isEncryptionAvailable && !(await window.nexio.isEncryptionAvailable())) {
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
      if (window.nexio && typeof window.nexio.resize === 'function') window.nexio.resize(h);
    } catch { /* preview without bridge */ }
  });
}
function syncChrome() {
  const hasMsgs = messagesEl.children.length > 0;
  const palOpen = currentView === 'palette';
  const panelOpen = currentView === 'settings' || currentView === 'history' || currentView === 'extensions' || currentView === 'onboard';
  const agentActive = (typeof agentRunning === 'function' && agentRunning()) ||
    ($('agent-steps') && $('agent-steps').children.length > 0);
  const idle = !inputEl.value && !hasMsgs && !palOpen && !panelOpen && !agentActive;
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
  const groups = [['PROMPTS', paletteItems.filter((it) => it.source !== 'workflow' && it.source !== 'skill' && it.source !== 'mcp')], ['WORKFLOWS', paletteItems.filter((it) => it.source === 'workflow')], ['SKILLS', paletteItems.filter((it) => it.source === 'skill')], ['MCP', paletteItems.filter((it) => it.source === 'mcp')]];
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
if (window.nexio && typeof window.nexio.onStream === 'function') {
  window.nexio.onStream((ev) => {
    if (ev.done) {
      if (assistantDiv) assistantDiv.classList.remove('streaming');
      setRouteStatus(null);
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
inputEl.addEventListener('focus', () => { syncChrome(); if (!inputEl.value) maybeSuggest(); });
inputEl.addEventListener('blur', () => syncChrome());
// re-assert size on show (resizes sent while hidden are ignored by main)
window.addEventListener('focus', () => requestResize());
if (typeof MutationObserver !== 'undefined' && $('panel')) {
  new MutationObserver(() => { syncChrome(); requestResize(); })
    .observe($('panel'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
async function refreshModelName() {
  try {
    const s = await window.nexio.getSettings();
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
  const st = $('fld-sendtemp');
  if (st) st.classList.toggle('hidden', settingsProvider !== 'compatible');
}
(function () {
  const seg = $('set-prov-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); settingsProvider = b.dataset.prov; paintProv(); void refreshModelSuggestions(); }));
  paintProv();
})();
// Esc: results showing -> collapse + clear; second Esc hides (capture runs before core closer)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (agentRunning()) { // Esc stops a running agent before collapsing anything
    e.stopPropagation();
    stopAgentRun();
    inputEl.focus();
    return;
  }
  const palOpen = !paletteEl.classList.contains('hidden');
  if (palOpen) { e.stopPropagation(); hidePalette(); inputEl.focus(); return; }
  const setOpen = currentView === 'settings';
  const histOpen = currentView === 'history';
  const extOpen = currentView === 'extensions';
  const obOpen = currentView === 'onboard';
  const sugBox = $('suggest');
  if (sugBox && !sugBox.classList.contains('hidden')) { e.stopPropagation(); hideSuggest(); inputEl.focus(); return; }
  if (setOpen || histOpen || extOpen || obOpen) { // dismiss panels before collapsing results
    e.stopPropagation();
    if (currentView === 'onboard') { void skipOnboard(); return; }
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
/* --- Agent mode (appended): step list, approvals, stop, working folder, /log --- */
// var (not let): boot code above calls syncChrome() before this block executes.
var agentState = null; // {runId, rows:Map, answerDiv}
var agentCwd = '';

function agentRunning() { return !!agentState; }

function agentScroll() {
  const view = $('view');
  if (view) view.scrollTop = view.scrollHeight;
}

function syncAgentFooter() {
  const running = agentRunning();
  if ($('btn-stop')) $('btn-stop').classList.toggle('hidden', !running);
  if ($('stop-hint')) $('stop-hint').classList.toggle('hidden', !running);
}

function paintChip() {
  const chip = $('agent-cwd');
  if (!chip) return;
  const label = agentCwd ? agentCwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : 'home';
  chip.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  chip.appendChild(document.createTextNode(' ' + label));
  chip.title = agentCwd || 'Working folder (default: home) — click to change';
}

function finalizeSpinners(except) {
  document.querySelectorAll('#agent-steps .ic.spin').forEach((el) => {
    if (el !== except) { el.classList.remove('spin'); el.innerHTML = stepSvg(ICO_OK); }
  });
}

function addAgentRow(kind, html) {
  const steps = $('agent-steps');
  const row = document.createElement('div');
  row.className = 'astep' + (kind === 'stopped' ? ' stopped-row' : kind === 'error' ? ' error-row' : '');
  row.innerHTML = html;
  steps.appendChild(row);
  agentScroll();
  return row;
}

// why: stroke icons keep the renderer emoji-free; same 14px box as the old glyphs
const ICO_OK = '<path d="M5 12l5 5 9-11"/>';
const ICO_FAIL = '<path d="M6 6l12 12M18 6L6 18"/>';
const ICO_WAIT = '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>';
function stepSvg(path) {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function iconFor(state) {
  if (state === 'run') return '<span class="ic spin" aria-hidden="true"></span>';
  if (state === 'ok') return `<span class="ic" aria-hidden="true">${stepSvg(ICO_OK)}</span>`;
  if (state === 'fail') return `<span class="ic" aria-hidden="true">${stepSvg(ICO_FAIL)}</span>`;
  if (state === 'wait') return `<span class="ic" aria-hidden="true">${stepSvg(ICO_WAIT)}</span>`;
  return '<span class="ic" aria-hidden="true">•</span>';
}

function fmtDur(ms) {
  if (ms == null) return '';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
}

function respondApproval(runId, callId, decision) {
  return window.nexio.agentApprove(runId, callId, decision).catch(() => {
    addAgentRow('error', iconFor('fail') + '<div class="tx">Approval failed to send.</div>');
  });
}

function buildApprovalCard(runId, ev) {
  const card = document.createElement('div');
  card.className = 'appr';
  card.dataset.runId = runId;
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', `Approve ${ev.tool}`);
  const risk = ev.risk || 'read';
  const mcpM = /^mcp__([^_]+)__(.+)$/.exec(ev.tool || '');
  card.innerHTML =
    `<div class="top"><span class="risk ${esc(risk)}">${esc(risk)}</span><span class="tool">${esc(ev.tool)}</span>` +
    (mcpM ? `<span class="mcpsrv">MCP ${esc(mcpM[1])}</span>` : '') + `</div>` +
    `<p class="want">Nexio wants to:</p>` +
    `<p class="exact">${esc(ev.summary || ev.tool)}</p>` +
    (ev.afterUntrusted ? `<p class="untrusted-note">Requested after reading ${esc(ev.afterUntrusted)}</p>` : '') +
    `<div class="btns"><button class="btn-always" type="button">Always allow…</button>` +
    `<button class="btn-deny" type="button">Deny</button>` +
    `<button class="btn-allow" type="button">Allow once</button></div>`;
  const btnAllow = card.querySelector('.btn-allow');
  const btnDeny = card.querySelector('.btn-deny');
  const btnAlways = card.querySelector('.btn-always');
  btnAllow.onclick = () => { card.remove(); void respondApproval(runId, ev.id, 'allow-once'); };
  btnDeny.onclick = () => { card.remove(); void respondApproval(runId, ev.id, 'deny'); };
  btnAlways.onclick = () => {
    if (card.querySelector('.scope-row')) return;
    const row = document.createElement('div');
    row.className = 'scope-row';
    // Destructive: exact saved commands only, never a folder wildcard.
    if (risk === 'destructive') {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'This exact command';
      b.onclick = () => { card.remove(); void respondApproval(runId, ev.id, 'always'); };
      row.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'This tool in this folder';
      b.onclick = () => { card.remove(); void respondApproval(runId, ev.id, 'always'); };
      row.appendChild(b);
    }
    card.appendChild(row);
    const first = row.querySelector('button');
    if (first) first.focus();
  };
  card.addEventListener('keydown', (e) => {
    // Enter activates the focused control (see shared/approval.ts: a focused
    // Deny/Always/scope button must fire natively). Only a non-button target
    // means Allow once. Getting this wrong inverts intent on destructive actions.
    if (e.key === 'Enter') {
      e.stopPropagation();
      const tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' && e.target !== btnAllow) return;
      e.preventDefault();
      btnAllow.click();
    } else if (e.key === 'Escape') {
      // Esc here means Deny, not stop-the-run.
      e.preventDefault();
      e.stopPropagation();
      btnDeny.click();
    }
  });
  // Destructive defaults focus to Deny, write defaults to Allow once. Never auto-approve.
  setTimeout(() => { try { (risk === 'destructive' ? btnDeny : btnAllow).focus(); } catch {} }, 30);
  return card;
}

function handleAgentEvent(runId, ev) {
  const st = agentState;
  if (!st) return;
  if (ev.type === 'step') {
    finalizeSpinners();
    addAgentRow('step', iconFor('run') + `<div class="tx">${esc(ev.text || 'Working…')}</div>`);
  } else if (ev.type === 'tool_call') {
    finalizeSpinners();
    const row = addAgentRow('tool',
      iconFor('run') + `<div class="tx"><span class="tool-name">${esc(ev.tool)}</span> ` +
      `<span>${esc(ev.summary || '')}</span>` +
      (ev.afterUntrusted ? `<div class="untrusted-note" style="font-size:12px;color:var(--warn)">Requested after reading ${esc(ev.afterUntrusted)}</div>` : '') +
      `</div><span class="dur"></span>`);
    st.rows.set(ev.id, row);
  } else if (ev.type === 'approval_request') {
    finalizeSpinners();
    let row = st.rows.get(ev.id);
    if (!row) {
      row = addAgentRow('tool',
        iconFor('wait') + `<div class="tx"><span class="tool-name">${esc(ev.tool)}</span> ` +
        `<span>${esc(ev.summary || '')}</span></div><span class="dur"></span>`);
      st.rows.set(ev.id, row);
    } else {
      const ic = row.querySelector('.ic');
      if (ic) { ic.classList.remove('spin'); ic.innerHTML = stepSvg(ICO_WAIT); }
    }
    row.appendChild(buildApprovalCard(runId, ev));
    agentScroll();
  } else if (ev.type === 'tool_result') {
    const row = st.rows.get(ev.id);
    const dur = fmtDur(ev.durationMs);
    if (row) {
      const ic = row.querySelector('.ic');
      if (ic) { ic.classList.remove('spin'); ic.innerHTML = stepSvg(ev.ok ? ICO_OK : ICO_FAIL); }
      const d = row.querySelector('.dur');
      if (d && dur) d.textContent = dur;
      const tx = row.querySelector('.tx');
      if (tx && ev.output) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'show-out';
        btn.textContent = 'Show output';
        btn.setAttribute('aria-expanded', 'false');
        btn.onclick = () => {
          const pre = row.querySelector('pre.out');
          if (pre) {
            const open = !pre.classList.contains('hidden');
            pre.classList.toggle('hidden', open);
            btn.textContent = open ? 'Show output' : 'Hide output';
            btn.setAttribute('aria-expanded', String(!open));
          } else {
            const p = document.createElement('pre');
            p.className = 'out';
            p.textContent = ev.output;
            tx.appendChild(p);
            btn.textContent = 'Hide output';
            btn.setAttribute('aria-expanded', 'true');
          }
          agentScroll();
          requestResize();
        };
        tx.appendChild(btn);
      }
    } else {
      addAgentRow('tool', iconFor(ev.ok ? 'ok' : 'fail') +
        `<div class="tx">${esc(ev.output || '')}</div><span class="dur">${esc(dur)}</span>`);
    }
    agentScroll();
  } else if (ev.type === 'text_delta') {
    finalizeSpinners();
    if (!st.answerDiv) st.answerDiv = addMsg('assistant', '');
    st.answerDiv.dataset.raw = (st.answerDiv.dataset.raw || '') + ev.text;
    st.answerDiv.innerHTML = mdLite(st.answerDiv.dataset.raw);
    agentScroll();
  } else if (ev.type === 'done') {
    finalizeSpinners();
    if (st.answerDiv) st.answerDiv.classList.remove('streaming');
    collapseSteps();
    clearRunCards(runId);
    endAgentRun();
    renderRunChips(runId);
    setRouteStatus(null);
    syncChrome();
    requestResize();
  } else if (ev.type === 'error') {
    finalizeSpinners();
    addAgentRow('error', iconFor('fail') + `<div class="tx">${esc(ev.message || 'Error')}</div>`);
    setRouteStatus(null);
    clearRunCards(runId);
    endAgentRun();
  } else if (ev.type === 'stopped') {
    finalizeSpinners();
    addAgentRow('stopped', iconFor('fail') + '<div class="tx">Stopped — nothing is still running.</div>');
    setRouteStatus(null);
    clearRunCards(runId);
    endAgentRun();
  }
  syncAgentFooter();
  syncChrome();
  requestResize();
}

async function startAgentRun(text) {
  const id = await beginRun(text);
  try {
    const r = await window.nexio.agentStart(id, text, { cwd: agentCwd || undefined });
    if (!agentState) return;
    agentState.runId = r && r.runId;
  } catch (e) {
    addAgentRow('error', iconFor('fail') + `<div class="tx">${esc(errText(e))}</div>`);
    endAgentRun();
  }
}

async function beginRun(userText) {
  const id = await ensureConv();
  agentState = { runId: null, rows: new Map(), answerDiv: null };
  const oldChips = $('run-chips');
  if (oldChips) oldChips.remove();
  const steps = $('agent-steps');
  if (steps) { steps.innerHTML = ''; steps.classList.remove('hidden'); steps.classList.remove('collapsed'); }
  addMsg('user', userLabel(userText));
  assistantDiv = null;
  showView('messages');
  if (steps) steps.classList.remove('hidden');
  syncAgentFooter();
  syncChrome();
  requestResize();
  return id;
}

async function startWorkflowRun(trigger, inputs) {
  if (agentRunning()) return;
  await beginRun(trigger);
  try {
    const r = await window.nexio.ext({ action: 'workflowRun', trigger, inputs: inputs || {} });
    if (!agentState) return;
    agentState.runId = r && r.runId;
  } catch (e) {
    addAgentRow('error', iconFor('fail') + `<div class="tx">${esc(errText(e))}</div>`);
    endAgentRun();
  }
}

function stopAgentRun() {
  if (!agentState) return;
  try {
    window.nexio.agentStop(agentState.runId || undefined);
  } catch { /* main aborts; stopped event follows */ }
}

function endAgentRun() {
  agentState = null;
  assistantDiv = null;
  syncAgentFooter();
  syncChrome();
  requestResize();
}

/** Remove this run's undecided approval cards (stopped/error/done leave them stale). */
function clearRunCards(runId) {
  document.querySelectorAll('.appr').forEach((c) => {
    if (c.dataset.runId === runId) c.remove();
  });
  requestResize();
}

async function showAgentLog() {
  try {
    const log = await window.nexio.agentLog();
    if (!log) { addMsg('assistant', 'No agent logs yet.'); return; }
    const tail = String(log.content || '').slice(-3000);
    addMsg('assistant', `**Latest agent log:** ${log.path}\n\`\`\`\n${tail}\n\`\`\``);
  } catch (e) {
    addMsg('assistant', errText(e));
  }
}

function paintAgentRoots(roots) {
  const ul = $('agent-roots');
  if (!ul) return;
  ul.innerHTML = '';
  (roots || []).forEach((r) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = r;
    span.title = r;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', `Remove ${r}`);
    btn.onclick = async () => {
      const s = await window.nexio.getSettings();
      const next = (s.agentAllowedRoots || []).filter((x) => x !== r);
      await window.nexio.setSettings({ agentAllowedRoots: next });
      paintAgentRoots(next);
    };
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function ruleLabel(r) {
  if (!r) return '';
  if (r.scope === 'exact-command') return `shell: ${r.command || ''}`;
  return `${r.tool || '?'} in ${r.dir || ''}`;
}

function paintAgentRules(rules) {
  const ul = $('agent-rules');
  if (!ul) return;
  ul.innerHTML = '';
  if (!rules || !rules.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = 'none';
    li.appendChild(span);
    ul.appendChild(li);
    return;
  }
  rules.forEach((r, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = ruleLabel(r);
    span.title = ruleLabel(r);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Revoke';
    btn.setAttribute('aria-label', `Revoke ${ruleLabel(r)}`);
    btn.onclick = async () => {
      const s = await window.nexio.getSettings();
      const next = (s.agentAlwaysAllow || []).filter((_, j) => j !== i);
      await window.nexio.setSettings({ agentAlwaysAllow: next });
      paintAgentRules(next);
    };
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

// agent chrome wiring (appended; core chat flow above untouched)
function setRouteStatus(s) {
  const el = $('route-status');
  if (!el) return;
  if (!s) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = s === 'doing' ? 'Doing' : 'Answering';
  el.classList.remove('hidden');
}
// run summaries keyed by runId (undo availability + folder for chips)
var runSummaries = {};
if (window.nexio && typeof window.nexio.onRouteStatus === 'function') {
  window.nexio.onRouteStatus(({ status }) => setRouteStatus(status));
}
if (window.nexio && typeof window.nexio.onRunSummary === 'function') {
  window.nexio.onRunSummary((ev) => {
    runSummaries[ev.runId] = ev;
    renderRunChips(ev.runId);
  });
}
if (window.nexio && typeof window.nexio.onPopupShown === 'function') {
  // Every hotkey opening defaults to Do unless the user picked a mode this session.
  window.nexio.onPopupShown(() => {
    try {
      if (!modeExplicitSession && mode !== 'agent') setMode('agent', false);
      // Content rendered while hidden never resized the window (main ignores
      // resize when hidden, but the renderer's baseline already moved on).
      // Force a fresh measurement on every show.
      _lastH = 0;
      syncChrome(); requestResize();
      inputEl.focus();
    } catch { /* preview */ }
  });
}
if (window.nexio && typeof window.nexio.onAgentEvent === 'function') {
  window.nexio.onAgentEvent(({ runId, event }) => {
    if (!agentState) {
      // Routed act (or undo) with no active run: adopt it so steps/approvals render.
      if (event.type === 'done' || event.type === 'error' || event.type === 'stopped') return;
      agentState = { runId, rows: new Map(), answerDiv: assistantDiv };
      const steps = $('agent-steps');
      if (steps) steps.classList.remove('hidden');
      showView('messages');
      syncAgentFooter();
    }
    if (agentState.runId && agentState.runId !== runId) return;
    if (!agentState.runId) agentState.runId = runId;
    handleAgentEvent(runId, event);
  });
}
if ($('btn-stop')) $('btn-stop').onclick = () => { stopAgentRun(); inputEl.focus(); };
if ($('btn-log')) $('btn-log').onclick = () => void showAgentLog();
if ($('agent-cwd')) $('agent-cwd').onclick = async () => {
  try {
    const picked = await window.nexio.agentPickFolder();
    if (picked) {
      agentCwd = picked;
      paintChip();
      await window.nexio.setSettings({ agentCwd: picked });
    }
  } catch { /* picker cancelled */ }
};
if ($('btn-privacy')) $('btn-privacy').onclick = async () => {
  try { await window.nexio.openPrivacySettings(); } catch { /* macOS only */ }
};
if ($('btn-agent-add-root')) $('btn-agent-add-root').onclick = async () => {  try {
    const picked = await window.nexio.agentPickFolder();
    if (!picked) return;
    const s = await window.nexio.getSettings();
    const next = [...(s.agentAllowedRoots || [])];
    if (!next.includes(picked)) next.push(picked);
    await window.nexio.setSettings({ agentAllowedRoots: next });
    paintAgentRoots(next);
  } catch { /* picker cancelled */ }
};
(function initAgentChrome() {
  paintChip();
  syncAgentFooter();
  void loadPlatform();
  if (window.nexio && window.nexio.getSettings) {
    window.nexio.getSettings().then((s) => {
      agentCwd = (s && s.agentCwd) || '';
      paintChip();
      const hint = $('stop-hint');
      if (hint && s && s.agentStopHotkey) hint.title = s.agentStopHotkey;
    }).catch(() => {});
  }
})();
/* --- Extensions (appended): skills | MCP | hooks | workflows management --- */
var pendingSkill = null; // {name, body} armed by /<skill>, consumed by the next agent send
var extTab = 'skills';
var extData = null; // {records, mcp, hooks}
var extSel = null; // selected record id
var extSub = null; // {view:'add'} | {view:'install', preview, source} | {view:'update', id, preview, added, grew, source} | {view:'trust', trust, onTrust}

function extCall(a) { return window.nexio.ext(a); }

function openExtensions() {
  extSub = null;
  showView('extensions');
  void refreshExtensions();
}

async function refreshExtensions() {
  const box = $('extensions');
  if (!box) return;
  try {
    extData = await extCall({ action: 'list' });
  } catch (e) {
    box.innerHTML = `<div class="set-head"><h3>Extensions</h3><button id="btn-ext-back" class="btn-icon" aria-label="Back" title="Back (Esc)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button></div>` +
      `<div class="msg assistant">${esc(errText(e))}</div>`;
    $('btn-ext-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
    syncChrome(); requestResize();
    return;
  }
  renderExtensions();
  syncChrome(); requestResize();
}

function extRecords(kind) {
  return ((extData && extData.records) || []).filter((r) => r.kind === kind);
}

function dotFor(status) {
  const cls = status === 'ready' ? 'ok' : status === 'starting' ? 'warn' : status === 'error' ? 'err' : 'off';
  return `<span class="dot ${cls}" aria-hidden="true"></span>`;
}

function renderExtensions() {
  const box = $('extensions');
  const tabs = [['skills', 'Skills'], ['mcp', 'MCP'], ['hooks', 'Hooks'], ['workflows', 'Workflows']];
  let html = `<div class="set-head"><h3>Extensions</h3><button id="btn-ext-back" class="btn-icon" aria-label="Back" title="Back (Esc)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button></div>` +
    `<div class="seg ext-tabs" role="group" aria-label="Extension kind">` +
    tabs.map(([k, lb]) => `<button data-tab="${k}" class="${k === extTab ? 'on' : ''}">${lb}</button>`).join('') +
    `</div><div id="ext-body"></div>` +
    `<div class="row ext-add-row"><button id="btn-ext-add">Add ${extTab === 'mcp' ? 'server' : extTab.replace(/s$/, '')}</button></div>`;
  box.innerHTML = html;
  $('btn-ext-back').onclick = () => { showView(defaultView()); inputEl.focus(); };
  box.querySelectorAll('.ext-tabs button').forEach((b) => {
    b.onclick = () => { extTab = b.dataset.tab; extSel = null; extSub = null; renderExtensions(); syncChrome(); requestResize(); };
  });
  $('btn-ext-add').onclick = () => { extSub = { view: 'add' }; renderExtensions(); syncChrome(); requestResize(); };
  renderExtBody();
}

function renderExtBody() {
  const body = $('ext-body');
  if (!body) return;
  if (extSub && extSub.view === 'add') return void renderExtAdd(body);
  if (extSub && extSub.view === 'install') return void renderExtInstall(body, extSub);
  if (extSub && extSub.view === 'update') return void renderExtUpdate(body, extSub);
  if (extSub && extSub.view === 'trust') return void renderExtTrust(body, extSub);
  if (extSel) return void renderExtDetail(body, extSel);
  if (extTab === 'skills') return void renderExtList(body, 'skill', 'No skills installed. Skills add reusable instructions and /commands.');
  if (extTab === 'workflows') return void renderExtList(body, 'workflow', 'No workflows installed. Workflows are reusable multi-step slash commands.');
  if (extTab === 'mcp') return void renderExtList(body, 'mcp', 'No MCP servers installed. MCP servers add tools from local programs or https endpoints.');
  return void renderHooksList(body);
}

function extRow(r, statusHtml, sub) {
  return `<div class="ext-row" data-id="${esc(r.id)}" role="button" tabindex="0">` +
    `<div class="ext-row-tx"><div class="ext-name">${esc(r.name)}${r.tampered ? ' <span class="ext-flag">modified on disk</span>' : ''}</div>` +
    `<div class="ext-desc">${esc(sub || (r.capabilities && r.capabilities[0]) || r.kind)}</div></div>` +
    `<div class="ext-right">${statusHtml}<button class="exttgl ${r.enabled ? 'on' : ''}" aria-label="${r.enabled ? 'Disable' : 'Enable'} ${esc(r.name)}">${r.enabled ? 'On' : 'Off'}</button></div></div>`;
}

function renderExtList(body, kind, emptyText) {
  const rows = extRecords(kind);
  let html = '';
  if (!rows.length) html += `<div class="ext-empty">${esc(emptyText)}</div>`;
  if (kind === 'mcp') {
    const byName = {};
    ((extData && extData.mcp) || []).forEach((m) => { byName[m.name] = m; });
    html += rows.map((r) => {
      const srvs = r.servers || [];
      const worst = srvs.some((n) => byName[n] && byName[n].status === 'error') ? 'error'
        : srvs.some((n) => byName[n] && byName[n].status === 'starting') ? 'starting'
        : srvs.some((n) => byName[n] && byName[n].status === 'ready') ? 'ready' : 'off';
      const tools = srvs.reduce((n, s) => n + (byName[s] ? byName[s].tools : 0), 0);
      return extRow(r, `${dotFor(worst)}<span class="ext-tools">${tools} tools</span><button class="extmini" data-restart="${esc(r.id)}">Restart</button>`,
        `${srvs.join(', ') || 'no servers'} — ${r.enabled ? 'enabled' : 'off'}`);
    }).join('');
  } else {
    html += rows.map((r) => extRow(r, dotFor(r.enabled ? (r.tampered ? 'error' : 'ready') : 'off'),
      kind === 'skill' ? `/${esc(r.name)} — ${r.enabled ? 'enabled' : 'off'}` : `${r.enabled ? 'enabled' : 'off'}`)).join('');
  }
  body.innerHTML = html;
  wireExtRows(body);
}

function wireExtRows(body) {
  body.querySelectorAll('.ext-row').forEach((row) => {
    const open = () => { extSel = row.dataset.id; renderExtensions(); syncChrome(); requestResize(); };
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      open();
    };
    row.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  body.querySelectorAll('.exttgl').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const row = btn.closest('.ext-row');
      const id = row && row.dataset.id;
      try {
        const rec = extRecords('skill').concat(extRecords('mcp'), extRecords('hook'), extRecords('workflow')).find((r) => r.id === id);
        if (rec && rec.enabled) await extCall({ action: 'disable', id });
        else {
          const r = await extCall({ action: 'enable', id });
          if (r && r.status === 'needs-trust') {
            extSub = { view: 'trust', trust: r.trust, onTrust: () => extCall({ action: 'trust', id }) };
            renderExtensions(); syncChrome(); requestResize();
            return;
          }
        }
      } catch (err) { addMsg('assistant', errText(err)); }
      await refreshExtensions();
    };
  });
  body.querySelectorAll('[data-restart]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const rec = extRecords('mcp').find((r) => r.id === btn.dataset.restart);
      try {
        for (const srv of (rec && rec.servers) || []) {
          const cur = ((extData && extData.mcp) || []).find((m) => m.name === srv);
          if (cur && cur.status === 'ready') await extCall({ action: 'mcp', op: 'restart', server: srv });
          else await extCall({ action: 'mcp', op: 'trust-start', server: srv });
        }
      } catch (err) { addMsg('assistant', errText(err)); }
      await refreshExtensions();
    };
  });
}

function renderHooksList(body) {
  const hooks = (extData && extData.hooks) || [];
  let html = '';
  if (!hooks.length) html += '<div class="ext-empty">No hooks installed. Hooks run commands on agent events.</div>';
  html += hooks.map((h, i) => `<div class="ext-row" data-hi="${i}"><div class="ext-row-tx">` +
    `<div class="ext-name">${esc(h.event)}${h.matcher ? ` <span class="ext-muted">${esc(h.matcher)}</span>` : ''}</div>` +
    `<div class="ext-desc">${esc(typeof h.command === 'string' ? h.command : (h.commandDisplay || JSON.stringify(h.command)))}${h.extId ? ` <span class="ext-muted">(${esc(h.extId)})</span>` : ''}</div></div>` +
    `<div class="ext-right">${dotFor(h.enabled === false ? 'off' : 'ready')}` +
    `<button class="exttgl ${h.enabled === false ? '' : 'on'}" data-hts="${i}" aria-label="Toggle hook">${h.enabled === false ? 'Off' : 'On'}</button></div></div>`).join('');
  html += `<div class="fld"><span class="flab">Add hook (event + command)</span>` +
    `<div class="row"><select id="hook-ev" aria-label="Event">` +
    ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'ApprovalRequested', 'RunStopped', 'RunDone'].map((ev) => `<option>${ev}</option>`).join('') +
    `</select><input id="hook-cmd" placeholder="command" class="mono" aria-label="Command" /></div>` +
    `<div class="row"><input id="hook-match" placeholder="tool glob, e.g. shell_* (optional)" class="mono" aria-label="Tool matcher" />` +
    `<button id="hook-add">Add</button></div></div>`;
  body.innerHTML = html;
  body.querySelectorAll('[data-hts]').forEach((btn) => {
    btn.onclick = async () => {
      const h = hooks[Number(btn.dataset.hts)];
      try {
        await extCall({ action: 'hookSet', event: h.event, command: h.command, extId: h.extId, enabled: h.enabled === false });
      } catch (err) { addMsg('assistant', errText(err)); }
      await refreshExtensions();
    };
  });
  const addBtn = body.querySelector('#hook-add');
  if (addBtn) addBtn.onclick = async () => {
    const ev = body.querySelector('#hook-ev').value;
    const command = body.querySelector('#hook-cmd').value.trim();
    const matcher = body.querySelector('#hook-match').value.trim();
    if (!command) return;
    try {
      await extCall({ action: 'hookSet', event: ev, command, matcher: matcher || undefined, enabled: true });
      await refreshExtensions();
    } catch (err) { addMsg('assistant', errText(err)); }
  };
}

function renderExtDetail(body, id) {
  const rec = extRecords('skill').concat(extRecords('mcp'), extRecords('hook'), extRecords('workflow')).find((r) => r.id === id);
  if (!rec) { extSel = null; return void renderExtBody(); }
  let html = `<button class="extback" id="ext-back">← All ${esc(extTab)}</button>` +
    `<h4 class="ext-title">${esc(rec.name)}</h4>` +
    `<div class="ext-meta">${esc(rec.kind)} · v${esc(rec.version || '?')}${rec.author ? ` · ${esc(rec.author)}` : ''}<br>${esc((rec.source && rec.source.detail) || '')}</div>`;
  if (rec.tampered) html += '<div class="ext-warn">Modified on disk — disabled. Remove and reinstall to re-approve.</div>';
  html += `<div class="fld"><span class="flab">This extension can:</span><ul class="can-list">` +
    (rec.capabilities || []).map((c) => `<li>${esc(c)}</li>`).join('') + `</ul></div>`;
  if (rec.kind === 'mcp') html += mcpDetailHtml(rec);
  if (rec.kind === 'workflow') html += `<div class="row"><button id="ext-run">Run</button><button id="ext-export">Export</button></div>`;
  html += `<div class="row"><button id="ext-toggle">${rec.enabled ? 'Disable' : 'Enable'}</button>` +
    `<button id="ext-update">Update</button><button id="ext-remove" class="danger">Remove</button></div>` +
    `<div class="row"><button id="ext-src-tgl" class="linklike">View source</button></div><div id="ext-src"></div>`;
  body.innerHTML = html;
  $('ext-back').onclick = () => { extSel = null; renderExtensions(); syncChrome(); requestResize(); };
  $('ext-toggle').onclick = async () => {
    try {
      if (rec.enabled) await extCall({ action: 'disable', id });
      else {
        const r = await extCall({ action: 'enable', id });
        if (r && r.status === 'needs-trust') {
          extSub = { view: 'trust', trust: r.trust, onTrust: () => extCall({ action: 'trust', id }) };
          renderExtensions(); syncChrome(); requestResize();
          return;
        }
      }
    } catch (err) { addMsg('assistant', errText(err)); }
    await refreshExtensions();
  };
  $('ext-update').onclick = () => { extSub = { view: 'update', id, source: null }; renderExtensions(); syncChrome(); requestResize(); };
  $('ext-remove').onclick = async () => {
    if (!window.confirm || !window.confirm(`Remove ${rec.kind} "${rec.name}"? Files, secrets and its rules are deleted.`)) return;
    try { await extCall({ action: 'remove', id }); } catch (err) { addMsg('assistant', errText(err)); }
    extSel = null;
    await refreshExtensions();
  };
  $('ext-src-tgl').onclick = async () => {
    const box = $('ext-src');
    if (box.dataset.loaded) { box.innerHTML = ''; delete box.dataset.loaded; requestResize(); return; }
    try {
      const files = await extCall({ action: 'source', id });
      box.innerHTML = files.map((f) => `<div class="flab">${esc(f.path)}${f.truncated ? ' (truncated)' : ''}</div><pre class="srcview">${esc(f.content)}</pre>`).join('');
      box.dataset.loaded = '1';
    } catch (err) { box.innerHTML = `<div class="ext-empty">${esc(errText(err))}</div>`; }
    requestResize();
  };
  const runBtn = $('ext-run');
  if (runBtn) runBtn.onclick = async () => {
    try {
      const info = await extCall({ action: 'workflowInfo', trigger: `/${rec.name}` });
      if (info && info.kind === 'ext' && info.inputs && info.inputs.length) openWorkflowForm(`/${rec.name}`, info);
      else if (info) await startWorkflowRun(`/${rec.name}`, {});
      else addMsg('assistant', `Workflow /${esc(rec.name)} not found.`);
    } catch (err) { addMsg('assistant', errText(err)); }
  };
  const expBtn = $('ext-export');
  if (expBtn) expBtn.onclick = async () => {
    try {
      const out = await extCall({ action: 'export', id });
      const text = `**${esc(out.filename)}**\n\`\`\`json\n${out.content}\n\`\`\``;
      addMsg('assistant', text);
      try { await navigator.clipboard.writeText(out.content); } catch { /* clipboard optional */ }
    } catch (err) { addMsg('assistant', errText(err)); }
  };
  wireMcpDetail(body);
}

function mcpDetailHtml(rec) {
  const states = {};
  ((extData && extData.mcp) || []).forEach((m) => { states[m.name] = m; });
  return (rec.servers || []).map((srv) => {
    const m = states[srv] || { status: 'stopped', tools: 0, prompts: [], error: '' };
    const tools = (m.toolDefs || []).map((t) => {
      const full = `mcp__${srv}__${t.name}`;
      const cur = (rec.toolPolicy && rec.toolPolicy[full]) || 'ask';
      return `<li><span>${esc(t.name)} — ${esc((t.description || '').slice(0, 80))}</span>` +
        `<select data-srv="${esc(srv)}" data-tool="${esc(t.name)}" aria-label="Policy for ${esc(t.name)}">` +
        ['ask', 'allow', 'block'].map((p) => `<option value="${p}"${p === cur ? ' selected' : ''}>${p === 'ask' ? 'Ask every time' : p === 'allow' ? 'Always allow' : 'Block'}</option>`).join('') +
        `</select></li>`;
    }).join('');
    return `<div class="fld"><span class="flab">Server ${esc(srv)} ${dotFor(m.status)}${m.error ? ` — ${esc(m.error)}` : ''}</span>` +
      `<div class="row"><button data-mcp="trust-start:${esc(srv)}">Trust and start</button>` +
      `<button data-mcp="restart:${esc(srv)}">Restart</button><button data-mcp="stop:${esc(srv)}">Stop</button></div>` +
      (tools ? `<ul class="agent-list">${tools}</ul>` : `<div class="ext-empty">${m.status === 'ready' ? 'No tools exposed.' : 'Start the server to list its tools.'}</div>`) +
      `</div>`;
  }).join('');
}

function wireMcpDetail(body) {
  body.querySelectorAll('[data-mcp]').forEach((btn) => {
    btn.onclick = async () => {
      const [op, srv] = btn.dataset.mcp.split(/:(.+)/);
      try {
        await extCall({ action: 'mcp', op, server: srv });
      } catch (err) {
        if (/trust-required/i.test(errText(err))) {
          try {
            const info = await extCall({ action: 'mcp', op: 'info', server: srv });
            extSub = { view: 'trust', trust: info, onTrust: () => extCall({ action: 'mcp', op: 'trust-start', server: srv }) };
            renderExtensions(); syncChrome(); requestResize();
            return;
          } catch (err2) { addMsg('assistant', errText(err2)); }
        } else addMsg('assistant', errText(err));
      }
      await refreshExtensions();
    };
  });
  body.querySelectorAll('select[data-srv]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await extCall({ action: 'mcpToolPolicy', server: sel.dataset.srv, tool: sel.dataset.tool, policy: sel.value });
      } catch (err) { addMsg('assistant', errText(err)); }
      await refreshExtensions();
    };
  });
}

function renderExtAdd(body) {
  const kind = extTab === 'mcp' ? 'mcp' : extTab === 'hooks' ? 'hook' : extTab === 'workflows' ? 'workflow' : 'skill';
  body.innerHTML = `<button class="extback" id="ext-back">← Back</button>` +
    `<h4 class="ext-title">Add ${esc(kind)}</h4>` +
    `<div class="ext-addmenu">` +
    `<button data-add="folder">From folder</button>` +
    `<button data-add="file">From file / zip</button>` +
    `<button data-add="url">From URL (git)</button>` +
    `<button data-add="paste">Paste ${kind === 'skill' ? 'Markdown' : 'JSON'}</button></div><div id="ext-addform"></div>`;
  $('ext-back').onclick = () => { extSub = null; renderExtensions(); syncChrome(); requestResize(); };
  body.querySelectorAll('[data-add]').forEach((btn) => {
    btn.onclick = () => renderExtAddForm(kind, btn.dataset.add);
  });
}

function renderExtAddForm(kind, which) {
  const form = $('ext-addform');
  if (!form) return;
  if (which === 'folder') {
    form.innerHTML = `<div class="row"><button id="add-pick-folder">Choose folder…</button></div>`;
    $('add-pick-folder').onclick = async () => {
      try {
        const p = await window.nexio.agentPickFolder();
        if (!p) return;
        await showInstallPreview({ sourceType: 'folder', path: p });
      } catch (err) { addMsg('assistant', errText(err)); }
    };
  } else if (which === 'file') {
    form.innerHTML = `<div class="row"><button id="add-pick-file">Choose file…</button></div>`;
    $('add-pick-file').onclick = async () => {
      try {
        const p = await window.nexio.ext({ action: 'pickFile' });
        if (!p) return;
        await showInstallPreview({ sourceType: 'file', path: p });
      } catch (err) { addMsg('assistant', errText(err)); }
    };
  } else if (which === 'url') {
    form.innerHTML = `<div class="fld"><span class="flab">Git URL (https only)</span>` +
      `<div class="row"><input id="add-url" placeholder="https://…" class="mono" aria-label="Git URL" /><button id="add-url-go">Load</button></div></div>`;
    $('add-url-go').onclick = async () => {
      const url = $('add-url').value.trim();
      if (!url) return;
      try { await showInstallPreview({ sourceType: 'git', url }); }
      catch (err) { addMsg('assistant', errText(err)); }
    };
  } else {
    form.innerHTML = `<div class="fld"><span class="flab">Paste ${kind === 'skill' ? 'SKILL.md' : kind === 'workflow' ? 'workflow JSON' : kind === 'mcp' ? 'servers JSON (e.g. {"mcpServers": {...}})' : 'hooks JSON array'}</span>` +
      `<textarea id="add-paste" class="mono ext-paste" aria-label="Pasted snippet"></textarea>` +
      `<div class="row"><button id="add-paste-go">Review</button></div></div>`;
    $('add-paste-go').onclick = async () => {
      const text = $('add-paste').value;
      if (!text.trim()) return;
      try { await showInstallPreview({ sourceType: 'paste', kind, text }); }
      catch (err) { addMsg('assistant', errText(err)); }
    };
  }
  requestResize();
}

async function showInstallPreview(source) {
  const preview = await extCall({ action: 'preview', source });
  extSub = { view: 'install', preview, source };
  renderExtensions(); syncChrome(); requestResize();
}

function renderExtInstall(body, sub) {
  const p = sub.preview;
  body.innerHTML = `<button class="extback" id="ext-back">← Back</button>` +
    `<h4 class="ext-title">Install ${esc(p.kind)} "${esc(p.name)}"</h4>` +
    `<div class="ext-meta">v${esc(p.version || '?')}${p.author ? ` · ${esc(p.author)}` : ''} · ${(p.files || []).length} files</div>` +
    `<div class="fld"><span class="flab">This extension can:</span><ul class="can-list">` +
    (p.capabilities || []).map((c) => `<li>${esc(c)}</li>`).join('') + `</ul></div>` +
    (p.trust ? `<div class="trustbox"><div class="flab">${esc(p.trust.title)}</div><ul class="can-list">` +
      p.trust.lines.map((l) => `<li>${esc(l)}</li>`).join('') + `</ul></div>` : '') +
    `<div class="row"><button id="ext-src-tgl" class="linklike">View source (${(p.files || []).length} files)</button></div>` +
    `<div class="row"><button id="ext-cancel">Cancel</button>` +
    `<button id="ext-install">Install (disabled)</button>` +
    `<button id="ext-install-enable" class="primary">Install and enable</button></div>`;
  $('ext-back').onclick = () => { extSub = { view: 'add' }; renderExtensions(); syncChrome(); requestResize(); };
  $('ext-cancel').onclick = () => { extSub = null; renderExtensions(); syncChrome(); requestResize(); };
  $('ext-src-tgl').onclick = async () => {
    addMsg('assistant', `**${esc(p.kind)}/${esc(p.name)}** files:\n\`\`\`\n${(p.files || []).join('\n')}\n\`\`\``);
  };
  const doInstall = async (enable) => {
    try {
      const r = await extCall({ action: 'install', source: sub.source, enable });
      if (r && r.status === 'needs-trust') {
        extSub = { view: 'trust', trust: r.preview.trust, onTrust: () => extCall({ action: 'trust', id: `${p.kind}:${p.name}` }) };
        renderExtensions(); syncChrome(); requestResize();
        return;
      }
      const id = r && r.record && r.record.id;
      addMsg('assistant', `Installed ${esc(p.kind)} "${esc(p.name)}" (disabled). Enable it in Extensions when ready.`);
      extSub = null; extSel = id || null;
      await refreshExtensions();
    } catch (err) { addMsg('assistant', errText(err)); }
  };
  $('ext-install').onclick = () => void doInstall(false);
  $('ext-install-enable').onclick = () => void doInstall(true);
}

function renderExtUpdate(body, sub) {
  body.innerHTML = `<button class="extback" id="ext-back">← Back</button>` +
    `<h4 class="ext-title">Update</h4><div id="ext-updateform"></div>`;
  $('ext-back').onclick = () => { extSub = null; renderExtensions(); syncChrome(); requestResize(); };
  const form = $('ext-updateform');
  form.innerHTML = `<div class="ext-addmenu"><button data-u="folder">From folder</button>` +
    `<button data-u="file">From file / zip</button><button data-u="url">From URL</button></div><div id="ext-upick"></div>`;
  form.querySelectorAll('[data-u]').forEach((btn) => {
    btn.onclick = async () => {
      const which = btn.dataset.u;
      let source = null;
      try {
        if (which === 'folder') {
          const p = await window.nexio.agentPickFolder();
          if (p) source = { sourceType: 'folder', path: p };
        } else if (which === 'file') {
          const p = await window.nexio.ext({ action: 'pickFile' });
          if (p) source = { sourceType: 'file', path: p };
        } else if (which === 'url') {
          const url = window.prompt ? window.prompt('Git URL (https only):', 'https://') : '';
          if (url) source = { sourceType: 'git', url };
        }
      } catch (err) { addMsg('assistant', errText(err)); return; }
      if (!source) return;
      try {
        const diff = await extCall({ action: 'updatePreview', id: sub.id, source });
        extSub = { view: 'update', id: sub.id, source, preview: diff.preview, added: diff.added, grew: diff.grew, step: 2 };
        renderExtensions(); syncChrome(); requestResize();
      } catch (err) { addMsg('assistant', errText(err)); }
    };
  });
  if (sub.step === 2 && sub.preview) {
    form.innerHTML = `<div class="fld"><span class="flab">New version can:</span><ul class="can-list">` +
      sub.preview.capabilities.map((c) => `<li>${esc(c)}</li>`).join('') + `</ul></div>` +
      (sub.grew ? `<div class="ext-warn">Permissions grew — new: ${(sub.added || []).join('; ')}. Updating disables it until you re-enable.</div>`
        : `<div class="ext-empty">No new permissions.</div>`) +
      `<div class="row"><button id="ext-update-cancel">Cancel</button><button id="ext-update-go" class="primary">Update</button></div>`;
    $('ext-update-cancel').onclick = () => { extSub = null; renderExtensions(); syncChrome(); requestResize(); };
    $('ext-update-go').onclick = async () => {
      try {
        const r = await extCall({ action: 'update', id: sub.id, source: sub.source });
        addMsg('assistant', r && r.grew ? 'Updated. Permissions grew — re-enable in Extensions to approve.' : 'Updated.');
        extSub = null;
        await refreshExtensions();
      } catch (err) { addMsg('assistant', errText(err)); }
    };
  }
}

function renderExtTrust(body, sub) {
  const t = sub.trust || { title: 'Trust?', lines: [] };
  body.innerHTML = `<h4 class="ext-title">${esc(t.title)}</h4>` +
    `<ul class="can-list">` + (t.lines || []).map((l) => `<li>${esc(l)}</li>`).join('') + `</ul>` +
    `<div class="ext-empty">Secrets are never shown here. Nothing runs until you approve.</div>` +
    `<div class="row"><button id="trust-cancel">Cancel</button>` +
    `<button id="trust-go" class="primary">Trust and continue</button></div>`;
  $('trust-cancel').onclick = async () => { extSub = null; await refreshExtensions(); };
  $('trust-go').onclick = async () => {
    try { await sub.onTrust(); } catch (err) { addMsg('assistant', errText(err)); }
    extSub = null;
    await refreshExtensions();
  };
}

async function runSkillCommand(trigger) {
  const name = trigger.replace(/^\//, '');
  addMsg('user', trigger);
  try {
    const body = await extCall({ action: 'skillBody', name });
    addMsg('assistant', body);
    if (mode === 'agent') {
      pendingSkill = { name, body };
      addMsg('assistant', `_Skill \`${esc(name)}\` armed — describe the task and it will guide the run._`);
    }
  } catch (err) {
    addMsg('assistant', errText(err));
  }
}

async function runMcpPrompt(trigger) {
  addMsg('user', trigger);
  try {
    const m = /^\/mcp-([A-Za-z0-9_-]+)-(.+)$/.exec(trigger);
    const text = await extCall({ action: 'mcpPrompt', server: m ? m[1] : '', prompt: m ? m[2] : '', trigger });
    inputEl.value = String(text).slice(0, 4000);
    drafts[mode] = inputEl.value;
    grow();
    inputEl.focus();
    addMsg('assistant', '_Prompt inserted in the composer — review and send._');
  } catch (err) {
    addMsg('assistant', errText(err));
  }
}

function openWorkflowForm(trigger, info) {
  addMsg('user', trigger);
  const div = addMsg('assistant', `**${esc(trigger)}** — fill inputs, then Run.`);
  const form = document.createElement('div');
  form.className = 'extform';
  (info.inputs || []).forEach((inp) => {
    const lab = document.createElement('label');
    lab.className = 'fld';
    const span = document.createElement('span');
    span.className = 'flab';
    span.textContent = (inp.label || inp.name) + (inp.required ? ' *' : '');
    if (inp.type === 'boolean') {
      lab.classList.add('check');
      const tx = document.createElement('span');
      tx.className = 'switch-tx';
      tx.appendChild(span);
      lab.appendChild(tx);
      const field = document.createElement('input');
      field.type = 'checkbox';
      field.dataset.name = inp.name;
      field.setAttribute('role', 'switch');
      lab.appendChild(field);
      const track = document.createElement('span');
      track.className = 'switch-track';
      track.setAttribute('aria-hidden', 'true');
      const knob = document.createElement('span');
      knob.className = 'switch-knob';
      track.appendChild(knob);
      lab.appendChild(track);
      form.appendChild(lab);
      return;
    }
    lab.appendChild(span);
    let field;
    if (inp.type === 'text') { field = document.createElement('textarea'); field.rows = 3; }
    else { field = document.createElement('input'); field.type = inp.type === 'number' ? 'number' : 'text'; }
    field.dataset.name = inp.name;
    if (inp.default) field.value = inp.default;
    lab.appendChild(field);
    form.appendChild(lab);
  });
  const row = document.createElement('div');
  row.className = 'row';
  const run = document.createElement('button');
  run.textContent = 'Run';
  run.className = 'primary';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { form.remove(); };
  run.onclick = async () => {
    const inputs = {};
    form.querySelectorAll('[data-name]').forEach((f) => {
      inputs[f.dataset.name] = f.type === 'checkbox' ? (f.checked ? 'yes' : '') : f.value;
    });
    form.remove();
    await startWorkflowRun(trigger, inputs);
  };
  row.appendChild(run);
  row.appendChild(cancel);
  form.appendChild(row);
  div.appendChild(form);
  requestResize();
}

if ($('btn-ext')) $('btn-ext').onclick = () => void openExtensions();
if ($('btn-open-ext')) $('btn-open-ext').onclick = () => void openExtensions();
/* --- Launcher (appended): result chips, undo, suggestions, run log, onboarding --- */
function collapseSteps() {
  const steps = $('agent-steps');
  if (steps && steps.children.length) steps.classList.add('collapsed');
}

function renderRunChips(runId) {
  let host = $('run-chips');
  if (host) host.remove();
  const steps = $('agent-steps');
  const sum = runSummaries[runId];
  host = document.createElement('div');
  host.id = 'run-chips';
  host.className = 'chips';
  const mk = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.onclick = fn;
    return b;
  };
  if (sum && sum.folder) host.appendChild(mk('Open folder', 'Open result folder', () => {
    void window.nexio.reveal(sum.folder).catch(() => {});
  }));
  if (sum && sum.undoable) host.appendChild(mk('Undo', 'Undo this run', () => void startUndoRun(runId)));
  host.appendChild(mk('Show steps', 'Show execution steps', () => {
    if (steps) steps.classList.toggle('collapsed');
    requestResize();
  }));
  if (steps && steps.parentNode) steps.parentNode.insertBefore(host, steps.nextSibling);
  requestResize();
}

async function startUndoRun(runId) {
  if (agentRunning()) return;
  agentState = { runId: null, rows: new Map(), answerDiv: null };
  const oldChips = $('run-chips');
  if (oldChips) oldChips.remove();
  const steps = $('agent-steps');
  if (steps) { steps.innerHTML = ''; steps.classList.remove('hidden'); steps.classList.remove('collapsed'); }
  showView('messages');
  syncAgentFooter();
  syncChrome();
  requestResize();
  try {
    const r = await window.nexio.undo(runId);
    if (!agentState) return;
    agentState.runId = r && r.runId;
  } catch (e) {
    addAgentRow('error', iconFor('fail') + `<div class="tx">${esc(errText(e))}</div>`);
    endAgentRun();
  }
}

// --- Starter suggestions: idle + empty input, fill without executing ---
var suggestTimer = null;
var suggestCache = null;
function hideSuggest() {
  clearTimeout(suggestTimer);
  const box = $('suggest');
  if (box) box.classList.add('hidden');
}
async function suggestList() {
  if (suggestCache) return suggestCache;
  try {
    const s = await window.nexio.getSettings();
    if (Array.isArray(s.suggestions) && s.suggestions.length) {
      suggestCache = s.suggestions.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
      if (suggestCache.length) return suggestCache;
    }
  } catch { /* fall through to defaults */ }
  suggestCache = [
    'Find files I changed today',
    'Open my last downloaded file',
    'Organize Downloads by type',
    "What's using my disk space?",
  ];
  return suggestCache;
}
function maybeSuggest() {
  hideSuggest();
  if (inputEl.value || agentRunning()) return;
  if (currentView === 'settings' || currentView === 'onboard' || currentView === 'extensions') return;
  if (!paletteEl.classList.contains('hidden')) return;
  suggestTimer = setTimeout(() => void renderSuggest(), 1000);
}
async function renderSuggest() {
  const box = $('suggest');
  if (!box || inputEl.value || agentRunning()) return;
  const items = await suggestList();
  if (!items.length || inputEl.value) return;
  box.innerHTML = '';
  for (const text of items.slice(0, 4)) {
    const d = document.createElement('div');
    d.className = 'item';
    d.setAttribute('role', 'option');
    d.innerHTML = `<span>${esc(text)}</span>`;
    d.onclick = () => {
      inputEl.value = text;
      drafts[mode] = text;
      hideSuggest();
      grow();
      inputEl.focus();
    };
    box.appendChild(d);
  }
  box.classList.remove('hidden');
  const view = $('view');
  if (view) view.classList.remove('hidden');
  requestResize();
}
inputEl.addEventListener('input', () => { if (!inputEl.value) maybeSuggest(); else hideSuggest(); });
inputEl.addEventListener('focus', () => { if (!inputEl.value) maybeSuggest(); });

// --- History tabs: Run Log + Ask ---
var histTab = 'runs';
function paintHistTabs() {
  document.querySelectorAll('.hist-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.ht === histTab));
  $('hist-runs').classList.toggle('hidden', histTab !== 'runs');
  $('hist-ask').classList.toggle('hidden', histTab !== 'ask');
}
document.querySelectorAll('.hist-tabs button').forEach((b) => {
  b.onclick = () => { histTab = b.dataset.ht; paintHistTabs(); requestResize(); };
});
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}
async function refreshRunLog() {
  const ul = $('runlog-list');
  if (!ul) return;
  ul.innerHTML = '';
  let runs = [];
  try {
    runs = await window.nexio.runs();
  } catch { /* empty state below */ }
  if (!runs.length) {
    const li = document.createElement('li');
    li.className = 'run-empty';
    li.textContent = 'No runs yet.';
    ul.appendChild(li);
    return;
  }
  for (const r of runs) {
    const li = document.createElement('li');
    li.className = 'runrow';
    const dot = r.status === 'done' ? 'ok' : r.status === 'stopped' ? 'warn' : 'err';
    li.innerHTML = `<span class="dot ${dot}" aria-hidden="true"></span>` +
      `<div class="run-tx"><div class="run-prompt">${esc(r.prompt || '')}</div>` +
      `<div class="run-meta">${esc(r.outcome || '')} · ${esc(fmtTime(r.ts))} · ${esc(r.status)}</div></div>`;
    if (r.undoable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'run-undo';
      b.textContent = 'Undo';
      b.setAttribute('aria-label', `Undo run ${esc(r.prompt || r.runId)}`);
      b.onclick = async () => {
        showView(defaultView());
        await startUndoRun(r.runId);
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}
const _togglePanelHist = togglePanel;
togglePanel = function (which) {
  _togglePanelHist(which);
  if (which === 'history') { paintHistTabs(); void refreshRunLog(); }
  syncChrome(); requestResize();
};

// --- First-run onboarding: provider → folders → try. Skippable. ---
var obStep = 0;
async function maybeOnboard() {
  try {
    const s = await window.nexio.getSettings();
    if (s.onboarded) return;
    const convs = await window.nexio.listConversations();
    if (convs.length) { await window.nexio.setSettings({ onboarded: true }); return; } // existing install
    obStep = 0;
    showView('onboard');
    renderOnboard();
  } catch { /* preview */ }
}
async function skipOnboard() {
  try { await window.nexio.setSettings({ onboarded: true }); } catch { /* preview */ }
  showView(defaultView());
  inputEl.focus();
  syncChrome(); requestResize();
}
function obShell(title, inner) {
  return `<div class="set-head"><h3>${esc(title)}</h3></div>` +
    `<div class="ob-steps">Step ${obStep + 1} of 3</div>${inner}` +
    `<div class="row"><button id="ob-skip" class="linklike">Skip</button></div>`;
}
function renderOnboard() {
  const box = $('onboard');
  if (!box) return;
  if (obStep === 0) {
    box.innerHTML = obShell('Choose your AI provider',
      `<div class="fld"><span class="flab">Provider</span><div class="seg" id="ob-prov" role="group" aria-label="Provider">` +
      ['openai', 'anthropic', 'gemini', 'compatible'].map((p) => `<button data-prov="${p}">${p === 'compatible' ? 'Custom' : p[0].toUpperCase() + p.slice(1)}</button>`).join('') +
      `</div></div>` +
      `<label class="fld"><span class="flab">API key</span><input id="ob-key" type="password" placeholder="sk-…" class="mono" /></label>` +
      `<div class="row"><button id="ob-test">Test</button><span id="ob-status" role="status"></span></div>` +
      `<div class="row"><button id="ob-next" class="primary">Continue</button></div>`);
    let prov = 'openai';
    const paint = () => box.querySelectorAll('#ob-prov button').forEach((b) => b.classList.toggle('on', b.dataset.prov === prov));
    box.querySelectorAll('#ob-prov button').forEach((b) => { b.onclick = () => { prov = b.dataset.prov; paint(); }; });
    paint();
    $('ob-test').onclick = async () => {
      $('ob-status').textContent = 'Testing…';
      try {
        const r = await window.nexio.testConnectivity(prov, $('ob-key').value, undefined);
        $('ob-status').textContent = r.ok ? 'OK' : ('Fail: ' + (r.error?.code || '') + ' ' + (r.error?.message || ''));
      } catch (e) { $('ob-status').textContent = errText(e); }
    };
    $('ob-next').onclick = async () => {
      try {
        await window.nexio.setSettings({ provider: prov });
        if ($('ob-key').value) await window.nexio.setApiKey(prov, $('ob-key').value);
      } catch (e) { $('ob-status').textContent = errText(e); return; }
      obStep = 1;
      renderOnboard();
    };
  } else if (obStep === 1) {
    box.innerHTML = obShell('Choose allowed folders',
      `<div class="ext-empty">Nexio can only touch the folders you allow. Suggested: Desktop, Documents, Downloads.` +
      (platformInfo && platformInfo.os === 'darwin'
        ? ` macOS will ask for access to each folder the first time; if you pick "Don't Allow", fix it later in System Settings under Files and Folders.</div>` : `</div>`) +
      `<ul id="ob-roots" class="agent-list"></ul>` +
      `<div class="row"><button id="ob-add">Add folder</button><button id="ob-quick">Add Desktop + Documents + Downloads</button></div>` +
      `<div class="row"><button id="ob-next" class="primary">Continue</button></div>`);
    const paint = async () => {
      const s = await window.nexio.getSettings();
      const ul = $('ob-roots');
      ul.innerHTML = '';
      for (const r of s.agentAllowedRoots || []) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = r;
        li.appendChild(span);
        ul.appendChild(li);
      }
    };
    void paint();
    $('ob-add').onclick = async () => {
      try {
        const p = await window.nexio.agentPickFolder();
        if (!p) return;
        const s = await window.nexio.getSettings();
        const next = [...(s.agentAllowedRoots || [])];
        if (!next.includes(p)) next.push(p);
        await window.nexio.setSettings({ agentAllowedRoots: next });
        await paint();
      } catch { /* cancelled */ }
    };
    $('ob-quick').onclick = async () => {
      try {
        const dirs = await window.nexio.defaultFolders();
        const s = await window.nexio.getSettings();
        const next = [...(s.agentAllowedRoots || [])];
        for (const folder of dirs) if (!next.includes(folder)) next.push(folder);
        await window.nexio.setSettings({ agentAllowedRoots: next });
        await paint();
      } catch { /* cancelled */ }
    };
    $('ob-next').onclick = () => { obStep = 2; renderOnboard(); };
  } else {
    box.innerHTML = obShell('Try Nexio',
      `<div class="ext-empty">Say what you want. Nexio does it on your computer. Hotkey: ${hotkeyCapsHtml()} Try one:</div>` +
      `<div class="ext-addmenu">` +
      ['Find files I changed today', 'Organize my Downloads by file type', 'Open my last downloaded file'].map((t) => `<button data-try="${esc(t)}">${esc(t)}</button>`).join('') +
      `</div><div class="row"><button id="ob-done" class="primary">Done</button></div>`);
    box.querySelectorAll('[data-try]').forEach((b) => {
      b.onclick = async () => {
        inputEl.value = b.dataset.try;
        drafts[mode] = inputEl.value;
        await skipOnboard();
        grow();
        inputEl.focus();
      };
    });
    $('ob-done').onclick = () => void skipOnboard();
  }
  $('ob-skip').onclick = () => void skipOnboard();
  syncChrome(); requestResize();
}
void maybeOnboard();
/* --- Platform (appended): per-OS key caps, secret-store copy, hotkey status --- */
var platformInfo = null;
var currentToggleHotkey = 'Alt+Space';
var currentStopHotkey = 'Ctrl+Alt+Esc';
function keysHtml(keys) {
  return (keys || []).map((k) => `<span class="k">${esc(k)}</span>`).join('');
}
function capsHtml(accel) {
  // Fallback mapping before platform info loads; main keyTokens() is the source of truth.
  const caps = (platformInfo && platformInfo.caps) || { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', cmd: 'Cmd', esc: 'Esc', space: 'Space' };
  const isMac = !!platformInfo && platformInfo.os === 'darwin';
  const map = { alt: caps.alt, option: caps.alt, control: caps.ctrl, ctrl: caps.ctrl, shift: caps.shift, cmd: caps.cmd, commandorcontrol: caps.cmd, command: caps.cmd, escape: caps.esc, esc: caps.esc, space: caps.space };
  const tokens = String(accel).split('+').map((p) => p.trim()).filter(Boolean).map((p) => map[p.toLowerCase()] || p);
  return tokens.map((k) => `<span class="k">${esc(k)}</span>`).join(isMac ? '' : ' ');
}
function paintKeyHints() {
  const hh = $('hotkey-hint');
  if (hh) {
    hh.innerHTML = (platformInfo && platformInfo.toggleKeys)
      ? keysHtml(platformInfo.toggleKeys) : capsHtml(currentToggleHotkey);
  }
  const sh = $('stop-hint');
  if (sh) {
    sh.innerHTML = (platformInfo && platformInfo.stopKeys)
      ? keysHtml(platformInfo.stopKeys) : capsHtml(currentStopHotkey);
  }
}
/** Toggle-hotkey caps for inline copy (onboarding); prefers main keyTokens(). */
function hotkeyCapsHtml() {
  if (platformInfo && platformInfo.toggleKeys) return keysHtml(platformInfo.toggleKeys);
  return capsHtml(currentToggleHotkey);
}
async function loadPlatform() {
  try {
    if (!window.nexio?.getPlatform) return;
    platformInfo = await window.nexio.getPlatform();
    document.body.classList.toggle('mac', platformInfo.os === 'darwin');
    document.body.classList.toggle('win', platformInfo.os !== 'darwin');
    const note = $('enc-note');
    if (note && platformInfo.secretStore) note.textContent = `Encrypted on this device (${platformInfo.secretStore}).`;
    const priv = $('fld-privacy');
    if (priv) priv.classList.toggle('hidden', platformInfo.os !== 'darwin');
    try {
      const hs = await window.nexio.getHotkeyStatus();
      if (hs && hs.hotkey) currentToggleHotkey = hs.hotkey;
    } catch { /* optional */ }
    paintKeyHints();
  } catch { /* preview without bridge */ }
}
async function refreshHotkeyStatus() {
  const warn = $('hotkey-warn');
  if (!warn) return;
  try {
    const hs = await window.nexio.getHotkeyStatus();
    if (hs && hs.hotkey) currentToggleHotkey = hs.hotkey;
    if (hs && !hs.registered) {
      warn.classList.remove('hidden');
      warn.innerHTML = `Hotkey ${esc(hs.hotkey || currentToggleHotkey)} could not be registered (another app may use it). ` +
        `<button id="btn-change-hotkey" class="linklike" type="button">Change hotkey</button>`;
      const btn = $('btn-change-hotkey');
      if (btn) btn.onclick = () => { const f = $('set-hotkey'); if (f) f.focus(); };
    } else {
      warn.classList.add('hidden');
      warn.innerHTML = '';
    }
  } catch { /* optional */ }
  paintKeyHints();
}
if (window.nexio && typeof window.nexio.onUi === 'function') {
  window.nexio.onUi((ev) => {
    try {
      if (ev.open === 'settings') { if (currentView !== 'settings') $('btn-settings').click(); }
      else if (ev.open === 'log') { void showAgentLog(); }
    } catch { /* preview */ }
  });
}
