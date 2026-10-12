'use strict';
/* MiniAI renderer — vanilla JS. Talks to preload `window.miniAI`. */
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), inputEl = $('input'), paletteEl = $('palette');
let convId = null, paletteItems = [], paletteActive = 0, assistantDiv = null;
let mode = 'chat', runtime = 'opencode', reqSeq = 0;
let drafts = { chat: '', agent: '' };

function setMode(m, persist) {
  drafts[mode] = inputEl.value;
  mode = m;
  inputEl.value = drafts[mode] || '';
  updateModeUI();
  if (persist !== false && window.miniAI?.setSettings) void window.miniAI.setSettings({ mode: m }).catch(() => {});
}
function updateModeUI() {
  const isChat = mode === 'chat';
  $('tab-chat').classList.toggle('active', isChat);
  $('tab-chat').setAttribute('aria-selected', String(isChat));
  $('tab-agent').classList.toggle('active', !isChat);
  $('tab-agent').setAttribute('aria-selected', String(!isChat));
  $('runtime').classList.toggle('hidden', isChat);
  inputEl.placeholder = isChat ? 'Ask anything…  ( / for commands )' : `Agent (${runtime}) — describe the task…  (Tab to switch)`;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
        const out = await window.miniAI.runWorkflow(trigger, { text: rest.join(' ') });
        assistantDiv.innerHTML = mdLite(out.outputs.__output || JSON.stringify(out));
        return;
      }
      if (trigger === '/new') return void newChat();
      if (trigger === '/clear') { messagesEl.innerHTML = ''; return; }
      if (trigger === '/help') {
        addMsg('assistant', '**Commands:** /help /new /clear /model /history + prompt templates + workflows.\nType `/` to browse.');
        return;
      }
      if (trigger === '/history') return void togglePanel('history');
      if (trigger === '/model') {
        if (rest[0]) { await window.miniAI.setSettings({ model: rest[0] }); addMsg('assistant', `Model → ${esc(rest[0])}`); }
        else { const s = await window.miniAI.getSettings(); addMsg('assistant', `Current model: ${esc(s.model)}`); }
        return;
      }
      addMsg('user', text);
      // prompt template: send rendered via chat
      const id = await ensureConv();
      assistantDiv = addMsg('assistant', '…');
      await window.miniAI.send(id, text, { mode, runtimeId: runtime, sessionId: id, requestId: `r${Date.now()}-${++reqSeq}` });
      return;
    }
    addMsg('assistant', `Unknown command ${esc(trigger)}. Did you mean: ${(r.suggestions || []).map((s) => esc(s.trigger)).join(', ') || '—'}?`);
    return;
  }
  addMsg('user', text);
  const id = await ensureConv();
  assistantDiv = addMsg('assistant', '…');
  try {
    const requestId = `r${Date.now()}-${++reqSeq}`;
    await window.miniAI.send(id, text, { mode, runtimeId: runtime, sessionId: id, requestId });
  } catch (e) {
    assistantDiv.innerHTML = mdLite('Error: ' + (e.message || e));
  }
}

window.miniAI.onStream((ev) => {
  if (ev.done) return;
  if (!assistantDiv) assistantDiv = addMsg('assistant', '');
  assistantDiv.dataset.raw = (assistantDiv.dataset.raw || '') + ev.token;
  assistantDiv.innerHTML = mdLite(assistantDiv.dataset.raw);
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// slash palette
let paletteTimer = null;
inputEl.addEventListener('input', () => {
  drafts[mode] = inputEl.value;
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(async () => {
    const v = inputEl.value;
    if (!/\/[A-Za-z0-9_-]*$/.test(v)) return hidePalette();
    paletteItems = await window.miniAI.slashQuery(v, mode);
    if (!paletteItems.length) return hidePalette();
    paletteActive = 0;
    renderPalette();
  }, 80);
});
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
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive = (paletteActive + 1) % paletteItems.length; renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = (paletteActive - 1 + paletteItems.length) % paletteItems.length; renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); pickPalette(paletteActive); }
    else if (e.key === 'Escape') { hidePalette(); }
  } else if (e.key === 'Enter') void send();
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
  hidePalette();
  inputEl.focus();
}
function hidePalette() { paletteEl.classList.add('hidden'); paletteItems = []; }
document.addEventListener('click', (e) => { if (!paletteEl.contains(e.target) && e.target !== inputEl) hidePalette(); });

$('btn-send').onclick = () => void send();
$('tab-chat').onclick = () => setMode('chat');
$('tab-agent').onclick = () => setMode('agent');
$('runtime').onchange = () => {
  runtime = $('runtime').value;
  updateModeUI();
  if (window.miniAI?.setSettings) void window.miniAI.setSettings({ agentRuntime: runtime }).catch(() => {});
};
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); setMode(mode === 'chat' ? 'agent' : 'chat'); }
  else if (e.altKey && e.key === '1') { e.preventDefault(); setMode('chat'); }
  else if (e.altKey && e.key === '2') { e.preventDefault(); setMode('agent'); }
});
function togglePanel(which) {
  $('settings').classList.toggle('hidden', which !== 'settings' || !$('settings').classList.contains('hidden') && which === 'settings' ? true : which !== 'settings');
  $('history').classList.toggle('hidden', which !== 'history' || !$('history').classList.contains('hidden') && which === 'history' ? true : which !== 'history');
  // simpler: toggle target, hide other
  if (which === 'settings') { $('settings').classList.toggle('hidden'); $('history').classList.add('hidden'); }
  else { $('history').classList.toggle('hidden'); $('settings').classList.add('hidden'); if (which === 'history') void refreshHistory(); }
}
$('btn-settings').onclick = async () => {
  togglePanel('settings');
  const s = await window.miniAI.getSettings();
  $('set-provider').value = s.provider; $('set-model').value = s.model;
  $('set-baseurl').value = s.baseUrl || ''; $('set-theme').value = s.theme;
  $('set-runtime').value = s.agentRuntime || 'opencode';
  $('set-opencode').value = s.opencodeBaseUrl || ''; $('set-claudebin').value = s.claudeBin || '';
  $('set-codexbin').value = s.codexBin || ''; $('set-agentcwd').value = s.agentCwd || '';
  document.documentElement.dataset.theme = s.theme;
};
$('btn-history').onclick = () => togglePanel('history');
$('btn-hide').onclick = () => window.close();
$('btn-save-settings').onclick = async () => {
  const patch = {
    provider: $('set-provider').value,
    model: $('set-model').value,
    theme: $('set-theme').value,
    agentRuntime: $('set-runtime').value,
    opencodeBaseUrl: $('set-opencode').value.trim(),
    claudeBin: $('set-claudebin').value.trim(),
    codexBin: $('set-codexbin').value.trim(),
    agentCwd: $('set-agentcwd').value.trim(),
  };
  if ($('set-baseurl').value.trim()) patch.baseUrl = $('set-baseurl').value.trim();
  await window.miniAI.setSettings(patch);
  runtime = patch.agentRuntime || runtime;
  updateModeUI();
  if ($('set-apikey').value) await window.miniAI.setApiKey(patch.provider, $('set-apikey').value);
  $('set-apikey').value = '';
  document.documentElement.dataset.theme = patch.theme;
  $('settings-status').textContent = 'Saved';
  setTimeout(() => ($('settings-status').textContent = ''), 1500);
};
$('btn-test-conn').onclick = async () => {
  $('settings-status').textContent = 'Testing…';
  const r = await window.miniAI.testConnectivity($('set-provider').value, $('set-model').value, $('set-baseurl').value || undefined);
  $('settings-status').textContent = r.ok ? 'OK' : ('Fail: ' + (r.error?.code || '') + ' ' + (r.error?.message || ''));
};
$('btn-new').onclick = () => void newChat();
async function newChat() {
  const c = await window.miniAI.createConversation('New chat');
  convId = c.id; messagesEl.innerHTML = ''; assistantDiv = null;
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
      togglePanel('history');
    };
    ul.appendChild(li);
  }
}
(async () => {
  try {
    const s = await window.miniAI.getSettings();
    document.documentElement.dataset.theme = s.theme || 'light';
    mode = s.mode === 'agent' ? 'agent' : 'chat';
    runtime = s.agentRuntime || 'opencode';
    if ($('runtime')) $('runtime').value = runtime;
    try {
      const caps = await window.miniAI.runtimeList?.();
      if (Array.isArray(caps) && $('runtime')) {
        for (const c of caps) {
          const opt = [...$('runtime').options].find((o) => o.value === c.id);
          if (opt) opt.textContent = `${c.id}${c.available ? '' : ' (unavailable)'}`;
        }
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
})();
