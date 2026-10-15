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
let view = 'idle'; // single view: 'idle'|'palette'|'run'|'settings'|'extensions'|'history'|'onboard'
let returnTo = 'idle'; // idle|run origin for Esc/Back (mirrors shared/view.ts openView/goBack)
let currentView = null; // legacy alias: 'palette'|'messages'|'settings'|'history'|'extensions'|'onboard'|null
function hasRun() { return messagesEl.children.length > 0 || ($('agent-steps') && $('agent-steps').children.length > 0); }
function backTarget() { return returnTo === 'run' && !hasRun() ? 'idle' : returnTo; }
function attachPending() { try { return typeof attachPendingCount === 'function' ? attachPendingCount() : 0; } catch { return 0; } }
// why: starter suggestions only on a fresh idle composer — mirrors shared/view.ts isEmpty
function isEmptyUI() {
  const steps = $('agent-steps');
  const toolCount = steps ? steps.querySelectorAll('.tool-name').length : 0;
  const active = (typeof agentRunning === 'function' && agentRunning());
  return !inputEl.value && messagesEl.children.length === 0 && toolCount === 0 && attachPending() === 0 && !active;
}
let drafts = { chat: '', agent: '' };
var lastUserText = '';

// --- i18n: locale dict over IPC, mirrored t() (see src/shared/i18n.ts) ---
var L = { tag: 'en', dir: 'ltr', dict: {}, fallback: {}, available: [] };
function tv(v, vars) {
  if (typeof v === 'string') {
    return String(v).replace(/\{(\w+)\}/g, function (_, k) {
      return vars && vars[k] !== undefined ? String(vars[k]) : '{' + k + '}';
    });
  }
  return v;
}
function t(key, vars) {
  try {
    var raw = (L.dict && L.dict[key] !== undefined) ? L.dict[key]
      : (L.fallback && L.fallback[key] !== undefined) ? L.fallback[key] : key;
    if (typeof raw === 'string') return tv(raw, vars);
    var n = vars && typeof vars.count === 'number' ? vars.count : 1;
    var form = 'other';
    try { form = new Intl.PluralRules(L.tag).select(n); } catch (e) { form = n === 1 ? 'one' : 'other'; }
    return tv(raw[form] !== undefined ? raw[form] : raw.other !== undefined ? raw.other : key, vars);
  } catch (e) { return key; }
}
function tr(key, vars, fb) { var s = t(key, vars); return s === key ? fb : s; }
async function loadLocale() {
  try {
    if (!window.nexio || !window.nexio.getLocale) return;
    var r = await window.nexio.getLocale();
    if (r && r.tag) {
      L = { tag: r.tag, dir: r.dir || 'ltr', dict: r.dict || {}, fallback: r.fallback || {}, available: r.available || [] };
    }
  } catch (e) { /* English fallback */ }
}
/** Apply locale to shell chrome: <html> lang/dir + every data-i18n node. */
function applyLocale() {
  try {
    document.documentElement.lang = L.tag || 'en';
    document.documentElement.dir = L.dir || 'ltr';
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    updateModeUI();
    if (typeof paintIncognito === 'function') { try { incognitoOn = incognitoOn; paintIncognito(true); } catch (e) {} }
    // why: the footer tasks label is JS-painted, so a pre-locale paint leaves the raw key behind.
    if (typeof paintTasksButton === 'function') { try { paintTasksButton(); } catch (e) {} }
    if (typeof view !== 'undefined' && view === 'tasks' && typeof renderTasksView === 'function') {
      try { renderTasksView(); } catch (e) {}
    }
    try { fitAnswerMeta(); fitFooterHints(); } catch (e) {} // translated labels change widths
    syncChrome();
    requestResize();
  } catch (e) { /* locale never breaks chrome */ }
}

// Fail visibly, not half-wired, if the preload bridge did not load.
if (!window.nexio) {
  messagesEl.innerHTML = '<div class="msg">Error: app bridge failed to load. Restart Nexio.</div>';
  throw new Error('nexio bridge missing');
}

function setMode(m, persist) {
  const changed = m !== mode;
  // why: a stale Do chip must never survive the switch it offers.
  try { document.querySelectorAll('.switch-do-row').forEach((r) => r.remove()); } catch {}
  drafts[mode] = inputEl.value;
  mode = m;
  inputEl.value = drafts[mode] || '';
  updateModeUI();
  // why: earlier answers were produced under the other mode; mark the seam.
  // Quiet separator row (not a message): lines + muted label, never a heading.
  if (changed && hasRun()) {
    try {
      const div = document.createElement('div');
      div.className = 'msg mode-div';
      div.setAttribute('role', 'separator');
      const label = m === 'agent' ? t('mode.switchedDo') : t('mode.switchedAsk');
      div.setAttribute('aria-label', label);
      const line = () => {
        const s = document.createElement('span');
        s.className = 'mode-line';
        s.setAttribute('aria-hidden', 'true');
        return s;
      };
      const tx = document.createElement('span');
      tx.className = 'mode-text';
      tx.textContent = label;
      div.append(line(), tx, line());
      messagesEl.appendChild(div);
      agentScroll();
      requestResize();
    } catch { /* divider never breaks mode switch */ }
  }
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
  inputEl.placeholder = isChat ? t('composer.placeholder.ask') : t('composer.placeholder.do');
  inputEl.dir = 'auto';
  const ro = $('hint-readonly');
  if (ro) ro.classList.toggle('hidden', !isChat);
  const sep = $('hint-sep');
  if (sep) sep.classList.toggle('hidden', !isChat);
  const queue = $('hint-queue');
  if (queue && isChat) queue.classList.add('hidden'); // Ask never queues
  try { layoutAnswerActions(); } catch { /* actions best-effort */ }
  try { fitFooterHints(); } catch { /* fit best-effort */ }
}

// why: autosize composer up to 224px, then internal scroll
function grow() {
  const bar = document.querySelector('.bar');
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 224) + 'px';
  if (bar) bar.classList.toggle('multiline', inputEl.scrollHeight > 32 || inputEl.value.includes('\n'));
  requestResize();
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

// markdown-lite: code blocks, headings, lists, tables, inline code, bold, italic, links, line breaks
function mdLite(src) {
  const blocks = [];
  let html = esc(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  html = mdBlocks(html);
  html = html
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, text, href) => (/^https?:\/\/[^"'\s<>]+$/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text))
    .replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

// why: headings/lists/tables need line structure; the inline pass runs after so inner markup still formats
function mdBlocks(src) {
  const lines = src.split('\n');
  const out = [];
  const listRe = /^(?:[-*]|\d+[.)])\s+(.*)$/;
  const rowCells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,4})\s+(.*\S)\s*$/.exec(line);
    if (h) { out.push(`<div class="md-h">${h[2]}</div>`); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') &&
        /^\s*\|?[\s:|-]+\|?[\s|:-]*$/.test(lines[i + 1])) {
      const head = rowCells(line);
      if (head.length > 1) {
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes('|') && rowCells(lines[j]).length === head.length) {
          rows.push(rowCells(lines[j]));
          j++;
        }
        out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>');
        i = j;
        continue;
      }
    }
    const m = listRe.exec(line);
    if (m) {
      const ordered = /^\d/.test(line);
      const items = [];
      while (i < lines.length) {
        const mm = listRe.exec(lines[i]);
        if (!mm || /^\d/.test(lines[i]) !== ordered) break;
        items.push(mm[1]);
        i++;
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.map((t) => `<li>${t}</li>`).join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.dir = 'auto';
  if (role === 'user') {
    // why: You label + 3-line clamp keeps tall pastes to one compact row; click or Enter/Space toggles full text
    div.innerHTML = '<span class="you-label">You</span><span class="you-prompt you-clamp" tabindex="0" role="button" aria-expanded="false"></span>';
    const yp = div.querySelector('.you-prompt');
    yp.textContent = content;
    const toggleYou = (el) => {
      el.classList.toggle('you-clamp');
      el.setAttribute('aria-expanded', String(!el.classList.contains('you-clamp')));
    };
    yp.onclick = (e) => toggleYou(e.currentTarget);
    yp.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleYou(e.currentTarget); }
    };
  } else {
    div.innerHTML = mdLite(content);
    decorateCode(div);
  }
  (currentTurn || messagesEl).appendChild(div);
  if (role === 'assistant') markLastAnswer();
  // why: user turns always come into view; streaming answers respect a scrolled-up reader
  if (role === 'user') userScrolledUp = false;
  scrollToLatest(role === 'user');
  // why: no view yank here — senders switch explicitly; the approval yank lives in handleAgentEvent
  return div;
}

// --- conversation turns: one .turn block per { You row, answer } ---
var currentTurn = null; // live block the current submit appends to (null = messagesEl level)
var userScrolledUp = false; // reader moved up: streaming holds position, jump button shows
var MAX_TURNS = 100; // DOM window; the DB keeps every turn
function startTurnQuiet() {
  currentTurn = document.createElement('div');
  currentTurn.className = 'turn';
  messagesEl.appendChild(currentTurn);
  return currentTurn;
}
function startTurn() {
  startTurnQuiet();
  pruneTurns();
  userScrolledUp = false;
  syncJump();
  agentScroll();
  requestResize();
  return currentTurn;
}
function pruneTurns() {
  try {
    let turns = messagesEl.querySelectorAll(':scope > .turn');
    while (turns.length > MAX_TURNS) {
      turns[0].remove();
      turns = messagesEl.querySelectorAll(':scope > .turn');
    }
  } catch { /* windowing never breaks rendering */ }
}
function markLastAnswer() {
  try {
    const answers = messagesEl.querySelectorAll('.msg.assistant');
    answers.forEach((a) => a.classList.remove('last'));
    if (answers.length) answers[answers.length - 1].classList.add('last');
    placeAnswerMeta(null);
  } catch { /* last-marking never breaks rendering */ }
}
/** Latest answer gets the shared meta row; hovering/focusing an earlier one
 * borrows it (moved back afterwards) — one row, no duplicated IDs. */
function placeAnswerMeta(anchor) {
  const meta = $('answer-meta');
  if (!meta) return;
  try {
    if (anchor && anchor.parentNode && !anchor.classList.contains('last')) {
      if (meta.previousSibling !== anchor) anchor.after(meta);
    } else {
      const runHost = $('run');
      if (runHost && meta.parentNode !== runHost) runHost.appendChild(meta);
    }
  } catch { /* placement never breaks rendering */ }
}
if (messagesEl) {
  messagesEl.addEventListener('mouseover', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('.msg.assistant') : null;
    if (a && !a.classList.contains('last')) placeAnswerMeta(a);
  });
  messagesEl.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.msg.assistant') : null;
    const from = e.target && e.target.closest ? e.target.closest('.msg.assistant') : null;
    if (to !== from) placeAnswerMeta(to && !to.classList.contains('last') ? to : null);
  });
  messagesEl.addEventListener('focusin', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('.msg.assistant') : null;
    if (a && !a.classList.contains('last')) placeAnswerMeta(a);
  });
  messagesEl.addEventListener('focusout', () => placeAnswerMeta(null));
}
function scrollToLatest(force) {
  const $viewEl = $('view');
  if (!$viewEl) return;
  if (force || !userScrolledUp) $viewEl.scrollTop = $viewEl.scrollHeight; // .view is the only scroller
  syncJump();
}
function syncJump() {
  const btn = $('jump-latest');
  if (!btn) return;
  btn.classList.toggle('hidden', !userScrolledUp || (typeof view !== 'undefined' && view !== 'run'));
}

function copySvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  else fallbackCopy(text);
}

// why: fenced blocks get a ghost Copy without changing mdLite output shape
function decorateCode(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('pre').forEach((pre) => {
    pre.dir = 'ltr';
    if (pre.querySelector('.pre-copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pre-copy';
    btn.innerHTML = copySvg() + '<span>Copy</span>';
    btn.setAttribute('aria-label', t('answer.copyCode'));
    btn.title = t('answer.copyCode');
    btn.onclick = (e) => {
      e.stopPropagation();
      copyText((pre.querySelector('code') || pre).textContent || '');
      const label = btn.querySelector('span');
      if (label) label.textContent = 'Copied';
      clearTimeout(btn._copyT);
      btn._copyT = setTimeout(() => { if (label) label.textContent = 'Copy'; }, 1500);
    };
    pre.appendChild(btn);
  });
}

async function ensureConv() {
  if (convId) return convId;
  const c = await window.nexio.createConversation('New chat');
  convId = c.id;
  void refreshHistory();
  return convId;
}

let sending = false;
async function send(submitOpts) {
  // Serialize submissions: the agentRunning() check below races with the
  // first await inside (two rapid Enters would orphan the first run —
  // its tools keep executing with no UI and no way to stop it).
  if (sending) return;
  sending = true;
  try {
    await sendInner(submitOpts || {});
  } finally {
    sending = false;
  }
}

async function sendInner(submitOpts) {
  submitOpts = submitOpts || {};
  if (inputEl.disabled) return; // settings/onboard own the composer; Esc/Back re-enables
  const text = inputEl.value.trim();
  if (!text) return;
  lastUserText = text;
  failedRun = null; // a new submit supersedes the failed state
  // View-only slashes work during a run (background continues): clear + hide before router/agent.
  {
    const early = text.split(' ')[0];
    if (early === '/extensions' || early === '/settings' || early === '/history' || early === '/log' || early === '/memory' || early === '/tasks') {
      inputEl.value = ''; drafts[mode] = ''; hideSuggest(); grow(); hidePalette();
      if (early === '/extensions') return void openExtensions();
      if (early === '/settings') return void togglePanel('settings');
      if (early === '/history') return void togglePanel('history');
      if (early === '/memory') return void openMemoryView();
      if (early === '/tasks') return void openTasksView();
      return void showAgentLog();
    }
  }
  // While-busy choice: Enter with running task(s) asks where the work goes
  // (unless queued/spawn specified, or the user saved a default).
  if (!submitOpts.queued && !submitOpts.taskAction && !text.startsWith('/')) {
    try { await refreshTasks(); } catch (e) {}
    if (tasksRunningCount() > 0) {
      var s = null;
      try { s = await window.nexio.getSettings(); } catch (e) {}
      if (s && s.taskConfirmOnSubmit !== false && (!s.taskSubmitDefault || s.taskSubmitDefault === 'ask')) {
        showTaskChoice(text);
        return;
      }
      if (s && s.taskSubmitDefault && s.taskSubmitDefault !== 'ask') submitOpts.taskAction = s.taskSubmitDefault;
    }
  }
  if (agentRunning() && !submitOpts.queued && !submitOpts.taskAction) return; // foreground busy; Stop first
  inputEl.value = '';
  hideSuggest();
  hideTaskChoice();
  grow();
  hidePalette();
  if (mode === 'agent' && !text.startsWith('/')) {
    // An armed skill body goes in as context for this run only.
    if (pendingSkill) {
      const armed = pendingSkill;
      pendingSkill = null;
      return void startAgentRun(`Following skill "${armed.name}":\n${armed.body}\n\nUser task: ${text}`, submitOpts);
    }
    return void startAgentRun(text, submitOpts);
  }
  if (text.startsWith('/')) {
    const [trigger, ...rest] = text.split(' ');
    const r = await window.nexio.slashResolve(trigger, mode);
    if (r.found) {
      if (r.found.scope && r.found.scope !== 'all' && r.found.scope !== mode) {
        addMsg('assistant', t('slash.scopeOnly', { trigger: trigger, scope: r.found.scope }));
        showView('run');
        return;
      }
      if (r.found.source === 'workflow') {
        // Workflows run in Do mode only: offer the switch chip in Ask.
        if (mode === 'chat') {
          addMsg('user', text);
          showView('run');
          const div = addMsg('assistant', 'Workflows run in Do mode.');
          div.appendChild(switchToDoChip(text));
          return;
        }
        // v1 extension workflows open an input form; legacy ones run directly.
        try {
          const info = await window.nexio.ext({ action: 'workflowInfo', trigger });
          if (info && info.kind === 'ext') return void openWorkflowForm(trigger, info);
        } catch { /* fall through to legacy path */ }
        startTurn();
        addMsg('user', text);
        showView('run');
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
      if (trigger === '/memory') { inputEl.value = ''; drafts[mode] = ''; hideSuggest(); grow(); hidePalette(); return void openMemoryView(); }
      if (trigger === '/remember') return void runRememberCommand(rest.join(' '));
      if (trigger === '/forget') return void runForgetCommand(rest.join(' '));
      if (trigger === '/incognito') return void runIncognitoCommand();
      if (trigger === '/tasks') { inputEl.value = ''; drafts[mode] = ''; hideSuggest(); grow(); hidePalette(); return void openTasksView(); }
      if (trigger === '/spawn' || trigger === '/queue') {
        const body = rest.join(' ').trim();
        if (!body) { addMsg('assistant', t(trigger === '/spawn' ? 'slash.usageSpawn' : 'slash.usageQueue')); showView('run'); return; }
        inputEl.value = body; drafts[mode] = body; hideSuggest(); grow(); hidePalette();
        return void send(trigger === '/spawn' ? { taskAction: 'spawn' } : { queued: true });
      }
      if (trigger === '/cancel') return void runCancelCommand(rest.join(' '));
      if (trigger === '/clear-queue') return void runClearQueueCommand();
      if (trigger === '/new') return void newChat();
      if (trigger === '/clear') { messagesEl.innerHTML = ''; assistantDiv = null; currentTurn = null; const st0 = $('agent-steps'); if (st0) st0.innerHTML = ''; const ch0 = $('run-chips'); if (ch0) ch0.remove(); inputEl.value = ''; drafts[mode] = ''; try { if (typeof clearAttachTray === 'function') clearAttachTray(); } catch {} hideSuggest(); showView('idle'); try { maybeSuggest(); } catch {} syncChrome(); requestResize(); return; }
      if (trigger === '/help') {
        addMsg('assistant', '**Commands:** /help /new /clear /model /history /settings /log /extensions + prompt templates + workflows + skills.\nType `/` to browse.');
        showView('run');
        return;
      }
      // view-only slashes handled before router/agent at the top of sendInner
      if (trigger === '/model') {
        if (rest[0]) { await window.nexio.setSettings({ model: rest[0] }); addMsg('assistant', `Model → ${esc(rest[0])}`); }
        else { const s = await window.nexio.getSettings(); addMsg('assistant', `Current model: ${esc(s.model)}`); }
        showView('run');
        return;
      }
      addMsg('user', text);
      showView('run');
      // prompt template: send rendered via chat
      const id = await ensureConv();
      assistantDiv = addMsg('assistant', '…');
      try {
        const claim = typeof window.attachClaimForSend === 'function' ? window.attachClaimForSend() : null;
        const sendOpts = { mode, sessionId: id, requestId: `r${Date.now()}-${++reqSeq}`, explicit: modeExplicitSession };
        lastRequestId = sendOpts.requestId;
        if (claim && claim.attachments) sendOpts.attachments = claim.attachments;
        const sendP = window.nexio.send(id, text, sendOpts);
        try { if (claim && claim.had && typeof window.attachMarkSent === 'function') window.attachMarkSent(id); } catch { /* noop */ }
        await sendP;
      } catch (e) {
        assistantDiv.innerHTML = mdLite(errText(e));
        inputEl.value = text; // keep unsent input after failures
        drafts[mode] = text;
        grow();
      }
      return;
    }
    addMsg('assistant', `Unknown command ${esc(trigger)}. Did you mean: ${(r.suggestions || []).map((s) => esc(s.trigger)).join(', ') || '—'}?`);
    showView('run');
    return;
  }
  startTurn();
  addMsg('user', text);
  showView('run');
  const id = await ensureConv();
  lastAskPrompt = mode === 'chat' ? text : '';
  lastUserText = text;
  assistantDiv = addMsg('assistant', '…');
  try {
    const requestId = `r${Date.now()}-${++reqSeq}`;
    lastRequestId = requestId;
    const claim = typeof window.attachClaimForSend === 'function' ? window.attachClaimForSend() : null;
    const sendOpts = { mode, sessionId: id, requestId, explicit: modeExplicitSession };
    if (submitOpts.queued) sendOpts.queued = true;
    if (submitOpts.taskAction) sendOpts.taskAction = submitOpts.taskAction;
    if (submitOpts.priority) sendOpts.priority = submitOpts.priority;
    if (claim && claim.attachments) sendOpts.attachments = claim.attachments;
    const sendP = window.nexio.send(id, text, sendOpts);
    try { if (claim && claim.had && typeof window.attachMarkSent === 'function') window.attachMarkSent(id); } catch { /* noop */ }
    await sendP;
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
  decorateCode(assistantDiv);
  scrollToLatest();
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
  const composing = e.isComposing || e.keyCode === 229;
  if (e.key === 'Tab' && document.activeElement === inputEl && !paletteOpen && !composing) {
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
      if (e.shiftKey || composing) return; // Shift+Enter newline, no preventDefault
      e.preventDefault(); pickPalette(paletteActive);
    }
    else if (e.key === 'Escape') { hidePalette(); }
  } else if (e.key === 'Enter') {
    if (e.shiftKey || composing) return; // Shift+Enter newline, no preventDefault
    // Undecided approval with an empty composer: Enter allows once
    // (the card itself handles Enter when focused; this covers composer focus).
    if (!inputEl.value) {
      const allow = document.querySelector('#agent-steps .appr .btn-allow');
      if (allow) { e.preventDefault(); allow.click(); return; }
    }
    // Ctrl/Cmd+Enter always pushes to the queue ("do this later"), even free.
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); void send({ queued: true }); return; }
    e.preventDefault(); void send();
  }
  else if (e.key === 'Escape') {
    // why: an open More menu closes first — Esc must not clear the composer under it.
    try {
      const mm = document.getElementById('more-menu');
      if (mm && !mm.classList.contains('hidden')) { closeMoreMenu(true); return; }
    } catch { /* menu best-effort */ }
    // why: Esc answers the approval first (deny), then clears a failed run —
    // it only stops/clears when something is active, else closes.
    const appr = document.querySelector('#agent-steps .appr');
    if (appr) {
      const deny = appr.querySelector('.btn-deny');
      if (deny) deny.click();
      return;
    }
    if (typeof failedRun !== 'undefined' && failedRun && !inputEl.value) {
      clearFailedRun();
      try { inputEl.focus(); } catch { /* noop */ }
      return;
    }
    if (typeof agentRunning === 'function' && agentRunning()) {
      stopAgentRun();
      try { inputEl.focus(); } catch { /* noop */ }
      return;
    }
    // why: Esc clears first (input, then last attachment) and only closes an empty composer.
    if (inputEl.value) {
      inputEl.value = ''; drafts[mode] = '';
      try { grow(); } catch { /* noop */ }
      try { inputEl.focus(); } catch { /* noop */ }
      try { syncChrome(); } catch { /* noop */ }
    } else if (attachPending() > 0 && typeof window.attachRemoveLast === 'function') window.attachRemoveLast();
    else window.close?.();
  }
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

$('btn-send').onclick = (e) => void send(e && e.shiftKey ? { queued: true, priority: 'high' } : undefined);
$('tab-chat').onclick = () => selectMode('chat');
$('tab-agent').onclick = () => selectMode('agent');
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); selectMode(mode === 'chat' ? 'agent' : 'chat'); }
  else if (e.altKey && e.key === '1') { e.preventDefault(); selectMode('chat'); }
  else if (e.altKey && e.key === '2') { e.preventDefault(); selectMode('agent'); }
  // Queued rows reorder with Alt+Up/Alt+Down inside the Tasks view.
  else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && view === 'tasks' && taskDetailId) {
    var row = taskCache.get(taskDetailId);
    if (row && row.state === 'queued' && !row.parentId) {
      e.preventDefault();
      void taskOp('move', { id: taskDetailId, dir: e.key === 'ArrowUp' ? -1 : 1 });
    }
  }
});
function defaultView() { return hasRun() ? 'run' : 'idle'; }
// why: single-view — exactly one node in .view; every switch re-syncs chrome + size
function showView(name) {
  if (name == null) name = 'idle';
  if (name === 'messages') name = 'run'; // legacy alias
  if (name !== 'run' && document.querySelector('#agent-steps .appr')) { flashApproval(); return; } // never bury an undecided approval
  if (name !== 'idle' && name !== 'run' && (view === 'idle' || view === 'run')) returnTo = view;
  view = name;
  if (name !== 'idle') hideSuggest(); // suggestions live on idle only
  currentView = name === 'run' ? 'messages' : name === 'idle' ? null : name; // legacy alias
  paletteEl.classList.toggle('hidden', name !== 'palette');
  const runEl = $('run');
  if (runEl) runEl.classList.toggle('hidden', name !== 'run');
  messagesEl.classList.toggle('hidden', name !== 'run');
  $('settings').classList.toggle('hidden', name !== 'settings');
  $('history').classList.toggle('hidden', name !== 'history');
  $('extensions').classList.toggle('hidden', name !== 'extensions');
  $('memory').classList.toggle('hidden', name !== 'memory');
  $('tasks').classList.toggle('hidden', name !== 'tasks');
  $('onboard').classList.toggle('hidden', name !== 'onboard');
  // footer icon reflects its open panel; run/idle/palette show none
  const panelOn = (id, on) => { const b = $(id); if (b) b.classList.toggle('on', on); };
  panelOn('btn-ext', name === 'extensions');
  panelOn('btn-history', name === 'history');
  panelOn('btn-settings', name === 'settings');
  panelOn('btn-tasks', name === 'tasks');
  if (name === 'tasks') void refreshTasks();
  if ($('view')) $('view').classList.toggle('hidden', name === 'idle');
  if (name === 'run') flushMemPushes();
  const wasDisabled = inputEl.disabled;
  inputEl.disabled = name === 'settings' || name === 'onboard';
  if (name === 'settings') {
    inputEl.placeholder = t('composer.placeholder.settings');
    hidePalette(); hideSuggest(); // clear /c: no slash palette or suggestions behind settings
  } else if (wasDisabled) updateModeUI(); // restores mode placeholder
  updateRunChip();
  syncChrome();
  requestResize();
  syncJump();
  assertSingleView();
}
// dev-only: exactly one top-level view node (idle holds none, or suggest alone)
function assertSingleView() {
  try {
    const ids = ['palette', 'suggest', 'run', 'settings', 'history', 'extensions', 'memory', 'tasks', 'onboard'];
    const vis = ids.filter((id) => { const el = $(id); return el && !el.classList.contains('hidden'); });
    const sug = $('suggest');
    const sugVisible = !!(sug && !sug.classList.contains('hidden'));
    const expect = view === 'idle' ? (sugVisible ? 1 : 0) : 1;
    if (vis.length !== expect) console.assert(false, 'single-view: expected ' + expect + ' visible, got ' + vis.join(','));
  } catch {}
}
function togglePanel(which) {
  if (view === which) showView(backTarget());
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
  if ($('set-askread')) $('set-askread').checked = s.askReadEnabled !== false;
  void paintAskMcp(s.askMcpTools || []);
  if ($('set-mem')) $('set-mem').checked = s.memoryEnabled === true;
  paintMemKinds(s.memoryKinds, s.memoryEnabled === true);
  if ($('set-mem') && !$('set-mem').dataset.memwired) {
    $('set-mem').dataset.memwired = '1';
    $('set-mem').addEventListener('change', () => {
      const host = $('set-mem-kinds');
      if (!host || !$('set-mem')) return;
      const on = $('set-mem').checked;
      host.setAttribute('aria-disabled', String(!on));
      host.querySelectorAll('input[data-memkind]').forEach((c) => { c.disabled = !on; });
    });
  }
  if ($('set-mem-suggest')) $('set-mem-suggest').checked = s.memorySuggest === true;
  if ($('set-mem-semantic')) $('set-mem-semantic').checked = s.memorySemantic === true;
  if ($('set-mem-ask')) $('set-mem-ask').checked = s.memoryUseInAsk !== false;
  if ($('set-incognito')) $('set-incognito').checked = s.incognito === true;
  incognitoOn = s.incognito === true;
  paintIncognito();
  void refreshMemInfo();
  $('set-suggest').value = (s.suggestions || []).join('\n');
  if ($('set-hotkey')) $('set-hotkey').value = s.hotkey || currentToggleHotkey;
  if ($('set-stophotkey') && s.agentStopHotkey) currentStopHotkey = s.agentStopHotkey;
  if ($('set-login')) $('set-login').checked = s.launchAtLogin === true;
  try { paintTaskSettings(s); } catch (e) {}
  void refreshHotkeyStatus();
  paintAgentRoots(s.agentAllowedRoots || []);
  paintAgentRules(s.agentAlwaysAllow || []);
  document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
};
$('btn-settings-back').onclick = () => { showView(backTarget()); inputEl.focus(); };
$('btn-history-back').onclick = () => { showView(backTarget()); inputEl.focus(); };
$('btn-history').onclick = () => togglePanel('history');
$('btn-save-settings').onclick = async () => {
  const patch = {
    provider: settingsProvider,
    model: $('set-model').value,
    agentCwd: $('set-agentcwd').value.trim(),
  };
  // Custom keeps its own base URL (empty clears a stale one); other providers use their default.
  if (settingsProvider === 'compatible') patch.baseUrl = $('set-baseurl').value.trim().replace(/\/+$/, '') || '';
  else patch.baseUrl = '';
  if (settingsProvider === 'compatible' && $('set-sendtemp')) patch.sendTemperature = $('set-sendtemp').checked;
  patch.agentStopHotkey = $('set-stophotkey').value.trim() || 'Ctrl+Alt+Esc';
  const mc = parseInt($('set-maxcalls').value, 10);
  if (Number.isFinite(mc)) patch.agentMaxCalls = Math.min(100, Math.max(1, mc));
  patch.requireApprovalForWrites = $('set-reqapprove').checked; // shell_run always needs approval regardless
  if ($('set-askread')) patch.askReadEnabled = $('set-askread').checked;
  patch.askMcpTools = Array.from(document.querySelectorAll('#ask-mcp input[data-askmcp]'))
    .filter((c) => c.checked).map((c) => c.dataset.askmcp);
  if ($('set-mem')) patch.memoryEnabled = $('set-mem').checked;
  patch.memoryKinds = {};
  document.querySelectorAll('#set-mem-kinds input[data-memkind]').forEach((c) => { patch.memoryKinds[c.dataset.memkind] = c.checked; });
  if ($('set-mem-suggest')) patch.memorySuggest = $('set-mem-suggest').checked;
  if ($('set-mem-semantic')) patch.memorySemantic = $('set-mem-semantic').checked;
  if ($('set-mem-ask')) patch.memoryUseInAsk = $('set-mem-ask').checked;
  if ($('set-incognito')) patch.incognito = $('set-incognito').checked;
  const hk = $('set-hotkey') && $('set-hotkey').value.trim();
  if (hk) patch.hotkey = hk;
  if ($('set-login')) patch.launchAtLogin = $('set-login').checked;
  try { readTaskSettings(patch); } catch (e) {}
  const sug = $('set-suggest').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  if (sug.length) patch.suggestions = sug;
  suggestCache = null;
  await window.nexio.setSettings(patch);
  try {
    const sNow = await window.nexio.getSettings();
    incognitoOn = sNow.incognito === true;
    paintIncognito();
  } catch { /* badge best-effort */ }
  { const k = $('set-apikey').value.trim(); if (k) await window.nexio.setApiKey(patch.provider, k); }
  $('set-apikey').value = '';
  void paintSecretsNotice();
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
    // Unsaved panel values only; the hidden base URL is ignored unless Custom. Key never logged.
    const testBase = settingsProvider === 'compatible' ? $('set-baseurl').value.trim().replace(/\/+$/, '') : '';
    const r = await window.nexio.testConnectivity(
      settingsProvider, $('set-model').value.trim(),
      testBase || undefined, $('set-apikey').value.trim() || undefined);
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
    const sugBase = settingsProvider === 'compatible' ? $('set-baseurl').value.trim().replace(/\/+$/, '') : '';
    const models = await window.nexio.listModels(settingsProvider, sugBase || undefined);
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
  convId = c.id; messagesEl.innerHTML = ''; assistantDiv = null; currentTurn = null;
  inputEl.value = ''; drafts.chat = ''; drafts.agent = ''; // fresh composer
  try { if (typeof clearAttachTray === 'function') clearAttachTray(); } catch {}
  hideSuggest();
  const stN = $('agent-steps'); if (stN) stN.innerHTML = '';
  const chN = $('run-chips'); if (chN) chN.remove();
  showView('idle');
  try { maybeSuggest(); } catch {}
  void refreshHistory();
}
async function refreshHistory() {
  const list = await window.nexio.listConversations();
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.textContent = c.title || c.id;
    li.dataset.cid = c.id;
    li.onclick = async () => {
      convId = c.id; messagesEl.innerHTML = ''; currentTurn = null; currentTurn = null;
      const msgs = await window.nexio.getMessages(c.id);
      for (const m of msgs) {
        if (m.role === 'user') startTurnQuiet();
        addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
      }
      pruneTurns();
      markLastAnswer();
      showView('run');
    };
    ul.appendChild(li);
  }
}
(async () => {
  try {
    const s = await window.nexio.getSettings();
    document.documentElement.dataset.theme = 'dark'; // dark-only UI; stored theme untouched
    mode = s.mode === 'agent' ? 'agent' : 'chat';
    // why: locale first — every t() below falls back to the raw key without it.
    try { await loadLocale(); } catch {}
    applyLocale();
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
  const palOpen = view === 'palette';
  const panelOpen = view === 'settings' || view === 'history' || view === 'extensions' || view === 'memory' || view === 'tasks' || view === 'onboard';
  const agentActive = (typeof agentRunning === 'function' && agentRunning()) ||
    ($('agent-steps') && $('agent-steps').children.length > 0);
  const idle = !inputEl.value && !hasMsgs && !palOpen && !panelOpen && !agentActive && attachPending() === 0;
  if ($('panel')) $('panel').classList.toggle('has-results', hasMsgs || palOpen);
  if ($('hotkey-hint')) $('hotkey-hint').classList.toggle('hidden', !idle);
  if ($('modebar')) $('modebar').classList.toggle('hidden', idle);
  const multi = !palOpen && !hasMsgs && !!inputEl.value && (inputEl.value.includes('\n') || inputEl.scrollHeight > 32);
  if ($('hint-nav')) $('hint-nav').classList.toggle('hidden', multi);
  // why: Esc hint always shows; the label tracks state. The textContent write
  // is guarded: an unconditional write re-triggers the panel
  // MutationObserver every pass (same class of loop as updateRunChip).
  var hasInput = !!inputEl.value;
  var hasAttach = attachPending() > 0;
  if ($('hint-tab')) $('hint-tab').classList.toggle('hidden', !(inputEl && !inputEl.value && document.activeElement === inputEl && !inputEl.disabled));
  var escLabel = (hasInput || hasAttach || hasMsgs) ? 'clear' : 'close';
  var escLabelEl = $('hint-esc-label');
  if (escLabelEl && escLabelEl.textContent !== escLabel) escLabelEl.textContent = escLabel;
  if ($('hint-multi')) $('hint-multi').classList.toggle('hidden', !multi);
  const hasAnswer = view === 'run' && !!messagesEl.querySelector('.msg.assistant');
  if ($('answer-meta')) $('answer-meta').classList.toggle('hidden', !hasAnswer);
  if ($('actions')) $('actions').classList.toggle('hidden', !hasAnswer);
  // why: footer lives in the panel shell outside .view — always visible, every state
  var sendBtn = $('btn-send');
  if (sendBtn) {
    var sendEmpty = !inputEl.value && attachPending() === 0;
    sendBtn.disabled = sendEmpty;
    sendBtn.setAttribute('aria-disabled', String(sendEmpty));
  }
  // single Tab keycap beside the pill: only when composer focused-and-empty (hover handled in CSS)
  document.body.classList.toggle('show-tabkey', document.activeElement === inputEl && !inputEl.value && !inputEl.disabled);
  try { layoutAnswerActions(); } catch { /* actions best-effort */ }
  // why: footer fitting runs only when hint visibility actually changed — its
  // own crowd-hide mutations must never retrigger it through the observer.
  try {
    const key = ['hint-tab', 'hint-enter', 'hint-queue', 'hint-multi', 'hint-nav',
      'hint-readonly', 'hint-sep', 'hint-approval'].map((id) => {
        const el = $(id);
        return el ? (el.classList.contains('hidden') ? '0' : '1') : '-';
      }).join('');
    if (key !== lastFooterKey) { lastFooterKey = key; fitFooterHints(); }
  } catch { /* fit best-effort */ }
  try { paintIncognito(); } catch { /* badge best-effort */ }
  updateRunChip();
}
// why: keep artboard grouped palette + selected accent + enter cap without touching core logic
renderPalette = function () {
  hideSuggest(); // slash palette and starter suggestions never co-show
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
    if ($('model-name') && s.model) {
      $('model-name').textContent = s.model;
      $('model-name').title = s.model; // ellipsis tooltip carries the full name
      const dot = document.querySelector('#answer-meta .dot');
      if (dot) dot.title = s.model;
      try { fitAnswerMeta(); } catch { /* fit best-effort */ }
    }
  } catch { /* preview */ }
}
void refreshModelName();
// focus composer on load: window-focus may have fired before listeners attached,
// leaving a fresh window with body focused until the next focus event
try { inputEl.focus(); } catch { /* preview */ }
setTimeout(() => { try { if (document.activeElement !== inputEl) inputEl.focus(); } catch {} }, 60);
if ($('btn-save-settings')) $('btn-save-settings').addEventListener('click', () => setTimeout(() => { void refreshModelName(); requestResize(); }, 100));
if ($('btn-copy')) $('btn-copy').addEventListener('click', async () => {
  const btn = $('btn-copy');
  const divs = messagesEl.querySelectorAll('.msg.assistant');
  const last = divs[divs.length - 1];
  if (!last) return;
  const text = (last.dataset && last.dataset.raw) || last.textContent || '';
  try { await navigator.clipboard.writeText(text); }
  catch { fallbackCopy(text); }
  // why: ghost buttons confirm inline; orig stored once so rapid clicks still restore the icon markup
  if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
  const orig = btn.dataset.orig;
  btn.innerHTML = copySvg() + 'Copied';
  setTimeout(() => { btn.innerHTML = orig; }, 1500);
});
if ($('btn-followup')) $('btn-followup').addEventListener('click', () => inputEl.focus());
if ($('btn-newchat')) $('btn-newchat').addEventListener('click', () => void newChat());
if ($('btn-task-spawn')) $('btn-task-spawn').addEventListener('click', () => {
  closeMoreMenu(false);
  const text = (typeof lastUserText === 'string' && lastUserText.trim()) || inputEl.value.trim();
  if (!text) return;
  inputEl.value = text;
  void send({ taskAction: 'spawn' });
});
if ($('btn-task-queue')) $('btn-task-queue').addEventListener('click', () => {
  closeMoreMenu(false);
  const text = (typeof lastUserText === 'string' && lastUserText.trim()) || inputEl.value.trim();
  if (!text) return;
  inputEl.value = text;
  void send({ queued: true });
});
// why: meta row reads model left, ghost actions right; IDs and handlers move with the node
(function layoutMetaRow() {
  const meta = $('answer-meta'), actions = $('actions');
  if (meta && actions && actions.parentNode !== meta) meta.appendChild(actions);
})();
// --- answer actions: Copy + Follow up visible, the rest in a More menu ---
// Ask mode shows New chat as a visible button instead of More (its menu would
// hold only that item); task items hide in Ask and without the tasks bridge.
function tasksAvailable() {
  try { return !!(window.nexio && window.nexio.tasks); } catch { return false; }
}
function layoutAnswerActions() {
  const ask = (typeof mode !== 'undefined' && mode === 'chat') || !tasksAvailable();
  const more = document.querySelector('#actions .more-wrap');
  const fresh = $('btn-newchat');
  if (more) more.classList.toggle('hidden', ask);
  if (fresh) fresh.classList.toggle('hidden', !ask);
  if (ask) closeMoreMenu();
  const spawn = $('btn-task-spawn'), queue = $('btn-task-queue');
  const showTasks = !ask && tasksAvailable();
  if (spawn) spawn.classList.toggle('hidden', !showTasks);
  if (queue) queue.classList.toggle('hidden', !showTasks);
  const sc = $('queue-shortcut');
  if (sc) {
    const mac = typeof platformInfo !== 'undefined' && platformInfo && platformInfo.os === 'darwin';
    const want = mac ? 'Cmd+Enter' : 'Ctrl+Enter';
    if (sc.textContent !== want) sc.textContent = want;
  }
  fitAnswerMetaOnMode();
}
function moreMenuItems() {
  return [...document.querySelectorAll('#more-menu button')].filter((b) => !b.classList.contains('hidden'));
}
function openMoreMenu() {
  const menu = $('more-menu'), btn = $('btn-more');
  if (!menu || !btn) return;
  layoutAnswerActions();
  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  // flip upward when there is no room below (never clipped, never resizes)
  menu.classList.remove('flip');
  try {
    const view = $('view');
    const mr = menu.getBoundingClientRect();
    const vr = (view || document.body).getBoundingClientRect();
    if (mr.bottom > vr.bottom) menu.classList.add('flip');
  } catch {}
  const items = moreMenuItems();
  items.forEach((b, i) => b.tabIndex = i === 0 ? 0 : -1);
  if (items[0]) items[0].focus();
  document.addEventListener('click', closeMoreMenuOutside, true);
}
function closeMoreMenu(refocus) {
  const menu = $('more-menu'), btn = $('btn-more');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', closeMoreMenuOutside, true);
  if (refocus && btn) btn.focus();
}
function closeMoreMenuOutside(e) {
  const wrap = document.querySelector('.more-wrap');
  if (wrap && !wrap.contains(e.target)) closeMoreMenu(false);
}
function toggleMoreMenu() {
  const menu = $('more-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openMoreMenu();
  else closeMoreMenu(false);
}
if ($('btn-more')) {
  $('btn-more').addEventListener('click', () => toggleMoreMenu());
  $('btn-more').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMoreMenu(); }
  });
}
if ($('btn-menu-newchat')) $('btn-menu-newchat').addEventListener('click', () => { closeMoreMenu(false); void newChat(); });
if ($('more-menu')) $('more-menu').addEventListener('keydown', (e) => {
  const items = moreMenuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMoreMenu(true); }
  else if (e.key === 'Tab') { closeMoreMenu(false); } // close, focus moves on
  else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1])?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
});
// Narrow answer meta: icon-only actions first, then dot-only model. Container
// query via ResizeObserver with hysteresis (no fixed breakpoints, follows
// font scale + RTL). Hysteresis matters: the toggles change the measured
// width, so a single threshold would ping-pong forever and wedge the page.
function fitAnswerMeta() {
  const meta = $('answer-meta');
  if (!meta || meta.classList.contains('hidden')) return;
  const w = meta.clientWidth;
  // why: unmeasurable (hidden window) — show everything; a real layout refits.
  if (!(w > 0)) { meta.classList.remove('compact'); meta.classList.remove('minimal'); return; }
  const compact = meta.classList.contains('compact');
  // why: add on narrow container OR overflowing content (large fonts), drop
  // only on comfortably wide — asymmetric so the toggle can never ping-pong.
  if (!compact && w > 0 && (w < 420 || meta.scrollWidth > meta.clientWidth + 1)) meta.classList.add('compact');
  else if (compact && w > 460) {
    meta.classList.remove('compact');
    meta.classList.remove('minimal');
  }
  const actions = $('actions');
  if (actions) actions.classList.toggle('compact', meta.classList.contains('compact'));
  // why: minimal never outlives compact (removal is container-driven, never a
  // scrollWidth slack that can never be true) — the chain cannot ping-pong.
  if (meta.classList.contains('compact') && !meta.classList.contains('minimal') &&
      meta.scrollWidth > meta.clientWidth + 1) {
    meta.classList.add('minimal');
  }
}
var lastAnswerMode = '';
function fitAnswerMetaOnMode() {
  if (mode !== lastAnswerMode) { lastAnswerMode = mode; fitAnswerMeta(); }
}
if (typeof ResizeObserver !== 'undefined' && $('answer-meta')) {
  new ResizeObserver(() => { fitAnswerMeta(); }).observe($('answer-meta'));
}
// Tight footer: hide hints from the right (queue, clear, run, switch mode),
// never wrap. crowd-hide is separate from state .hidden so they never fight;
// unhiding needs 160px slack or hints would ping-pong too.
function fitFooterHints() {
  const hints = $('f-hints');
  if (!hints) return;
  const seq = ['hint-queue', 'hint-esc', 'hint-enter', 'hint-tab'];
  // why: unmeasurable (hidden window) — show everything; a real layout refits.
  if (!(hints.clientWidth > 0)) {
    for (const id of seq) {
      const el = $(id);
      if (el) el.classList.remove('crowd-hide');
    }
    return;
  }
  const over = () => hints.scrollWidth > hints.clientWidth + 1;
  const roomy = () => hints.scrollWidth < hints.clientWidth - 160;
  for (const id of seq) {
    const el = $(id);
    if (over() && el && !el.classList.contains('hidden')) el.classList.add('crowd-hide');
  }
  for (const id of [...seq].reverse()) {
    const el = $(id);
    if (el && el.classList.contains('crowd-hide') && roomy()) el.classList.remove('crowd-hide');
  }
}
if (typeof ResizeObserver !== 'undefined' && $('hints')) {
  new ResizeObserver(() => { fitFooterHints(); }).observe($('hints'));
}
// segmented provider is the only provider control (native select deleted);
// Base URL row shows only for Custom
function paintProv() {
  const seg = $('set-prov-seg');
  if (seg) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.prov === settingsProvider));
  const fb = $('fld-baseurl');
  if (fb) fb.classList.toggle('hidden', settingsProvider !== 'compatible');
  const st = $('fld-sendtemp');
  if (st) st.classList.toggle('hidden', settingsProvider !== 'compatible');
  void paintSecretsNotice();
}
// why: unreadable stored keys fail visibly here, not later as a raw error mid-run.
async function paintSecretsNotice() {
  const note = $('key-note');
  if (!note) return;
  let st = null;
  try { if (window.nexio && window.nexio.secretsStatus) st = await window.nexio.secretsStatus(); } catch { /* notice best-effort */ }
  const enc = $('enc-note');
  if (enc) {
    if (st && !st.available) enc.textContent = 'Secure storage is not available on this device.';
    else if (typeof platformInfo !== 'undefined' && platformInfo && platformInfo.secretStore) {
      enc.textContent = `Encrypted on this device (${platformInfo.secretStore}).`;
    }
  }
  if (!st) { note.classList.add('hidden'); return; }
  const id = `apikey:${settingsProvider}`;
  const msgs = [];
  if (!st.available) msgs.push('Secure storage is unavailable — a pasted key is kept for this session only.');
  if ((st.reentry || []).includes(id)) msgs.push("Saved key couldn't be unlocked. Paste it again to continue.");
  const others = (st.reentry || []).filter((x) => x !== id).map((x) => x.replace(/^apikey:/, ''));
  if (others.length) msgs.push(`Also needs re-entry: ${others.join(', ')}.`);
  note.textContent = msgs.join(' ');
  note.classList.toggle('hidden', msgs.length === 0);
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
  // why: an open More menu dismisses first — capture runs before the menu's
  // own handler and before run-clearing below.
  try {
    const mm = document.getElementById('more-menu');
    if (mm && !mm.classList.contains('hidden')) { e.stopPropagation(); closeMoreMenu(true); return; }
  } catch { /* menu best-effort */ }
  if (agentRunning()) { // Esc stops a running agent before collapsing anything
    e.stopPropagation();
    stopAgentRun();
    inputEl.focus();
    return;
  }
  const palOpen = !paletteEl.classList.contains('hidden');
  if (palOpen) { e.stopPropagation(); hidePalette(); inputEl.focus(); return; }
  const setOpen = view === 'settings';
  const histOpen = view === 'history';
  const extOpen = view === 'extensions';
  const memOpen = view === 'memory';
  const taskOpen = view === 'tasks';
  const obOpen = view === 'onboard';
  const sugBox = $('suggest');
  if (sugBox && !sugBox.classList.contains('hidden')) { e.stopPropagation(); hideSuggest(); inputEl.focus(); return; }
  if (dismissRootConfirm()) { e.stopPropagation(); if (rootConfirmPrior && document.contains(rootConfirmPrior)) rootConfirmPrior.focus(); else ($('btn-agent-add-root') || inputEl).focus(); rootConfirmPrior = null; return; } // Esc drops the add-folder confirm first, restoring prior focus
  if (setOpen || histOpen || extOpen || memOpen || taskOpen || obOpen) { // dismiss panels before collapsing results
    e.stopPropagation();
    if (view === 'onboard') { void skipOnboard(); return; }
    showView(backTarget());
    syncChrome(); requestResize(); inputEl.focus(); return;
  }
  if (hasRun()) {
    e.stopPropagation();
    if (document.querySelector('#agent-steps .appr')) { flashApproval(); inputEl.focus(); return; } // never bury an undecided approval
    messagesEl.innerHTML = '';
    assistantDiv = null;
    currentTurn = null;
    inputEl.value = ''; drafts.chat = ''; drafts.agent = ''; // fresh composer
    try { if (typeof clearAttachTray === 'function') clearAttachTray(); } catch {}
    hideSuggest();
    const stC = $('agent-steps'); if (stC) stC.innerHTML = '';
    const chC = $('run-chips'); if (chC) chC.remove();
    showView('idle');
    syncChrome();
    requestResize();
    try { maybeSuggest(); } catch {}
    inputEl.focus();
  }
}, true);
/* --- Agent mode (appended): step list, approvals, stop, working folder, /log --- */
// var (not let): boot code above calls syncChrome() before this block executes.
var agentState = null; // {runId, rows:Map, answerDiv}
var agentCwd = '';
// Last Ask prompt (for the "Switch to Do and run this" chip — resends, never auto-runs).
var lastAskPrompt = '';

// Quiet ghost chip: switches to Do and re-sends the same prompt. The Do run
// still shows its normal approval card; nothing executes without approval.
function switchToDoChip(promptText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'switch-do-chip';
  btn.textContent = 'Switch to Do and run this';
  btn.title = 'Switch to Do mode and re-send this prompt (approvals still apply)';
  btn.setAttribute('aria-label', 'Switch to Do and run this');
  btn.onclick = () => {
    const text = (promptText || '').trim() || (inputEl.value || '').trim();
    if (!text) return;
    try { btn.closest('.switch-do-row')?.remove(); } catch {}
    try { requestResize(); } catch {}
    selectMode('agent');
    inputEl.value = text;
    drafts.agent = text;
    grow();
    void send();
  };
  return btn;
}

// mirrors shared/conversation.ts isActionLike: structural action signal only,
// no verb lists (same rule as the intent router's structural pass).
function isActionLike(text) {
  const t = String(text || '').trim();
  if (!t || t[0] === '/') return false;
  if (/[?\uFF1F\u061F\u037E]\s*$/u.test(t)) return false;
  return /([A-Za-z]:\\|\/(Users|home|tmp|etc|var)\/|\.(txt|md|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip|json|ts|js|py)\b)/.test(t);
}

/** Answer-area Do chip: Ask zero-tool answers that plausibly wanted action
 * get a sibling row (never inside the sentence); greetings never do. */
function doSwitchRow(promptText) {
  const row = document.createElement('div');
  row.className = 'switch-do-row';
  row.appendChild(switchToDoChip(promptText));
  return row;
}

function agentRunning() { return !!agentState; }

function agentScroll() {
  if (userScrolledUp) { syncJump(); return; } // scrolled-up reader holds position; jump button shows
  const $viewEl = $('view');
  if ($viewEl) $viewEl.scrollTop = $viewEl.scrollHeight;
  syncJump();
}
if ($('view')) $('view').addEventListener('scroll', () => {
  const el = $('view');
  userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 120;
  syncJump();
}, { passive: true });
if ($('jump-latest')) $('jump-latest').onclick = () => {
  const $viewEl = $('view');
  if ($viewEl) $viewEl.scrollTop = $viewEl.scrollHeight;
  userScrolledUp = false;
  syncJump();
};

// why: footer fitting runs only when hint visibility actually changed — its
// own crowd-hide mutations must never retrigger it through the observer.
var lastFooterKey = '';
function syncAgentFooter() {
  const running = agentRunning();
  if ($('btn-stop')) $('btn-stop').classList.toggle('hidden', !running);
  if ($('stop-hint')) $('stop-hint').classList.toggle('hidden', !running);
  // Failed Do run, nothing active: footer Retry + Esc-clear (no idle hints).
  const failed = !running && !!failedRun;
  if ($('btn-retry')) $('btn-retry').classList.toggle('hidden', !failed);
  // Approval cards decide the footer: only allow/deny hints while one is open.
  const approval = !!document.querySelector('#agent-steps .appr');
  if ($('hint-approval')) $('hint-approval').classList.toggle('hidden', !approval);
  // A running task owns the footer: Stop + Esc only. Idle Tab/Enter/queue hide
  // while it runs; the trailing syncChrome in every caller restores them after.
  // A failed run shows Retry + Esc-clear instead of the idle hints.
  // Ask mode never queues: the queue hint stays hidden there in every state.
  const quiet = running || approval || failed;
  const askMode = typeof mode !== 'undefined' && mode === 'chat';
  for (const id of ['hint-tab', 'hint-enter', 'hint-queue']) {
    const el = $(id);
    if (!el) continue;
    if (id === 'hint-queue' && askMode) el.classList.add('hidden');
    else el.classList.toggle('hidden', quiet);
  }
  try { fitFooterHints(); } catch { /* fit best-effort */ }
}
if ($('btn-retry')) $('btn-retry').onclick = () => { void retryFailedRun(); inputEl.focus(); };

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
  try {
    const nf = new Intl.NumberFormat(L.tag, { maximumFractionDigits: 1 });
    return ms >= 1000 ? nf.format(ms / 1000) + 's' : Math.round(ms) + 'ms';
  } catch {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  }
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
  agentEventSeen();
  if (ev.type === 'step') {
    // Do-only planning narration: one pending row until tools run (Ask streams via onStream, never here)
    let row = document.querySelector('#agent-steps .plan-row');
    if (row) {
      const tx = row.querySelector('.tx');
      if (tx) tx.textContent = ev.text || 'Working…';
    } else {
      row = addAgentRow('tool',
        iconFor('run') + `<div class="tx">${esc(ev.text || 'Working…')}</div><span class="dur"></span>`);
      row.classList.add('plan-row');
    }
    finalizeSpinners(row.querySelector('.ic'));
  } else if (ev.type === 'tool_call') {
    finalizeSpinners();
    // planning narration is replaced by the N-steps header once tools run
    document.querySelectorAll('#agent-steps .plan-row').forEach((r) => r.remove());
    // Memory lookups are not user-facing steps: no row, no toggle.
    // The "Used N memories" row covers them instead.
    if (ev.tool === 'memory_search') { memSuppressed.add(ev.id); return; }
    // Ask mode is read-only: tag tool names in muted text, never approval cards.
    const askTag = (typeof mode !== 'undefined' && mode === 'chat')
      ? ' <span class="ask-tag">Read-only</span>' : '';
    const row = addAgentRow('tool',
      iconFor('run') + `<div class="tx"><span class="tool-name" title="${esc(ev.tool)}">${esc(toolLabel(ev.tool))}</span>${askTag} ` +
      `<span>${esc(ev.summary || '')}</span>` +
      (ev.afterUntrusted ? `<div class="untrusted-note" style="font-size:12px;color:var(--warn)">Requested after reading ${esc(ev.afterUntrusted)}</div>` : '') +
      `</div><span class="dur"></span>`);
    st.rows.set(ev.id, row);
  } else if (ev.type === 'approval_request') {
    finalizeSpinners();
    let row = st.rows.get(ev.id);
    if (!row) {
      row = addAgentRow('tool',
        iconFor('wait') + `<div class="tx"><span class="tool-name" title="${esc(ev.tool)}">${esc(toolLabel(ev.tool))}</span> ` +
        `<span>${esc(ev.summary || '')}</span></div><span class="dur"></span>`);
      st.rows.set(ev.id, row);
    } else {
      const ic = row.querySelector('.ic');
      if (ic) { ic.classList.remove('spin'); ic.innerHTML = stepSvg(ICO_WAIT); }
    }
    row.appendChild(buildApprovalCard(runId, ev));
    expandSteps(); // a collapsed run would hide the card (collapsed hides .astep)
    if (view !== 'run') showView('run'); // yank to run so Deny/Allow is seen; returnTo untouched
    agentScroll();
  } else if (ev.type === 'tool_result') {
    if (memSuppressed.has(ev.id)) { memSuppressed.delete(ev.id); agentScroll(); return; }
    const row = st.rows.get(ev.id);
    const dur = fmtDur(ev.durationMs);
    // A blocked Ask call shows a failed step with a switch chip, never an approval card.
    if (!ev.ok && typeof ev.output === 'string' && ev.output.includes('MODE_READ_ONLY')) {
      if (row) {
        const ic = row.querySelector('.ic');
        if (ic) { ic.classList.remove('spin'); ic.innerHTML = stepSvg(ICO_FAIL); }
        const tx = row.querySelector('.tx');
        if (tx) {
          tx.innerHTML = '';
          tx.appendChild(document.createTextNode('Blocked: Ask mode is read-only. '));
          tx.appendChild(switchToDoChip(lastAskPrompt));
        }
      } else {
        const r = addAgentRow('tool', iconFor('fail') + '<div class="tx">Blocked: Ask mode is read-only.</div>');
        r.querySelector('.tx').appendChild(switchToDoChip(lastAskPrompt));
      }
      agentScroll();
    } else if (row) {
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
    document.querySelectorAll('#agent-steps .plan-row').forEach((r) => r.remove()); // answer replaces narration
    finalizeSpinners();
    if (!st.answerDiv) st.answerDiv = addMsg('assistant', '');
    st.answerDiv.dataset.raw = (st.answerDiv.dataset.raw || '') + ev.text;
    st.answerDiv.innerHTML = mdLite(st.answerDiv.dataset.raw);
    decorateCode(st.answerDiv);
    agentScroll();
  } else if (ev.type === 'done') {
    // why: remove narration first so a zero-tool run keeps no checkmark, then finalize live rows
    document.querySelectorAll('#agent-steps .plan-row').forEach((r) => r.remove());
    finalizeSpinners();
    if (st.answerDiv) st.answerDiv.classList.remove('streaming');
    collapseSteps();
    clearRunCards(runId);
    endAgentRun();
    // Ask: a zero-tool answer that plausibly wanted action gets the switch row
    // (sibling, never inline); greetings and plain answers never do.
    // Nothing ran in Ask; the Do re-send still needs its normal approvals.
    try {
      if (typeof mode !== 'undefined' && mode === 'chat' && st.answerDiv &&
        st.rows.size === 0 && isActionLike(lastAskPrompt) && st.answerDiv.parentNode) {
        const row = doSwitchRow(lastAskPrompt);
        st.answerDiv.after(row);
        agentScroll();
        requestResize();
      }
    } catch {}
    renderRunChips(runId);
    setRouteStatus(null);
    syncChrome();
    requestResize();
  } else if (ev.type === 'error') {
    document.querySelectorAll('#agent-steps .plan-row').forEach((r) => r.remove());
    finalizeSpinners();
    // why: the Planning row never survives a terminal event; the error row
    // carries Retry + Details instead of a raw string next to a spinner.
    addErrorRow({ message: ev.message, code: ev.code, technical: ev.technical, action: ev.action });
    if (/^agent-/.test(runId || '') && lastUserText) failedRun = { text: lastUserText };
    setRouteStatus(null);
    clearRunCards(runId);
    expandSteps();
    endAgentRun();
  } else if (ev.type === 'stopped') {
    document.querySelectorAll('#agent-steps .plan-row').forEach((r) => r.remove());
    finalizeSpinners();
    addAgentRow('stopped', iconFor('fail') + '<div class="tx">Stopped — nothing is still running.</div>');
    setRouteStatus(null);
    clearRunCards(runId);
    expandSteps();
    endAgentRun();
  }
  syncSteps();
  syncAgentFooter();
  syncChrome();
  requestResize();
}

async function startAgentRun(text, submitOpts) {
  submitOpts = submitOpts || {};
  // Queued or routed submits go through send (task routing + notices);
  // direct foreground runs use agentStart.
  if (submitOpts.queued || submitOpts.taskAction) return void sendAgentViaSend(text, submitOpts);
  const id = await beginRun(text);
  try {
    const claim = typeof window.attachClaimForSend === 'function' ? window.attachClaimForSend() : null;
    const startOpts = { cwd: agentCwd || undefined };
    if (claim && claim.attachments) startOpts.attachments = claim.attachments;
    const startP = window.nexio.agentStart(id, text, startOpts);
    try { if (claim && claim.had && typeof window.attachMarkSent === 'function') window.attachMarkSent(id); } catch { /* noop */ }
    const r = await startP;
    if (!agentState) return;
    agentState.runId = r && r.runId;
  } catch (e) {
    // why: an invoke rejection means no terminal event will ever arrive —
    // resolve the Planning row here or it spins forever next to the error.
    try { document.querySelectorAll('#agent-steps .plan-row, #agent-steps .still-row').forEach((x) => x.remove()); } catch {}
    finalizeSpinners();
    addErrorRow({
      message: (e && e.message) || errText(e),
      code: (e && (e.appCode || e.code)) || undefined,
      technical: (e && e.technical) || undefined,
      action: (e && e.action) || undefined,
    });
    if (lastUserText) failedRun = { text: lastUserText };
    endAgentRun();
  }
}

// Do-mode submit routed through send (queue/spawn/replace + notices).
async function sendAgentViaSend(text, submitOpts) {
  inputEl.value = '';
  hideSuggest();
  hideTaskChoice();
  grow();
  hidePalette();
  startTurn();
  addMsg('user', text);
  showView('run');
  const id = await ensureConv();
  lastUserText = text;
  assistantDiv = addMsg('assistant', '…');
  try {
    const requestId = `r${Date.now()}-${++reqSeq}`;
    lastRequestId = requestId;
    const claim = typeof window.attachClaimForSend === 'function' ? window.attachClaimForSend() : null;
    const opts = { mode, sessionId: id, requestId, explicit: modeExplicitSession };
    if (submitOpts.queued) opts.queued = true;
    if (submitOpts.taskAction) opts.taskAction = submitOpts.taskAction;
    if (submitOpts.priority) opts.priority = submitOpts.priority;
    if (claim && claim.attachments) opts.attachments = claim.attachments;
    const sendP = window.nexio.send(id, text, opts);
    try { if (claim && claim.had && typeof window.attachMarkSent === 'function') window.attachMarkSent(id); } catch { /* noop */ }
    await sendP;
    void refreshTasks();
  } catch (e) {
    assistantDiv.innerHTML = mdLite(errText(e));
    inputEl.value = text; // keep unsent input after failures
    drafts[mode] = text;
    grow();
  }
}

async function beginRun(userText) {
  lastUserText = userText;
  failedRun = null; // a new run supersedes the failed state
  const id = await ensureConv();
  hideSuggest(); // a run is never an empty composer
  agentState = { runId: null, rows: new Map(), answerDiv: null };
  agentEventSeen(); // arm the silence watchdog from submit, not first event
  const oldChips = $('run-chips');
  if (oldChips) oldChips.remove();
  const steps = $('agent-steps');
  if (steps) { steps.innerHTML = ''; steps.classList.remove('hidden'); steps.classList.remove('collapsed'); }
  startTurn();
  addMsg('user', userText);
  assistantDiv = null;
  showView('run');
  if (steps) steps.classList.remove('hidden');
  // why: immediate feedback — the first agent event can lag behind slow
  // pre-loop awaits (memory classify, provider), and a run must never sit
  // silent with only the "You" row. Reused as the step narration row.
  if (steps && !steps.querySelector('.plan-row')) {
    const row = document.createElement('div');
    row.className = 'astep plan-row';
    row.innerHTML = iconFor('run') + '<div class="tx">Planning…</div><span class="dur"></span>';
    steps.appendChild(row);
  }
  syncSteps();
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
  memSuppressed.clear();
  agentStillShown = false;
  agentWatchdogShown = false;
  try { document.querySelectorAll('#agent-steps .still-row').forEach((r) => r.remove()); } catch {}
  syncAgentFooter();
  syncChrome();
  requestResize();
}

// --- failed-run state: a Do failure leaves Retry + Esc-clear in the footer ---
// failedRun is set only for Do agent runs (runId `agent-*`); undo/workflow
// errors render their row but never arm footer Retry for a different prompt.
var failedRun = null; // { text } | null

/** Friendly error row: one-line message, Retry, Details toggle (redacted
 * technical, hidden by default), Open Settings for secret/provider errors. */
function addErrorRow(info) {
  finalizeSpinners();
  const row = addAgentRow('error', iconFor('fail') + `<div class="tx">${esc(info.message || 'Something went wrong.')}</div>`);
  const tx = row.querySelector('.tx');
  if (info.action === 'open-settings') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn-retry';
    open.textContent = 'Open Settings';
    open.onclick = () => { togglePanel('settings'); inputEl.focus(); };
    tx.appendChild(open);
  }
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn-retry';
  retry.textContent = 'Retry';
  retry.onclick = () => { void retryFailedRun(); };
  tx.appendChild(retry);
  if (info.technical) {
    const det = document.createElement('button');
    det.type = 'button';
    det.className = 'show-out';
    det.textContent = 'Details';
    det.setAttribute('aria-expanded', 'false');
    const pre = document.createElement('pre');
    pre.className = 'out hidden';
    pre.textContent = info.technical;
    det.onclick = () => {
      const hidden = pre.classList.toggle('hidden');
      det.textContent = hidden ? 'Details' : 'Hide details';
      det.setAttribute('aria-expanded', String(!hidden));
      agentScroll();
      requestResize();
    };
    tx.appendChild(det);
    tx.appendChild(pre);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'show-out';
    copy.textContent = 'Copy details';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(`${info.message || ''}\n${info.technical || ''}`); }
      catch { try { fallbackCopy(`${info.message || ''}\n${info.technical || ''}`); } catch {} }
    };
    tx.appendChild(copy);
  }
  agentScroll();
  return row;
}

function retryFailedRun() {
  const t = failedRun && failedRun.text;
  stopAgentRun();
  failedRun = null;
  syncAgentFooter();
  if (t) void startAgentRun(t, {});
}

function clearFailedRun() {
  failedRun = null;
  try { document.querySelectorAll('#agent-steps .error-row, #agent-steps .watchdog-row, #agent-steps .still-row, #agent-steps .plan-row').forEach((r) => r.remove()); } catch {}
  syncAgentFooter();
  syncChrome();
  requestResize();
}
// --- run silence watchdog: a live run must never sit quiet ---
// 10 s with no event -> "Still working… [Stop]"; 60 s -> error row with
// [Retry] + [Copy details]. The run stays alive under it: Stop still aborts,
// Retry stops the old run and starts a new one. Never auto-ends: a slow
// provider is not a failure, but silence must always be visible.
var agentLastEventAt = 0;
var agentStillShown = false;
var agentWatchdogShown = false;
var agentWatchTimer = null;
function agentEventSeen() {
  agentLastEventAt = Date.now();
  if (agentStillShown) {
    agentStillShown = false;
    try { document.querySelectorAll('#agent-steps .still-row').forEach((r) => r.remove()); } catch {}
  }
  if (!agentWatchTimer) {
    try { agentWatchTimer = setInterval(checkAgentSilence, 1000); } catch {}
  }
}
function checkAgentSilence() {
  try {
    if (typeof agentState === 'undefined' || !agentState || !agentLastEventAt) return;
    const steps = document.getElementById('agent-steps');
    if (!steps || !document.contains(steps)) return;
    const elapsed = Date.now() - agentLastEventAt;
    if (elapsed > 10000 && !agentStillShown && !agentWatchdogShown) {
      agentStillShown = true;
      const row = document.createElement('div');
      row.className = 'astep still-row';
      row.innerHTML = iconFor('run') + '<div class="tx">Still working…</div>';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-stop-inline';
      btn.textContent = 'Stop';
      btn.setAttribute('aria-label', 'Stop');
      btn.onclick = () => { stopAgentRun(); inputEl.focus(); };
      row.appendChild(btn);
      steps.appendChild(row);
      agentScroll();
      requestResize();
    }
    if (elapsed > 60000 && !agentWatchdogShown) {
      agentWatchdogShown = true;
      const runId = agentState.runId || '(pending)';
      const row = document.createElement('div');
      row.className = 'astep error-row watchdog-row';
      row.innerHTML = iconFor('fail') + '<div class="tx">No response for 60 s. The run may still be going — Retry starts over.</div>';
      const tx = row.querySelector('.tx');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn-retry';
      retry.textContent = 'Retry';
      retry.onclick = () => { stopAgentRun(); if (lastUserText) void startAgentRun(lastUserText, {}); };
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'show-out';
      copy.textContent = 'Copy details';
      copy.onclick = async () => {
        const details = `runId=${runId} foregroundTask=${(typeof foregroundTaskId !== 'undefined' ? foregroundTaskId : '-') || '-'} elapsedMs=${elapsed}`;
        try { await navigator.clipboard.writeText(details); }
        catch { try { fallbackCopy(details); } catch {} }
      };
      tx.appendChild(retry);
      tx.appendChild(copy);
      steps.appendChild(row);
      expandSteps();
      agentScroll();
      requestResize();
    }
  } catch {}
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
    if (!log) { addMsg('assistant', 'No agent logs yet.'); showView('run'); return; }
    const tail = String(log.content || '').slice(-3000);
    addMsg('assistant', `**Latest agent log:** ${log.path}\n\`\`\`\n${tail}\n\`\`\``);
    showView('run');
  } catch (e) {
    addMsg('assistant', errText(e));
    showView('run');
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

function dismissRootConfirm() {
  const old = $('agent-root-confirm');
  if (old) { old.remove(); requestResize(); return true; }
  return false;
}
// Element focused before the add-folder confirm stole focus (usually the
// settings "Add folder" button) — Esc restores it instead of the composer.
var rootConfirmPrior = null;

function rootNotice(text) {
  const ul = $('agent-roots');
  if (!ul) return;
  dismissRootConfirm();
  const li = document.createElement('li');
  li.id = 'agent-root-confirm';
  const span = document.createElement('span');
  span.textContent = text;
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Dismiss';
  ok.onclick = () => { dismissRootConfirm(); };
  li.appendChild(span);
  li.appendChild(ok);
  ul.appendChild(li);
  requestResize();
}

// Inline add-folder confirm: touches only the settings list, so the composer
// draft, scroll position and any running agent are left alone.
function confirmAddRoot(picked) {
  const ul = $('agent-roots');
  if (!ul) return;
  dismissRootConfirm();
  const li = document.createElement('li');
  li.id = 'agent-root-confirm';
  const span = document.createElement('span');
  span.textContent = 'Add ' + picked + ' to allowed folders?';
  span.title = picked;
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = 'Add';
  add.onclick = async () => {
    try {
      const s = await window.nexio.getSettings();
      const next = [...(s.agentAllowedRoots || [])];
      if (!next.includes(picked)) next.push(picked);
      await window.nexio.setSettings({ agentAllowedRoots: next });
      paintAgentRoots(next);
    } catch (err) { rootNotice(errText(err)); return; }
    dismissRootConfirm();
    requestResize();
  };
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { dismissRootConfirm(); };
  li.appendChild(span);
  li.appendChild(add);
  li.appendChild(cancel);
  ul.appendChild(li);
  rootConfirmPrior = document.activeElement;
  add.focus();
  requestResize();
}

// Ask-mode MCP allowlist: per-tool "Allow in Ask mode" toggles, default off.
// Only trusted-server read tools can appear here; the main process re-checks.
async function paintAskMcp(allowed) {
  const ul = $('ask-mcp');
  if (!ul) return;
  ul.innerHTML = '';
  const allow = new Set(allowed || []);
  let defs = [];
  try {
    const data = await window.nexio.ext({ action: 'list' });
    for (const m of (data && data.mcp) || []) {
      for (const t of m.toolDefs || []) defs.push(`mcp__${m.name}__${t.name}`);
    }
  } catch { /* extensions optional */ }
  const known = defs.length ? defs : [...allow];
  const oldNote = document.getElementById('ask-mcp-note');
  if (oldNote) oldNote.remove();
  if (!known.length) {
    const note = document.createElement('div');
    note.className = 'form-note';
    note.id = 'ask-mcp-note';
    note.appendChild(document.createTextNode('No MCP tools known — start a server in '));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'textlink';
    link.textContent = 'Extensions';
    link.setAttribute('aria-label', 'Open Extensions to browse MCP tools');
    link.onclick = () => { try { void openExtensions(); } catch {} };
    note.appendChild(link);
    note.appendChild(document.createTextNode(' to browse them.'));
    ul.after(note);
    return;
  }
  for (const full of known) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'fld check';
    const span = document.createElement('span');
    span.textContent = full;
    span.title = full;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.askmcp = full;
    box.checked = allow.has(full);
    box.setAttribute('aria-label', `Allow ${full} in Ask mode`);
    label.appendChild(span);
    label.appendChild(box);
    li.appendChild(label);
    ul.appendChild(li);
  }
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
    // Memory usage never adopts a run: it renders as a row under the answer.
    if (event.type === 'memory_used') return void renderMemoryUsed(runId, event);
    // Task runs that are not the foreground task never adopt the run view:
    // their events buffer into the Tasks view; the footer badge counts them.
    if (typeof taskEventForBackground === 'function' && taskEventForBackground(runId, event)) return;
    if (!agentState) {
      // Routed act (or undo) with no active run: adopt it so steps/approvals render.
      if (event.type === 'done' || event.type === 'error' || event.type === 'stopped') return;
      agentState = { runId, rows: new Map(), answerDiv: assistantDiv };
      agentEventSeen();
      const steps = $('agent-steps');
      if (steps) steps.classList.remove('hidden');
      showView('run');
      syncAgentFooter();
    }
    if (agentState.runId && agentState.runId !== runId) return;
    if (!agentState.runId) agentState.runId = runId;
    handleAgentEvent(runId, event);
  });
}
if ($('btn-stop')) $('btn-stop').onclick = () => { stopAgentRun(); inputEl.focus(); };
function updateRunChip() {
  const btn = $('btn-runview');
  if (!btn) return;
  const running = typeof agentRunning === 'function' && agentRunning();
  const viewingRun = typeof view !== 'undefined' && view === 'run';
  const recent = hasRun();
  // why: chip DOM (dot + Done | View) is rebuilt only on state change;
  // textContent writes would clobber the child nodes and re-trigger the
  // panel MutationObserver into an infinite loop. Only touch the DOM on change.
  const state = !viewingRun && running ? 'running' : (!viewingRun && recent ? 'done' : null);
  if (!state) {
    if (btn.dataset.rstate) delete btn.dataset.rstate;
    if (!btn.classList.contains('hidden')) btn.classList.add('hidden');
    return;
  }
  if (btn.dataset.rstate !== state) {
    btn.dataset.rstate = state;
    btn.setAttribute('aria-label', state === 'running' ? 'Run in progress. View run' : 'Run finished. View result');
    btn.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'rundot' + (state === 'running' ? ' spin' : '');
    dot.setAttribute('aria-hidden', 'true');
    const main = document.createElement('span');
    main.textContent = state === 'running' ? 'Running' : 'Done';
    const sep = document.createElement('span');
    sep.className = 'runsep';
    sep.setAttribute('aria-hidden', 'true');
    const vw = document.createElement('span');
    vw.textContent = 'View';
    btn.appendChild(dot);
    btn.appendChild(main);
    btn.appendChild(sep);
    btn.appendChild(vw);
  }
  if (btn.classList.contains('hidden')) btn.classList.remove('hidden');
}
if ($('btn-runview')) $('btn-runview').onclick = () => { showView('run'); inputEl.focus(); };
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
    if (next.includes(picked)) return;
    confirmAddRoot(picked);
  } catch (err) { rootNotice(errText(err)); }
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
    $('btn-ext-back').onclick = () => { showView(backTarget()); inputEl.focus(); };
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
  $('btn-ext-back').onclick = () => { showView(backTarget()); inputEl.focus(); };
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
  showView('run');
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
  showView('run');
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
  showView('run');
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
// why: blocked view switches (approval guard) pulse the card so the no-op reads as feedback
function flashApproval() {
  const card = document.querySelector('#agent-steps .appr');
  if (!card) return;
  card.classList.remove('flash');
  void card.offsetWidth; // restart the pulse when guards fire repeatedly
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 900);
}
function collapseSteps() {
  const steps = $('agent-steps');
  if (!steps || steps.querySelector('.appr')) return; // never bury an undecided approval
  steps.classList.add('collapsed');
  syncSteps();
}

function expandSteps() {
  const steps = $('agent-steps');
  if (!steps) return;
  steps.classList.remove('collapsed');
  syncSteps();
}

// why: steps show for any run rows — collapsed with a tool-only N-steps chevron, expanded on failure; no toggle until first tool
function syncSteps() {
  const steps = $('agent-steps');
  if (!steps) return;
  const tools = steps.querySelectorAll('.tool-name').length;
  const rows = steps.querySelectorAll('.astep').length;
  let head = steps.querySelector('.steps-toggle');
  if (!rows) {
    steps.classList.add('hidden');
    if (head) head.remove();
    return;
  }
  steps.classList.remove('hidden');
  if (!tools) {
    if (head) head.remove();
    steps.classList.remove('collapsed');
    return;
  }
  if (!head) {
    head = document.createElement('button');
    head.type = 'button';
    head.className = 'steps-toggle';
    head.onclick = () => {
      steps.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!steps.classList.contains('collapsed')));
      agentScroll();
      requestResize();
    };
    steps.prepend(head);
  }
  head.innerHTML = '<span>' + tools + ' step' + (tools === 1 ? '' : 's') + '</span>' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  head.setAttribute('aria-expanded', String(!steps.classList.contains('collapsed')));
  head.setAttribute('aria-label', tools + ' execution steps — toggle');
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
  const runHost = $('run');
  if (runHost) runHost.appendChild(host);
  else if (steps && steps.parentNode) steps.parentNode.insertBefore(host, steps.nextSibling);
  requestResize();
}

async function startUndoRun(runId) {
  if (agentRunning()) return;
  agentState = { runId: null, rows: new Map(), answerDiv: null };
  const oldChips = $('run-chips');
  if (oldChips) oldChips.remove();
  const steps = $('agent-steps');
  if (steps) { steps.innerHTML = ''; steps.classList.remove('hidden'); steps.classList.remove('collapsed'); }
  showView('run');
  syncSteps();
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
var suggestSeq = 0; // anti-race: stale timers and in-flight awaits drop their render
function hideSuggest() {
  try { suggestSeq = (typeof suggestSeq === 'number' ? suggestSeq : 0) + 1; } catch {}
  clearTimeout(suggestTimer);
  const box = $('suggest');
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); } // unmount so height collapses
  try { if (typeof requestResize === 'function') requestResize(); } catch {}
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
  hideSuggest(); // unmount stale first (bumps suggestSeq)
  if (view !== 'idle' || !isEmptyUI()) return; // idle + fresh composer only
  if (!paletteEl.classList.contains('hidden')) return; // slash palette wins
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(() => void renderSuggest(seq), 1000);
}
async function renderSuggest(seq) {
  if (seq !== suggestSeq) return; // stale timer
  const box = $('suggest');
  if (!box || view !== 'idle' || !isEmptyUI()) return;
  if (!paletteEl.classList.contains('hidden')) return;
  const items = await suggestList();
  if (seq !== suggestSeq) return; // cleared or superseded mid-flight
  if (!items.length || view !== 'idle' || !isEmptyUI() || !paletteEl.classList.contains('hidden')) return;
  box.innerHTML = '';
  for (const text of items.slice(0, 4)) {
    const d = document.createElement('div');
    d.className = 'item';
    d.setAttribute('role', 'option');
    d.innerHTML = `<span>${esc(text)}</span>`;
    d.onclick = () => {
      inputEl.value = text; // fill only — the user sends with Enter
      drafts[mode] = text;
      hideSuggest();
      grow();
      inputEl.focus();
      syncChrome();
    };
    box.appendChild(d);
  }
  if (seq !== suggestSeq) return;
  box.classList.remove('hidden');
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
    return new Date(ts).toLocaleString(L.tag);
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
    li.className = 'runrow' + (r.parentId ? ' runrow-sub' : '');
    const dot = r.status === 'done' ? 'ok' : r.status === 'stopped' ? 'warn' : 'err';
    li.innerHTML = `<span class="dot ${dot}" aria-hidden="true"></span>` +
      `<div class="run-tx"><div class="run-prompt">${r.parentId ? '<span class="task-agent-tag">agent</span> ' : ''}${esc(r.prompt || '')}</div>` +
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

// --- First-run onboarding: one screen (provider + key). Skippable. ---
var OB_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', ph: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', ph: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', label: 'Gemini', ph: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'compatible', label: 'Custom', ph: 'sk-…', keyUrl: null },
];
async function maybeOnboard() {
  try {
    const s = await window.nexio.getSettings();
    if (s.onboarded) return;
    const convs = await window.nexio.listConversations();
    if (convs.length) { await window.nexio.setSettings({ onboarded: true }); return; } // existing install
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
// why: one place for the key-field icons (stroke 1.8 like the footer icons).
function eyeSvg(open) {
  return open
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.2 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.2-1.5"/><line x1="3" y1="3" x2="21" y2="21"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function lockSvg() {
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
}
function checkSvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>';
}
// Test button + result states for the onboarding key field (render only;
// the testConnectivity call itself is unchanged).
function setObTestState(state) {
  const btn = $('ob-test');
  const out = $('ob-test-result');
  const key = $('ob-key');
  if (key) key.closest('.ob-field')?.classList.toggle('error', state === 'error');
  if (!btn || !out) return;
  const wasLoading = btn.dataset.state === 'loading';
  btn.dataset.state = state;
  if (state === 'idle' && wasLoading) { btn.dataset.state = 'loading'; return; }
  if (state === 'loading') {
    btn.disabled = true;
    out.innerHTML = '';
    const spin = document.createElement('span');
    spin.className = 'ob-spin';
    spin.setAttribute('aria-hidden', 'true');
    out.appendChild(spin);
    out.appendChild(document.createTextNode(t('onboard.testing')));
  } else if (state === 'success') {
    btn.disabled = !(key && key.value.trim());
    btn.textContent = t('onboard.test');
    out.innerHTML = '';
    const ic = document.createElement('span');
    ic.className = 'ok';
    ic.innerHTML = checkSvg();
    ic.setAttribute('aria-hidden', 'true');
    out.appendChild(ic);
    out.appendChild(document.createTextNode(t('onboard.keyValid')));
    say(t('onboard.keyValid'));
  } else if (state === 'error') {
    btn.disabled = !(key && key.value.trim());
    btn.textContent = t('onboard.test');
    out.textContent = t('onboard.keyInvalid');
    say(t('onboard.keyInvalid'));
  } else {
    btn.disabled = !(key && key.value.trim());
    btn.textContent = t('onboard.test');
    out.innerHTML = '';
    const lock = document.createElement('span');
    lock.className = 'ob-secure';
    lock.innerHTML = lockSvg();
    lock.appendChild(document.createTextNode(t('onboard.encryptedNote')));
    out.appendChild(lock);
  }
}
function renderOnboard() {
  const box = $('onboard');
  if (!box) return;
  {
    box.innerHTML =
      `<div class="ob-title"><h3>${esc(t('onboard.title'))}</h3><p>${esc(t('onboard.subtitle'))}</p></div>` +
      `<div class="fld"><span class="flab">Provider</span><div class="seg" id="ob-prov" role="group" aria-label="Provider">` +
      OB_PROVIDERS.map((p) => `<button type="button" data-prov="${p.id}">${esc(p.label)}</button>`).join('') +
      `</div></div>` +
      `<div class="fld ob-key-group"><label class="ob-label" for="ob-key">${esc(t('onboard.apiKey'))}</label>` +
      `<div class="ob-field">` +
      `<input id="ob-key" type="password" placeholder="sk-…" class="mono" aria-describedby="ob-key-help" autocomplete="off" spellcheck="false" />` +
      `<span class="ob-div" aria-hidden="true"></span>` +
      `<button id="ob-eye" type="button" class="ob-eye" aria-label="${esc(t('onboard.showKey'))}" aria-pressed="false">${eyeSvg(false)}</button>` +
      `<button id="ob-test" type="button" class="ob-test" disabled>${esc(t('onboard.test'))}</button>` +
      `</div>` +
      `<div class="ob-help" id="ob-key-help"><span id="ob-test-result" role="status" aria-live="polite"></span><a class="ob-key-link" id="ob-key-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">${esc(t('onboard.getKey'))}</a></div>` +
      `</div>` +
      `<div class="row ob-actions"><button id="ob-skip-inline" type="button" class="ob-skip">${esc(t('onboard.skip'))}</button><button id="ob-next" type="button" class="btn-primary ob-continue" disabled>${esc(t('onboard.continue'))}<span aria-hidden="true"> →</span></button></div>`;
    let prov = 'openai';
    const paintProv = () => {
      box.querySelectorAll('#ob-prov button').forEach((b) => b.classList.toggle('on', b.dataset.prov === prov));
      const meta = OB_PROVIDERS.find((p) => p.id === prov) || OB_PROVIDERS[0];
      const key = $('ob-key');
      if (key) { key.placeholder = meta.ph; setObTestState('idle'); }
      const link = $('ob-key-link');
      if (link) {
        if (meta.keyUrl) { link.href = meta.keyUrl; link.classList.remove('hidden'); }
        else link.classList.add('hidden');
      }
    };
    box.querySelectorAll('#ob-prov button').forEach((b) => { b.onclick = () => { prov = b.dataset.prov; paintProv(); }; });
    const eye = $('ob-eye');
    if (eye) eye.onclick = () => {
      const key = $('ob-key');
      if (!key) return;
      const show = key.type === 'password';
      key.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? t('onboard.hideKey') : t('onboard.showKey'));
      eye.innerHTML = eyeSvg(show);
      try { key.focus(); } catch {}
    };
    const keyInput = $('ob-key');
    if (keyInput) {
      keyInput.addEventListener('input', () => {
        const empty = !keyInput.value.trim();
        const test = $('ob-test');
        if (test && test.dataset.state !== 'loading') test.disabled = empty;
        if (test && test.dataset.state === 'error') setObTestState('idle');
        const next = $('ob-next');
        if (next) next.disabled = empty;
      });
      // why: Enter submits when Continue is enabled; Esc keeps the popup-level behavior (no local handling).
      keyInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        const next = $('ob-next');
        if (next && !next.disabled) next.click();
      });
    }
    paintProv();
    $('ob-test').onclick = async () => {
      const btn = $('ob-test');
      if (btn.disabled) return;
      setObTestState('loading');
      try {
        // (provider, model, baseUrl, key): the stored model fills the missing input.
        let obModel = '';
        try { obModel = (await window.nexio.getSettings()).model || ''; } catch {}
        const r = await window.nexio.testConnectivity(prov, obModel, undefined, $('ob-key').value.trim() || undefined);
        setObTestState(r.ok ? 'success' : 'error');
      } catch (e) { setObTestState('error'); }
    };
    $('ob-next').onclick = async () => {
      if ($('ob-next').disabled) return;
      try {
        await window.nexio.setSettings({ provider: prov });
        { const k = $('ob-key').value.trim(); if (k) await window.nexio.setApiKey(prov, k); }
      } catch (e) { setObTestState('error'); return; }
      await skipOnboard();
    };
    const skipInline = $('ob-skip-inline');
    if (skipInline) skipInline.onclick = () => void skipOnboard();
  }
  syncChrome(); requestResize();
}
/* --- Memory (appended): Memory view, settings section, run-view rows --- */
var lastRequestId = '';
var memSuppressed = new Set(); // memory_search call ids: never step rows
// Human step labels for real file/system tools (raw name stays in title).
var TOOL_LABELS = {
  fs_read: 'Read file', fs_write: 'Write file', fs_list: 'List files', fs_search: 'Searched files',
  fs_move: 'Moved file', fs_copy: 'Copied file', fs_trash: 'Trashed file', shell_run: 'Ran command',
  app_open: 'Opened app', apps_list: 'Listed apps', clipboard_read: 'Read clipboard', clipboard_write: 'Wrote clipboard',
  web_search: 'Searched web', web_fetch: 'Fetched page', attachment_list: 'Listed attachments',
  attachment_read: 'Read attachment', skill_load: 'Loaded skill',
};
function toolLabel(t) {
  if (!t) return '';
  if (t.indexOf('mcp__') === 0) return tr('tool.mcp', { server: t.split('__')[1] || 'MCP' }, 'Used ' + (t.split('__')[1] || 'MCP') + ' tool');
  if (t.indexOf('memory_') === 0) return tr('tool.memory', null, 'Checked memory');
  return tr('tool.' + t, null, TOOL_LABELS[t] || t);
}
var memTab = 'all', memQuery = '', memEditId = null, memFormMode = null; // memFormMode: null | 'add'
var incognitoOn = false;
var pendingMemPushes = [];

function say(m) { try { const el = document.getElementById('attach-live'); if (el) el.textContent = m; } catch {} }
function memCall(a) { return window.nexio.memory(a); }
function memKindLabel(k) {
  return { preference: t('memory.preferences'), fact: t('memory.facts'), folder_rule: t('memory.folders'), procedure: t('memory.procedures'), episode: t('memory.episodes') }[k] || k;
}
function memScopeLabel(sc) {
  if (!sc || sc.type === 'global') return 'global';
  if (sc.type === 'folder') return sc.path;
  if (sc.type === 'app') return 'app:' + sc.name;
  return 'project:' + sc.id;
}
function memScopeIsFolder(sc) { return !!sc && sc.type === 'folder'; }
function memTimeAgo(ts) {
  if (!ts) return t('memory.never');
  try {
    const d = Date.now() - ts;
    const rtf = new Intl.RelativeTimeFormat(L.tag, { numeric: 'auto' });
    if (d < 3600e3) return rtf.format(-Math.max(1, Math.round(d / 60e3)), 'minute');
    if (d < 86400e3) return rtf.format(-Math.round(d / 3600e3), 'hour');
    return rtf.format(-Math.round(d / 86400e3), 'day');
  } catch {
    return t('memory.never');
  }
}
// why: no English word lists; the /remember fallback kinds by structure only
// (explicit absolute path -> folder_rule, else fact). Packs + classifier own
// kinds everywhere else; the user can re-kind in the Memory view.
function guessKindLocal(t) {
  const s = String(t || '');
  if (/[A-Za-z]:[\\/][^\s"'“”]+/.test(s)) return 'folder_rule';
  const m = s.match(/\/[^\s"'“”]+/g) || [];
  if (m.some((p) => (p.match(/\//g) || []).length >= 2)) return 'folder_rule';
  return 'fact';
}
function parseScopeLocal(s) {
  const t = String(s || '').trim();
  if (!t || t === 'global') return { type: 'global' };
  let m = /^app:(.+)$/.exec(t);
  if (m) return { type: 'app', name: m[1].trim() };
  m = /^project:(.+)$/.exec(t);
  if (m) return { type: 'project', id: m[1].trim() };
  m = /^(?:folder:)?([A-Za-z]:[\\/].+|\/.+)$/.exec(t);
  if (m) return { type: 'folder', path: m[1].trim() };
  return null;
}
function ghostBtn(label, aria) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'switch-do-chip'; // quiet ghost button, 12px
  b.textContent = label;
  if (aria) b.setAttribute('aria-label', aria);
  return b;
}

async function openMemoryView(editId) {
  memEditId = editId || null;
  memFormMode = null;
  showView('memory');
  await renderMemoryView();
  await memPrivacyNotice();
}
function memTabsPaint() {
  document.querySelectorAll('.mem-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mk === memTab));
}
async function renderMemoryView() {
  memTabsPaint();
  const ul = $('mem-list');
  const empty = $('mem-empty');
  const form = $('mem-form');
  if (!ul) return;
  ul.innerHTML = '';
  if (form) { form.innerHTML = ''; form.classList.add('hidden'); }
  let rows = [];
  try {
    rows = await memCall({ action: 'list', ...(memTab !== 'all' ? { kind: memTab } : {}), ...(memQuery ? { q: memQuery } : {}) });
  } catch (e) {
    ul.innerHTML = `<li><span>${esc(errText(e))}</span></li>`;
    return;
  }
  // review list: stale items first
  const stale = rows.filter((r) => r.stale);
  const fresh = rows.filter((r) => !r.stale);
  const rev = $('mem-review');
  if (rev) {
    rev.classList.toggle('hidden', !stale.length);
    rev.innerHTML = stale.length ? `<span>${esc(t('memory.review', { count: stale.length }))}</span>` : '';
  }
  const ordered = [...stale, ...fresh];
  if (empty) empty.classList.toggle('hidden', ordered.length > 0);
  for (const r of ordered) ul.appendChild(memRow(r));
  if (memEditId) {
    const row = rows.find((x) => x.id === memEditId);
    if (row) renderMemForm(row);
    memEditId = null;
  } else if (memFormMode === 'add') renderMemForm(null);
  syncChrome(); requestResize();
}
function memRow(r) {
  const li = document.createElement('li');
  li.className = 'mem-row';
  li.dataset.mid = r.id;
  const tx = document.createElement('div');
  tx.className = 'mem-tx';
  const main = document.createElement('div');
  main.className = 'mem-text';
  main.textContent = r.text;
  tx.appendChild(main);
  const meta = document.createElement('div');
  meta.className = 'mem-meta';
  meta.textContent = `${memKindLabel(r.kind)} · ${memScopeLabel(r.scope)} · ${memTimeAgo(r.lastUsedAt)}${r.useCount ? ` · ×${new Intl.NumberFormat(L.tag).format(r.useCount)}` : ''}${r.stale ? ` · ${t('memory.stale')}` : ''}`;
  if (memScopeIsFolder(r.scope)) {
    const chip = document.createElement('code');
    chip.className = 'scope-chip';
    chip.textContent = r.scope.path;
    chip.title = r.scope.path;
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(chip);
  }
  if (r.enforced) {
    const b = document.createElement('span');
    b.className = 'enforced-badge';
    b.textContent = t('memory.enforced');
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(b);
  }
  tx.appendChild(meta);
  li.appendChild(tx);
  const pin = ghostBtn(r.pinned ? t('memory.unpinBtn') : t('memory.pinBtn'), (r.pinned ? t('memory.unpinBtn') : t('memory.pinBtn')) + ' ' + r.text.slice(0, 60));
  pin.onclick = async () => {
    try {
      await memCall({ action: 'update', id: r.id, text: r.text, pinned: !r.pinned });
      await renderMemoryView();
    } catch (e) { say(errText(e)); }
  };
  li.appendChild(pin);
  const menuBtn = ghostBtn('…', t('memory.options'));
  const menu = document.createElement('div');
  menu.className = 'mem-menu hidden';
  for (const [label, fn] of [
    [t('memory.edit'), () => renderMemForm(r)],
    [t('memory.forget'), async () => { try { await memCall({ action: 'forget', id: r.id }); say(t('memory.forgot')); await renderMemoryView(); } catch (e) { say(errText(e)); } }],
  ]) {
    const b = ghostBtn(label, `${label} ${r.text.slice(0, 60)}`);
    b.onclick = () => { menu.classList.add('hidden'); fn(); };
    menu.appendChild(b);
  }
  menuBtn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
  li.appendChild(menuBtn);
  li.appendChild(menu);
  li.onclick = (e) => {
    if (e.target.closest('button') || e.target.closest('.mem-menu')) return; // pin/menu own their clicks
    if (e.target === li || e.target === main) renderMemForm(r);
  };
  return li;
}
function renderMemForm(row) {
  const form = $('mem-form');
  if (!form) return;
  form.classList.remove('hidden');
  const kinds = ['preference', 'fact', 'folder_rule', 'procedure', 'episode'];
  form.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'mono';
  ta.rows = 3;
  ta.value = row ? row.text : '';
  ta.setAttribute('aria-label', t('memory.textLabel'));
  form.appendChild(ta);
  const seg = document.createElement('div');
  seg.className = 'seg mem-kind-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('memory.kind'));
  let kind = row ? row.kind : 'fact';
  for (const k of kinds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = memKindLabel(k);
    b.classList.toggle('on', k === kind);
    b.onclick = () => { kind = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    seg.appendChild(b);
  }
  form.appendChild(seg);
  const sc = document.createElement('input');
  sc.className = 'mono';
  sc.value = row ? memScopeLabel(row.scope) : 'global';
  sc.setAttribute('aria-label', t('memory.scopePh'));
  form.appendChild(sc);
  const pinRow = document.createElement('label');
  pinRow.className = 'fld check';
  pinRow.innerHTML = '<span class="switch-tx"><span class="flab">' + esc(t('memory.pin')) + '</span></span>';
  const pinBox = document.createElement('input');
  pinBox.type = 'checkbox';
  pinBox.checked = row ? !!row.pinned : false;
  pinRow.appendChild(pinBox);
  form.appendChild(pinRow);
  const status = document.createElement('div');
  status.className = 'note';
  status.setAttribute('role', 'status');
  form.appendChild(status);
  const rowBtns = document.createElement('div');
  rowBtns.className = 'row';
  const saveB = document.createElement('button');
  saveB.type = 'button';
  saveB.className = 'btn-primary';
  saveB.textContent = t('memory.save');
  saveB.onclick = async () => {
    const scope = parseScopeLocal(sc.value);
    if (!scope) { status.textContent = t('memory.scopeError'); return; }
    try {
      const r = await memCall({ action: 'save', kind, text: ta.value, scope, pinned: pinBox.checked, ...(row ? { replaceId: row.id } : {}) });
      if (r.status === 'saved' || r.status === 'updated') { memFormMode = null; say(t('memory.savedSr')); await renderMemoryView(); }
      else if (r.status === 'conflict') { renderConflictRow(ta.value, r.conflicts, { kind, scope, pinned: pinBox.checked }, status); }
      else if (r.status === 'full') status.textContent = t('memory.full');
      else status.textContent = t('memory.notSaved', { reason: r.reason || 'blocked' });
    } catch (e) { status.textContent = errText(e); }
  };
  const cancelB = document.createElement('button');
  cancelB.type = 'button';
  cancelB.className = 'btn';
  cancelB.textContent = t('memory.cancel');
  cancelB.onclick = () => { memFormMode = null; form.classList.add('hidden'); };
  rowBtns.appendChild(saveB);
  rowBtns.appendChild(cancelB);
  form.appendChild(rowBtns);
  ta.focus();
  syncChrome(); requestResize();
}
async function memPrivacyNotice() {
  try {
    const box = $('mem-notice');
    if (!box) return;
    const s = await window.nexio.getSettings();
    if ((s.memoryNoticeDismissed || {})[s.provider]) { box.classList.add('hidden'); return; }
    const local = isLocalProviderName(s.provider, s.baseUrl);
    box.classList.remove('hidden');
    box.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = local
      ? 'Nexio keeps these notes on this computer.'
      : `Nexio keeps these notes on this computer. When relevant, they are sent to ${providerDisplay(s.provider)} with your request.`;
    const b = ghostBtn('Got it', 'Dismiss memory privacy notice');
    b.onclick = async () => {
      try {
        const cur = await window.nexio.getSettings();
        await window.nexio.setSettings({ memoryNoticeDismissed: { ...(cur.memoryNoticeDismissed || {}), [cur.provider]: true } });
      } catch {}
      box.classList.add('hidden');
    };
    box.appendChild(span);
    box.appendChild(b);
  } catch { /* notice never blocks */ }
}
function isLocalProviderName(provider, baseUrl) {
  try {
    if (provider !== 'compatible') return false;
    const host = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch { return false; }
}
function providerDisplay(p) { return { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', compatible: 'Custom' }[p] || p; }

// --- run-view rows (Remembered / suggestions / conflicts / Used N) ---
function memoryHost(ev) {
  if (ev && ev.runId && agentState && agentState.runId === ev.runId && agentState.answerDiv && document.contains(agentState.answerDiv)) return agentState.answerDiv;
  if (ev && ev.requestId && ev.requestId === lastRequestId && assistantDiv && document.contains(assistantDiv)) return assistantDiv;
  if (assistantDiv && document.contains(assistantDiv) && (view === 'run' || view === 'idle')) return assistantDiv;
  const divs = messagesEl.querySelectorAll('.msg.assistant');
  if (divs.length) return divs[divs.length - 1];
  return null;
}
function memConfirmRow(msg, buttons) {
  const div = document.createElement('div');
  div.className = 'mem-confirm';
  const span = document.createElement('span');
  span.textContent = msg;
  div.appendChild(span);
  for (const b of buttons || []) div.appendChild(b);
  const link = ghostBtn(t('memory.title'), t('memory.openView'));
  link.onclick = () => void openMemoryView();
  div.appendChild(link);
  return div;
}
function renderRememberedRow(mem, status) {
  const host = memoryHost(null);
  if (!host) { pendingMemPushes.push({ event: { type: 'saved', id: mem.id, kind: mem.kind, text: mem.text } }); return; }
  const undo = ghostBtn(t('memory.undo'), t('memory.forget'));
  undo.onclick = async () => { try { await memCall({ action: 'forget', id: mem.id }); say(t('memory.forgot')); row.remove(); } catch (e) { say(errText(e)); } };
  const edit = ghostBtn(t('memory.edit'), t('memory.edit'));
  edit.onclick = () => void openMemoryView(mem.id);
  const row = memConfirmRow(status === 'updated' ? t('memory.updated', { text: mem.text }) : t('memory.remembered', { text: mem.text }), [undo, edit]);
  host.appendChild(row);
  say(t('memory.savedSr'));
  syncChrome(); requestResize();
}
function renderConflictRow(newText, conflicts, saveCtx, host) {
  const old = conflicts[0] || { id: '', text: '' };
  const replace = ghostBtn(t('memory.replace'), t('memory.replacePrompt'));
  replace.onclick = async () => {
    try {
      await memCall({ action: 'save', kind: (saveCtx && saveCtx.kind) || 'fact', text: newText, scope: (saveCtx && saveCtx.scope) || { type: 'global' }, ...(saveCtx && saveCtx.pinned ? { pinned: true } : {}), replaceId: old.id });
      say(t('memory.replaced'));
      row.remove();
      if (view === 'memory') await renderMemoryView();
    } catch (e) { say(errText(e)); }
  };
  const cancel = ghostBtn(t('memory.keepOld'), t('memory.keepOld'));
  cancel.onclick = () => row.remove();
  const row = memConfirmRow(t('memory.replacePrompt'), [replace, cancel]);
  const ul = document.createElement('ul');
  ul.className = 'agent-list';
  for (const txt of [old.text, newText]) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = txt;
    li.appendChild(span);
    ul.appendChild(li);
  }
  row.appendChild(ul);
  const hostEl = host || memoryHost(null);
  if (!hostEl) { pendingMemPushes.push({ event: { type: 'conflict', text: newText, conflicts } }); return; }
  hostEl.appendChild(row);
  say(t('memory.conflictSr'));
  syncChrome(); requestResize();
}
function renderSuggestRow(candidates) {
  const host = memoryHost(null);
  if (!host) {
    for (const c of candidates) pendingMemPushes.push({ event: { type: 'suggest', candidates: [c] } });
    return;
  }
  for (const c of candidates) {
    const save = ghostBtn(t('memory.saveBtn'), t('memory.askSave', { text: c.text.slice(0, 60) }));
    save.onclick = async () => {
      try {
        const r = await memCall({ action: 'save', kind: c.kind || 'fact', text: c.text });
        if (r.status === 'saved' || r.status === 'updated') { say(t('memory.savedSr')); row.remove(); if (view === 'memory') await renderMemoryView(); }
        else if (r.status === 'conflict') { row.remove(); renderConflictRow(c.text, r.conflicts, { kind: c.kind || 'fact' }); }
        else { say(t('memory.notSaved', { reason: r.reason || 'blocked' })); }
      } catch (e) { say(errText(e)); }
    };
    const dismiss = ghostBtn(t('memory.dismiss'), t('memory.dismiss'));
    dismiss.onclick = async () => { try { await memCall({ action: 'dismiss', hash: c.hash }); } catch {} row.remove(); };
    const row = memConfirmRow(t('memory.askSave', { text: c.text }), [save, dismiss]);
    host.appendChild(row);
  }
  say(t('memory.suggestCount', { count: candidates.length }));
  syncChrome(); requestResize();
}
function renderOneTapRow(ev) {
  const host = memoryHost(null);
  if (!host) { pendingMemPushes.push({ event: ev }); return; }
  const save = ghostBtn(t('memory.saveBtn'), t('memory.askSave', { text: ev.text.slice(0, 60) }));
  save.onclick = async () => {
    try {
      const cur = await window.nexio.getSettings();
      if (!cur.memoryEnabled) {
        // Memory is off: inline turn-on prompt, no view switch.
        row.innerHTML = '';
        const span = document.createElement('span');
        span.textContent = t('memory.turnOnAsk');
        const on = ghostBtn(t('memory.turnOn'), t('memory.turnOnAsk'));
        on.onclick = async () => {
          try {
            const s2 = await window.nexio.getSettings();
            await window.nexio.setSettings({
              memoryEnabled: true,
              memoryKinds: { ...(s2.memoryKinds || {}), [ev.kind]: true },
            });
            await doOneTapSave(row, ev);
          } catch (e) { say(errText(e)); }
        };
        const cancel = ghostBtn(t('memory.cancel'), t('memory.cancel'));
        cancel.onclick = () => row.remove();
        row.appendChild(span);
        row.appendChild(on);
        row.appendChild(cancel);
        syncChrome(); requestResize();
        return;
      }
      await doOneTapSave(row, ev);
    } catch (e) { say(errText(e)); }
  };
  const notnow = ghostBtn(t('memory.notNow'), t('memory.notNow'));
  notnow.onclick = async () => { try { await memCall({ action: 'dismiss', hash: ev.hash }); } catch {} row.remove(); };
  const row = memConfirmRow(t('memory.askSave', { text: ev.text }), [save, notnow]);
  host.appendChild(row);
  say(t('memory.suggestedSr'));
  syncChrome(); requestResize();
}
async function doOneTapSave(row, ev) {
  try {
    const r = await memCall({ action: 'save', kind: ev.kind, text: ev.text, pinned: !!ev.pin, ...(ev.lang ? { lang: ev.lang } : {}) });
    if (r.status === 'saved' || r.status === 'updated') {
      row.remove();
      renderRememberedRow(r.memory, r.status);
      if (view === 'memory') await renderMemoryView();
    } else if (r.status === 'conflict') {
      row.remove();
      renderConflictRow(ev.text, r.conflicts, { kind: ev.kind });
    } else if (r.status === 'full') {
      say(t('memory.full'));
    } else {
      say(t('memory.notSaved', { reason: r.reason || 'blocked' }));
    }
  } catch (e) { say(errText(e)); }
}
async function renderMemoryPush({ runId, requestId, event }) {
  const host = memoryHost({ runId, requestId });
  if (!host) { pendingMemPushes.push({ event }); return; }
  if (event.type === 'saved') renderRememberedRow({ id: event.id, kind: event.kind, text: event.text }, 'saved');
  else if (event.type === 'onetap') renderOneTapRow(event);
  else if (event.type === 'suggest') renderSuggestRow(event.candidates || []);
  else if (event.type === 'conflict') renderConflictRow(event.text, event.conflicts || [], null);
  else if (event.type === 'blocked') {
    const row = memConfirmRow(t('memory.notSaved', { reason: event.reason }), []);
    host.appendChild(row);
    say(t('memory.notSaved', { reason: event.reason }));
    syncChrome(); requestResize();
  }
}
function flushMemPushes() {
  if (!pendingMemPushes.length) return;
  const q = pendingMemPushes;
  pendingMemPushes = [];
  for (const p of q) void renderMemoryPush(p);
}
async function renderMemoryUsed(runId, ev) {
  agentEventSeen(); // memory activity resets the silence watchdog too
  const host = (agentState && agentState.runId === runId && agentState.answerDiv && document.contains(agentState.answerDiv))
    ? agentState.answerDiv
    : memoryHost({ runId });
  if (!host) return;
  if (host.querySelector(`[data-memused="${ev.ids.join(',')}"]`)) return;
  const wrap = document.createElement('div');
  wrap.className = 'mem-used';
  wrap.dataset.memused = ev.ids.join(',');
  const toggle = ghostBtn(ev.count === 1 ? t('memory.usedOne') : t('memory.used', { count: ev.count }), t('memory.showUsed'));
  const list = document.createElement('div');
  list.className = 'hidden';
  toggle.onclick = async () => {
    const open = list.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!open));
    if (!open || list.children.length) return;
    for (const id of ev.ids) {
      try {
        const m = await memCall({ action: 'get', id });
        const line = document.createElement('div');
        line.className = 'mem-used-line';
        const span = document.createElement('span');
        span.textContent = m.text;
        line.appendChild(span);
        const f = ghostBtn(t('memory.forget'), t('memory.forget'));
        f.onclick = async () => { try { await memCall({ action: 'forget', id }); say(t('memory.forgot')); line.remove(); } catch (e) { say(errText(e)); } };
        line.appendChild(f);
        list.appendChild(line);
      } catch { /* dropped memory */ }
    }
    syncChrome(); requestResize();
  };
  wrap.appendChild(toggle);
  wrap.appendChild(list);
  host.appendChild(wrap);
  syncChrome(); requestResize();
}
if (window.nexio && typeof window.nexio.onMemoryEvent === 'function') {
  window.nexio.onMemoryEvent((ev) => { void renderMemoryPush(ev); });
}

// --- slash commands ---
async function runRememberCommand(arg) {
  const t = (arg || '').trim();
  addMsg('user', `/remember ${t}`);
  showView('run');
  if (!t) { addMsg('assistant', t('slash.usageRemember')); return; }
  try {
    let scope = { type: 'global' };
    let kind = guessKindLocal(t);
    if (kind === 'folder_rule') {
      const m = t.match(/[A-Za-z]:[\\/][^\s]+|(\/[^\s]+)/);
      const cand = m && m[0];
      if (cand && (/^[A-Za-z]:[\\/]/.test(cand) || (cand.match(/\//g) || []).length >= 2)) scope = { type: 'folder', path: cand };
    }
    const r = await memCall({ action: 'save', kind, text: t, scope });
    if (r.status === 'saved' || r.status === 'updated') renderRememberedRow(r.memory, r.status);
    else if (r.status === 'conflict') renderConflictRow(t, r.conflicts, { kind, scope });
    else if (r.status === 'full') addMsg('assistant', t('memory.full'));
    else addMsg('assistant', t('memory.notSaved', { reason: r.reason || 'blocked' }));
  } catch (e) { addMsg('assistant', errText(e)); }
}
async function runForgetCommand(arg) {
  const q = (arg || '').trim();
  addMsg('user', `/forget ${q}`);
  showView('run');
  if (!q) { addMsg('assistant', t('slash.usageForget')); return; }
  try {
    const found = await memCall({ action: 'search', q, limit: 20 });
    if (!found.length) { addMsg('assistant', t('memory.noMatch', { q })); return; }
    const card = document.createElement('div');
    card.className = 'mem-confirm';
    const title = document.createElement('span');
    title.textContent = t('memory.forgetTitle', { count: found.length });
    card.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'agent-list';
    for (const m of found.slice(0, 10)) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = m.text;
      li.appendChild(span);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    const go = ghostBtn(t('memory.forgetAllBtn', { count: found.length }), t('memory.showUsed'));
    go.onclick = async () => {
      try {
        for (const m of found) await memCall({ action: 'forget', id: m.id });
        say(t('memory.forgot'));
        card.remove();
        if (view === 'memory') await renderMemoryView();
      } catch (e) { say(errText(e)); }
    };
    const cancel = ghostBtn(t('memory.cancel'), t('memory.keepOld'));
    cancel.onclick = () => card.remove();
    card.appendChild(go);
    card.appendChild(cancel);
    const host = memoryHost(null) || addMsg('assistant', '');
    host.appendChild(card);
    syncChrome(); requestResize();
  } catch (e) { addMsg('assistant', errText(e)); }
}
async function runIncognitoCommand() {
  try {
    const s = await window.nexio.getSettings();
    const next = !s.incognito;
    await window.nexio.setSettings({ incognito: next });
    incognitoOn = next;
    paintIncognito();
    addMsg('assistant', next ? 'Incognito on: no history, no memory reads or writes.' : 'Incognito off.');
    showView('run');
    say(next ? 'Incognito on' : 'Incognito off');
  } catch (e) { addMsg('assistant', errText(e)); }
}
function paintIncognito() {
  const b = $('incog-badge');
  if (!b) return;
  const show = !incognitoOn;
  if (b.classList.contains('hidden') !== show) return; // no DOM churn on the hot path
  b.classList.toggle('hidden', show);
}
async function refreshIncognito() {
  try {
    const s = await window.nexio.getSettings();
    incognitoOn = s.incognito === true;
    paintIncognito();
  } catch { /* badge stays hidden */ }
}
void refreshIncognito();

// --- settings: Memory section ---
function paintMemKinds(kinds, enabled) {
  const host = $('set-mem-kinds');
  if (!host) return;
  host.innerHTML = '';
  host.setAttribute('aria-disabled', String(enabled === false));
  const labels = { preference: t('memory.preferences'), fact: t('memory.facts'), folder_rule: t('memory.folders'), procedure: t('memory.procedures'), episode: t('memory.episodes') };
  for (const k of ['preference', 'fact', 'folder_rule', 'procedure', 'episode']) {
    const lab = document.createElement('label');
    lab.className = 'chip-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.memkind = k;
    box.checked = !kinds || kinds[k] !== false;
    box.disabled = enabled === false;
    try { box.setAttribute('aria-label', (labels[k] || k).toLocaleLowerCase(L.tag)); } catch { box.setAttribute('aria-label', labels[k] || k); }
    const tx = document.createElement('span');
    tx.className = 'chip-tx';
    tx.innerHTML = '<svg class="chip-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>';
    const name = document.createElement('span');
    name.textContent = labels[k] || k;
    tx.appendChild(name);
    lab.appendChild(box);
    lab.appendChild(tx);
    host.appendChild(lab);
  }
}
async function refreshMemInfo() {
  const el = $('mem-info');
  if (!el) return;
  try {
    const info = await memCall({ action: 'info' });
    const s = await window.nexio.getSettings();
    const status = !s.memoryEnabled ? 'Off' : s.memoryOneTap === false ? 'On: only when I say remember' : 'On: asks before saving';
    el.textContent = `${status} · ${info.count} memories · ${info.bytes >= 1024 ? (info.bytes / 1024).toFixed(1) + ' KB' : info.bytes + ' B'} · ${info.encrypted ? 'encrypted' : 'not encrypted — enable device encryption'}${info.stale ? ` · ${info.stale} to review` : ''}`;
    const desc = $('set-mem-semdesc');
    if (desc) desc.textContent = 'Off: keyword search only. On: still keyword search (embeddings not wired yet).';
  } catch { el.textContent = 'Memory unavailable.'; }
}
if ($('btn-mem-open')) $('btn-mem-open').onclick = () => void openMemoryView();
if ($('btn-mem-export')) $('btn-mem-export').onclick = async () => {
  try {
    const r = await memCall({ action: 'export' });
    copyText(r.json);
    const el = $('mem-info');
    if (el) el.textContent = `Exported ${r.count} memories (copied JSON, no embeddings).`;
    say(`Exported ${r.count} memories to clipboard`);
  } catch (e) { say(errText(e)); }
};
if ($('btn-mem-forgetall')) $('btn-mem-forgetall').onclick = () => { const c = $('mem-forgetall-confirm'); if (c) c.classList.toggle('hidden'); };
if ($('btn-mem-forgetall-go')) $('btn-mem-forgetall-go').onclick = async () => {
  const inp = $('mem-forgetall-input');
  try {
    const r = await memCall({ action: 'forgetAll', confirm: inp ? inp.value.trim() : '' });
    if (r.deleted) { say('Forgot everything'); if (inp) inp.value = ''; void refreshMemInfo(); if (view === 'memory') await renderMemoryView(); }
    else say('Type "forget everything" to confirm');
  } catch (e) { say(errText(e)); }
};
if ($('btn-mem-preview')) $('btn-mem-preview').onclick = async () => {
  const ta = $('mem-import-text');
  const st = $('mem-import-status');
  try {
    const r = await memCall({ action: 'import', json: ta ? ta.value : '', dry: true });
    if (st) st.textContent = `Preview: ${r.imported} new, ${r.updated} updates, ${r.skipped} skipped${r.errors.length ? ' — ' + r.errors.slice(0, 3).join('; ') : ''}`;
    const go = $('btn-mem-import');
    if (go) go.classList.toggle('hidden', !(r.imported + r.updated));
  } catch (e) { if (st) st.textContent = errText(e); }
};
if ($('btn-mem-import')) $('btn-mem-import').onclick = async () => {
  const ta = $('mem-import-text');
  const st = $('mem-import-status');
  try {
    const r = await memCall({ action: 'import', json: ta ? ta.value : '' });
    if (st) st.textContent = `Imported ${r.imported}, updated ${r.updated}, skipped ${r.skipped}.`;
    if (ta) ta.value = '';
    void refreshMemInfo();
    if (view === 'memory') await renderMemoryView();
  } catch (e) { if (st) st.textContent = errText(e); }
};
if ($('btn-mem-add')) $('btn-mem-add').onclick = () => { memFormMode = 'add'; renderMemForm(null); };
if ($('btn-mem-add2')) $('btn-mem-add2').onclick = () => { memFormMode = 'add'; renderMemForm(null); };
if ($('btn-memory-back')) $('btn-memory-back').onclick = () => { showView(backTarget()); inputEl.focus(); };
document.querySelectorAll('.mem-tabs button').forEach((b) => {
  b.onclick = () => { memTab = b.dataset.mk; memTabsPaint(); void renderMemoryView(); };
});
if ($('mem-search')) $('mem-search').addEventListener('input', (e) => {
  memQuery = e.target.value.trim();
  clearTimeout(window._memSearchT);
  window._memSearchT = setTimeout(() => void renderMemoryView(), 200);
});

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
    // why: one Esc cap next to Stop; the global stop hotkey lives in the
    // tooltip (and docs), never as three caps in the footer.
    const escCap = (platformInfo && platformInfo.caps && platformInfo.caps.esc) || 'Esc';
    const cap = `<span class="k">${esc(escCap)}</span>`;
    if (sh.innerHTML !== cap) sh.innerHTML = cap;
    const stopLabel = (platformInfo && platformInfo.stopLabel) || currentStopHotkey || 'Ctrl+Alt+Esc';
    sh.title = stopLabel;
    const btnStop = $('btn-stop');
    if (btnStop && btnStop.title !== `Stop (${stopLabel})`) btnStop.title = `Stop (${stopLabel})`;
    // footer queue hint: one cap pair, platform modifier (Cmd on macOS)
    const qm = $('queue-cap-mod');
    if (qm) {
      const want = (platformInfo && platformInfo.os === 'darwin') ? 'Cmd' : 'Ctrl';
      if (qm.textContent !== want) qm.textContent = want;
    }
  }
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
      if (ev.open === 'settings') { if (view !== 'settings') $('btn-settings').click(); }
      else if (ev.open === 'log') { void showAgentLog(); }
    } catch { /* preview */ }
  });
}

/* --- Attachments (appended): tray under input, paste/drop/picker, preview, notices --- */
(function attachUI() {
  if (typeof document === 'undefined') return;
  var trayEl = null, liveEl = null, prevEl = null, inputEl2 = null, panelEl = null, attachBtn = null;
  try {
    trayEl = document.getElementById('attach-tray');
    liveEl = document.getElementById('attach-live');
    prevEl = document.getElementById('attach-preview');
    inputEl2 = document.getElementById('input');
    panelEl = document.getElementById('panel');
    attachBtn = document.getElementById('btn-attach');
  } catch (e) { return; }
  if (!trayEl || !inputEl2) return;
  var VISION_NOTICE = 'This model does not support images. Switch model to send images — image bytes were not sent.';
  var DEFAULT_INSTR = 'Describe the attached files.';
  var pending = [];
  var keySeq = 0;
  var sentStash = {};
  var lastUserText = '';
  var lastHadAttach = false;
  var previewOpen = false;
  var previewPrior = null;
  // why: mirrors of scanSecretsText/isLocalProvider/attachNoticeText in
  // shared/attachments.ts (renderer has no imports); keep the two in sync.
  var SECRET_VALUE = "(?:['\"][^'\"]{2,}['\"]|[A-Za-z0-9-_]{8,})";
  var SECRET_RES = [
    /sk-[A-Za-z0-9-_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /aws_secret_access_key\s*[:=]\s*\S{8,}/i,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    new RegExp('\\bpassw(?:or)?d\\s*[:=]\\s*(?![A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\()' + SECRET_VALUE, 'i'),
    new RegExp('\\b(?:api[_-]?key|auth[_-]?token)\\s*[:=]\\s*(?![A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\()' + SECRET_VALUE, 'i'),
    /\bbearer\s+['"]?\S{8,}/i,
  ];
  function scanSecretsText(text) {
    try {
      if (!text || text.length < 8) return false;
      var sample = text.length > 65536 ? text.slice(0, 65536) : text;
      return SECRET_RES.some(function (re) { return re.test(sample); });
    } catch (e) { return false; }
  }
  var PROVIDER_DISPLAY = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', compatible: 'Custom' };
  function isLocalProvider(provider, baseUrl) {
    try {
      if (provider !== 'compatible') return false;
      // why: Node keeps IPv6 brackets in hostname, browsers strip them.
      var host = new URL(String(baseUrl || '')).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
      if (!host) return false;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      if (host.slice(-6) === '.local' || host.slice(-10) === '.localhost') return true;
      var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (m) {
        var a = +m[1], b = +m[2];
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
      }
      return false;
    } catch (e) { return false; }
  }
  function attachNoticeText(provider, baseUrl) {
    if (isLocalProvider(provider, baseUrl)) return 'Stays on this computer.';
    return 'Sent to ' + (PROVIDER_DISPLAY[provider] || provider || 'Custom') + ' when you press Enter.';
  }
  // Secrets gate: one confirmation per attachment set before any send.
  var secretsOk = false, secretsAsk = false;
  function secretsMatched() {
    try { return pending.filter(function (a) { return a.hasSecrets && (a.size || 0) > 0 && a.kind !== 'image'; }); } catch (e) { return []; }
  }
  function resetSecretsGate() { secretsOk = false; secretsAsk = false; }
  // Provider notice cache (async settings); refreshed on focus and on tray change.
  var noticeCache = { provider: 'openai', baseUrl: '', dismissed: {} };
  function refreshNoticeSettings() {
    try {
      if (!window.nexio || !window.nexio.getSettings) return;
      window.nexio.getSettings().then(function (s) {
        try {
          var next = {
            provider: (s && s.provider) || 'openai',
            baseUrl: (s && s.baseUrl) || '',
            dismissed: (s && s.attachNoticeDismissed) || {},
          };
          var changed = next.provider !== noticeCache.provider || next.baseUrl !== noticeCache.baseUrl ||
            JSON.stringify(next.dismissed) !== JSON.stringify(noticeCache.dismissed);
          noticeCache = next;
          if (changed && pending.length) renderTray();
        } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }
  function base(n) { try { return String(n || 'file').split(/[\\/]/).pop() || 'file'; } catch (e) { return 'file'; } }
  function fmtSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }
  function announce(m) {
    try {
      if (!liveEl) return;
      liveEl.textContent = m; // sr-only live region: never in the layout flow
    } catch (e) { /* live region never breaks sends */ }
  }
  function chrome() {
    try { if (typeof grow === 'function') grow(); } catch (e) {}
    try { if (typeof syncChrome === 'function') syncChrome(); } catch (e) {}
    try { if (typeof requestResize === 'function') requestResize(); } catch (e) {}
  }
  function fileSvg() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/></svg>';
  }
  function showError(msg) {
    try {
      var d = document.createElement('div');
      d.className = 'attach-err';
      var text = String(msg || '');
      var cut = text.indexOf('\nDetails: ');
      d.textContent = cut >= 0 ? text.slice(0, cut) : text;
      if (cut >= 0) {
        var det = document.createElement('button');
        det.type = 'button';
        det.className = 'abadge muted';
        det.textContent = 'Details';
        det.setAttribute('aria-expanded', 'false');
        det.setAttribute('aria-label', 'Show rejection details');
        (function (detail, btn) {
          btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var open = btn.getAttribute('aria-expanded') === 'true';
            var pre = d.querySelector('pre.adetails');
            if (pre) {
              pre.classList.toggle('hidden', open);
              btn.setAttribute('aria-expanded', String(!open));
              btn.textContent = open ? 'Details' : 'Hide details';
            } else {
              var p = document.createElement('pre');
              p.className = 'adetails';
              p.textContent = detail;
              d.appendChild(p);
              btn.setAttribute('aria-expanded', 'true');
              btn.textContent = 'Hide details';
            }
            chrome();
          });
        })(text.slice(cut + 10), det);
        d.appendChild(det);
      }
      trayEl.appendChild(d);
      trayEl.classList.remove('hidden');
      announce(cut >= 0 ? text.slice(0, cut) : text);
      chrome();
      setTimeout(function () { try { if (d.parentNode) d.parentNode.removeChild(d); chrome(); } catch (e) {} }, 6000);
    } catch (e) {}
  }
  function renderTray(note) {
    try {
      trayEl.innerHTML = '';
      if (!pending.length) {
        trayEl.classList.add('hidden');
        try { inputEl2.placeholder = (typeof mode !== 'undefined' && mode === 'agent') ? 'What do you want to do?' : 'Ask anything…'; } catch (e) {}
        chrome();
        return;
      }
      trayEl.classList.remove('hidden');
      try { inputEl2.placeholder = 'Add a note, Enter to send…'; } catch (e) {}
      pending.forEach(function (a) {
        var item;
        if (a.kind === 'image' && a.previewUrl) {
          item = document.createElement('button');
          item.type = 'button';
          item.className = 'attach-thumb';
          item.setAttribute('role', 'listitem');
          item.setAttribute('aria-label', 'Preview ' + base(a.name));
          item.title = base(a.name) + ' (' + fmtSize(a.size) + ') — click to preview';
          var img = document.createElement('img');
          img.alt = base(a.name);
          img.src = a.previewUrl;
          item.appendChild(img);
        } else {
          item = document.createElement('div');
          item.className = 'attach-chip' + (a.hasSecrets && (a.size || 0) > 0 ? ' secrets' : '');
          item.setAttribute('role', 'listitem');
          item.tabIndex = 0;
          item.title = base(a.name) + ' (' + fmtSize(a.size) + ')';
          if (a.docNote) item.title += ' — ' + a.docNote;
          if (a.docState === 'extracted' && a.preview) item.title += '\n' + String(a.preview).slice(0, 200);
          if (a.docState === 'reference' && !a.docNote) item.title += ' — Nexio can see the file name and path but not its contents.';
          item.innerHTML = fileSvg() + '<span class="aname"></span><span class="asz"></span>';
          item.querySelector('.aname').textContent = base(a.name);
          item.querySelector('.asz').textContent = fmtSize(a.size);
          if ((a.size || 0) === 0) {
            var eb = document.createElement('button');
            eb.type = 'button';
            eb.className = 'abadge muted';
            eb.textContent = a.emptyKept ? 'Empty file · kept' : 'Empty file';
            eb.title = a.emptyKept ? 'Kept — click to exclude from sending' : 'Empty files are not sent — click to keep';
            eb.setAttribute('aria-pressed', a.emptyKept ? 'true' : 'false');
            eb.setAttribute('aria-label', (a.emptyKept ? 'Exclude empty file ' : 'Keep empty file ') + base(a.name));
            (function (entry, btn) {
              btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                entry.emptyKept = !entry.emptyKept;
                renderTray();
              });
            })(a, eb);
            item.appendChild(eb);
          } else if (a.hasSecrets) {
            var wb = document.createElement('span');
            wb.className = 'abadge warn';
            wb.title = 'May contain secrets';
            wb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.5"/></svg>Review';
            item.appendChild(wb);
          }
          if (a.docState) {
            var db = document.createElement('span');
            var dlabel = a.docState === 'extracted' ? 'Extracted' : a.docState === 'macros' ? 'Macros' : a.docState === 'encrypted' ? 'Encrypted' : 'Reference only';
            db.className = 'abadge ' + (a.docState === 'macros' ? 'warn' : a.docState === 'extracted' ? 'acc' : 'muted');
            db.textContent = dlabel;
            db.title = a.docNote || dlabel;
            item.appendChild(db);
          }
          if (a.verdict === 'approval') {
            var b = document.createElement('span');
            b.className = 'aonce';
            b.textContent = 'Allow once';
            item.appendChild(b);
          }
        }
        item.dataset.akey = a.key;
        item.addEventListener('click', function (ev) {
          if (ev.target && ev.target.classList && (ev.target.classList.contains('attach-rm') || ev.target.classList.contains('abadge'))) return;
          openPreview(a);
        });
        item.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPreview(a); }
          else if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); removeEntry(a.key); }
        });
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'attach-rm';
        rm.setAttribute('aria-label', 'Remove ' + base(a.name));
        rm.title = 'Remove ' + base(a.name);
        rm.textContent = '×';
        rm.addEventListener('click', function (ev) { ev.stopPropagation(); removeEntry(a.key); });
        item.appendChild(rm);
        trayEl.appendChild(item);
      });
      maybeNotice();
      maybeSecretsConfirm();
      if (note) announce(note);
      chrome();
    } catch (e) { /* tray never breaks the composer */ }
  }
  function shouldShowNotice() {
    if (!pending.length) return false;
    try {
      if (!window.localStorage.getItem('nexio-attach-notice')) return true;
    } catch (e) { return true; }
    return !noticeCache.dismissed[noticeCache.provider];
  }
  function maybeNotice() {
    if (!shouldShowNotice()) return;
    try { window.localStorage.setItem('nexio-attach-notice', '1'); } catch (e) {}
    var n = document.createElement('div');
    n.className = 'attach-note';
    var t = document.createElement('span');
    t.textContent = attachNoticeText(noticeCache.provider, noticeCache.baseUrl);
    n.appendChild(t);
    var d = document.createElement('button');
    d.type = 'button';
    d.className = 'dismiss';
    d.textContent = 'Dismiss';
    d.setAttribute('aria-label', 'Dismiss attachment notice');
    d.addEventListener('click', function (ev) { ev.stopPropagation(); dismissNotice(); });
    n.appendChild(d);
    trayEl.appendChild(n);
  }
  function dismissNotice() {
    try {
      var map = {};
      try { map = Object.assign({}, noticeCache.dismissed); } catch (e) {}
      map[noticeCache.provider] = true;
      noticeCache.dismissed = map;
      if (window.nexio && window.nexio.getSettings && window.nexio.setSettings) {
        window.nexio.getSettings().then(function (s) {
          try {
            var prev = (s && s.attachNoticeDismissed) || {};
            window.nexio.setSettings({ attachNoticeDismissed: Object.assign({}, prev, map) }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      renderTray();
    } catch (e) {}
  }
  function maybeSecretsConfirm() {
    var m = secretsAsk ? secretsMatched() : [];
    if (!m.length) return;
    var bar = document.createElement('div');
    bar.className = 'attach-confirm';
    var t = document.createElement('span');
    t.textContent = (m.length === 1 ? '1 file' : m.length + ' files') + ' may contain secrets.';
    bar.appendChild(t);
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn-mini';
    go.textContent = 'Send anyway';
    go.addEventListener('click', function (ev) { ev.stopPropagation(); confirmSecretsSend(); });
    bar.appendChild(go);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn-mini';
    rm.textContent = 'Remove';
    rm.addEventListener('click', function (ev) { ev.stopPropagation(); removeSecretsMatched(); });
    bar.appendChild(rm);
    trayEl.appendChild(bar);
  }
  function confirmSecretsSend() {
    secretsOk = true;
    secretsAsk = false;
    renderTray();
    try { if (typeof send === 'function') void send(); } catch (e) {}
  }
  function removeSecretsMatched() {
    try {
      secretsMatched().slice().forEach(function (a) { removeEntry(a.key, true); });
      secretsAsk = false;
      renderTray();
    } catch (e) {}
  }
  function removeEntry(key, quiet) {
    try {
      var ix = -1, nm = '';
      for (var i = 0; i < pending.length; i++) if (pending[i].key === key) { ix = i; nm = base(pending[i].name); break; }
      if (ix >= 0) pending.splice(ix, 1);
      resetSecretsGate();
      renderTray(quiet ? undefined : 'Attachment removed');
      try { inputEl2.focus(); } catch (e) {}
    } catch (e) {}
  }
  function clearTray() { try { pending = []; resetSecretsGate(); renderTray(); } catch (e) {} }
  function toSendEntry(a) {
    var o = { name: base(a.name), mime: a.mime, size: a.size };
    if (a.path) o.path = a.path;
    else if (a.dataBase64) o.dataBase64 = a.dataBase64;
    return o;
  }
  function drainToSend() {
    return pending.filter(function (a) { return (a.size || 0) > 0 || a.emptyKept; }).map(toSendEntry);
  }
  function addEntries(list) {
    try {
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (pending.length >= 5) { showError(t('attach.count')); break; }
        if ((a.size || 0) > 20 * 1024 * 1024) { showError(t('attach.oversizeFile', { name: base(a.name) })); continue; }
        if (/\.exe$/i.test(a.name || '')) { showError(t('attach.exeName', { name: base(a.name) })); continue; }
        a.key = 'k' + (++keySeq);
        if (!a.kind) a.kind = (a.mime || '').indexOf('image/') === 0 ? 'image' : 'file';
        pending.push(a);
      }
      resetSecretsGate();
      renderTray(pending.length ? t('attach.added', { count: pending.length }) : undefined);
      refreshNoticeSettings();
      try { if (typeof hideSuggest === 'function') hideSuggest(); } catch (e) {} // attached: never an empty composer
      try { inputEl2.focus(); } catch (e) {}
    } catch (e) {}
  }
  function readFiles(files, asDrop) {
    try {
      var arr = [];
      for (var i = 0; i < files.length; i++) arr.push(files[i]);
      if (!arr.length) return;
      if (pending.length + arr.length > 5) { showError(t('attach.count')); arr = arr.slice(0, Math.max(0, 5 - pending.length)); }
      var started = 0;
      arr.forEach(function (f) {
        var name = base(f.name || 'pasted-image.png');
        var mime = f.type || 'application/octet-stream';
        if ((f.size || 0) > 20 * 1024 * 1024) { showError(t('attach.oversizeFile', { name: name })); return; }
        if (/\.exe$/i.test(name)) { showError(t('attach.exeName', { name: name })); return; }
        started++;
        try {
          var r = new FileReader();
          r.onload = function () {
            try {
              var url = String(r.result || '');
              var b64 = url.indexOf(',') >= 0 ? url.slice(url.indexOf(',') + 1) : '';
              var isImg = mime.indexOf('image/') === 0;
              var hasSecrets = false;
              try {
                if (!isImg && (f.size || b64.length)) hasSecrets = scanSecretsText(atob(b64.slice(0, 65536)));
              } catch (e2) { /* no badge without evidence */ }
              addEntries([{ name: name, mime: mime, size: f.size || b64.length, dataBase64: b64, previewUrl: isImg ? url : undefined, kind: isImg ? 'image' : 'file', hasSecrets: hasSecrets }]);
            } catch (e) {}
          };
          r.onerror = function () { showError('Attachment unreadable: ' + name); };
          r.readAsDataURL(f);
        } catch (e) { showError('Attachment unreadable: ' + name); }
      });
      void asDrop;
      if (!started) chrome();
    } catch (e) {}
  }
  function insertTextAtCursor(text) {
    try {
      var s = inputEl2.selectionStart || inputEl2.value.length;
      var e2 = inputEl2.selectionEnd || s;
      inputEl2.value = inputEl2.value.slice(0, s) + text + inputEl2.value.slice(e2);
      try { if (typeof grow === 'function') grow(); } catch (e) {}
    } catch (e) { inputEl2.value += text; }
  }
  // Paste: image/files + text+image; text-only falls through to the default paste.
  try {
    inputEl2.addEventListener('paste', function (e) {
      try {
        var cd = e.clipboardData;
        if (!cd) return;
        var files = [];
        if (cd.files) for (var i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
        var text = '';
        try { text = cd.getData ? (cd.getData('text/plain') || cd.getData('text') || '') : ''; } catch (e2) {}
        var kind = files.length && text ? 'mixed' : files.length ? (files.length === 1 ? 'image-only' : 'files-only') : text ? 'text-only' : 'empty';
        if (kind === 'text-only' || kind === 'empty') return;
        e.preventDefault();
        if (kind === 'mixed' && text) insertTextAtCursor(text);
        readFiles(files, false);
      } catch (e2) {}
    });
  } catch (e) {}
  // Drop: dashed accent + Drop to attach; always prevent navigate.
  try {
    window.addEventListener('dragover', function (e) { try { e.preventDefault(); } catch (e2) {} }, false);
    window.addEventListener('drop', function (e) { try { e.preventDefault(); } catch (e2) {} }, false);
    if (panelEl) {
      panelEl.addEventListener('dragenter', function (e) {
        try {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) {
            e.preventDefault();
            trayEl.classList.remove('hidden');
            trayEl.classList.add('dragover');
          }
        } catch (e2) {}
      });
      panelEl.addEventListener('dragover', function (e) { try { e.preventDefault(); } catch (e2) {} });
      panelEl.addEventListener('dragleave', function (e) {
        try { if (e.target === panelEl) trayEl.classList.remove('dragover'); } catch (e2) {}
      });
      panelEl.addEventListener('drop', function (e) {
        try {
          e.preventDefault();
          trayEl.classList.remove('dragover');
          var dt = e.dataTransfer;
          if (dt && dt.files && dt.files.length) readFiles(dt.files, true);
          else renderTray();
        } catch (e2) {}
      });
    }
  } catch (e) {}
  // Paperclip: multi picker through the dialog lock (main keeps the popup visible).
  try {
    if (attachBtn) attachBtn.addEventListener('click', function () {
      if (!window.nexio || !window.nexio.attachPick) return;
      attachBtn.disabled = true;
      window.nexio.attachPick().then(function (res) {
        attachBtn.disabled = false;
        try {
          var list = res || [];
          if (typeof list === 'string') list = [list];
          var ok = [];
          (Array.isArray(list) ? list : []).forEach(function (r) {
            if (typeof r === 'string') { ok.push({ name: base(r), mime: 'application/octet-stream', size: 0, path: r, kind: 'file', verdict: 'approval' }); return; }
            if (r && r.verdict === 'deny') { showError('Attachment refused: ' + base(r.name) + (r.reason ? ' — ' + r.reason : '')); return; }
            if (!r || !r.path) return;
            ok.push({
              name: base(r.name || r.path), mime: r.mime || 'application/octet-stream', size: r.size || 0,
              path: r.path, previewUrl: r.previewDataUrl,
              kind: (r.mime || '').indexOf('image/') === 0 ? 'image' : 'file',
              verdict: r.verdict === 'approval' ? 'approval' : undefined,
              hasSecrets: r.hasSecrets === true,
              docState: r.docState, docNote: r.docNote, details: r.details, preview: r.preview,
            });
          });
          if (ok.length) addEntries(ok);
          else chrome();
        } catch (e2) {}
        try { inputEl2.focus(); } catch (e2) {}
      }).catch(function (err) {
        attachBtn.disabled = false;
        var m = 'Attach failed';
        try { m = (err && err.message) || m; } catch (e2) {}
        showError(m);
      });
    });
  } catch (e) {}
  // In-panel preview; window-capture Esc closes it first (before the core closer).
  function openPreview(a) {
    try {
      if (!prevEl) return;
      previewPrior = document.activeElement;
      prevEl.innerHTML = '';
      if (a.kind === 'image' && a.previewUrl) {
        var img = document.createElement('img');
        img.alt = base(a.name);
        img.src = a.previewUrl;
        prevEl.appendChild(img);
      } else {
        var d = document.createElement('div');
        d.className = 'attach-chip';
        d.innerHTML = fileSvg() + '<span></span><span class="asz"></span>';
        d.querySelector('span').textContent = base(a.name);
        d.querySelector('.asz').textContent = fmtSize(a.size) + ' ' + (a.mime || '');
        if (a.docNote) {
          var dn = document.createElement('div');
          dn.className = 'ap-cap';
          dn.textContent = a.docNote;
          d.appendChild(dn);
        }
        if (a.preview) {
          var pv = document.createElement('pre');
          pv.className = 'out';
          pv.textContent = String(a.preview).slice(0, 500);
          d.appendChild(pv);
        }
        prevEl.appendChild(d);
      }
      var cap = document.createElement('div');
      cap.className = 'ap-cap';
      cap.textContent = base(a.name) + ' — Esc to close';
      prevEl.appendChild(cap);
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'btn';
      x.textContent = 'Close';
      x.setAttribute('aria-label', 'Close preview');
      x.addEventListener('click', closePreview);
      prevEl.appendChild(x);
      prevEl.classList.remove('hidden');
      previewOpen = true;
      try { if (typeof showView === 'function' && view !== 'run') showView('run'); } catch (e2) {}
      chrome();
      try { x.focus(); } catch (e2) {}
    } catch (e) {}
  }
  function closePreview() {
    try {
      if (!previewOpen) return false;
      prevEl.classList.add('hidden');
      prevEl.innerHTML = '';
      previewOpen = false;
      chrome();
      try { if (previewPrior && document.contains(previewPrior)) previewPrior.focus(); else inputEl2.focus(); } catch (e) {}
      previewPrior = null;
      return true;
    } catch (e) { return false; }
  }
  try {
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && previewOpen) { e.preventDefault(); e.stopPropagation(); closePreview(); }
    }, true);
  } catch (e) {}
  // Tray keyboard: Backspace/Delete removes focused chip, or the last one.
  try {
    trayEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      try {
        var t = e.target;
        var holder = t && t.closest ? t.closest('[data-akey]') : null;
        var key = holder ? holder.dataset.akey : (pending.length ? pending[pending.length - 1].key : null);
        if (key) { e.preventDefault(); removeEntry(key); }
      } catch (e2) {}
    });
    inputEl2.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !inputEl2.value && pending.length && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        removeEntry(pending[pending.length - 1].key);
      }
    });
  } catch (e) {}
  // Empty + attach Enter sends the default instruction (core sendInner returns on '').
  function emptyAttachEnter(e) {
    try {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      if (inputEl2.value.trim() !== '' || !pending.length) return;
      e.preventDefault();
      inputEl2.value = DEFAULT_INSTR;
      try { if (typeof grow === 'function') grow(); } catch (e2) {}
      try { if (typeof send === 'function') void send(); } catch (e2) {}
    } catch (e2) {}
  }
  try {
    inputEl2.addEventListener('keydown', emptyAttachEnter);
    var sendBtn = document.getElementById('btn-send');
    if (sendBtn) sendBtn.addEventListener('click', function () {
      try {
        if (inputEl2.value.trim() === '' && pending.length) {
          inputEl2.value = DEFAULT_INSTR;
          try { if (typeof grow === 'function') grow(); } catch (e2) {}
        }
      } catch (e2) {}
    });
  } catch (e) {}
  // Secrets gate: every UI send funnels through core send(); block once per
  // attachment set until the user confirms, instead of failing at the bridge.
  try {
    if (typeof send === 'function') {
      var _sendCore = send;
      send = async function () {
        try {
          if (!secretsOk && secretsMatched().length) {
            secretsAsk = true;
            renderTray();
            announce('Review attachments that may contain secrets');
            try { inputEl2.focus(); } catch (e2) {}
            return;
          }
        } catch (e2) {}
        return _sendCore.apply(this, arguments);
      };
    }
  } catch (e) {}
  // Bridge (frozen by contextBridge, so wrappers cannot patch it): the send
  // sites below claim + settle attachments explicitly instead.
  function stashFor(cid) {
    try {
      if (!cid) return;
      var cur = sentStash[cid] || [];
      pending.forEach(function (a) { cur.push({ name: base(a.name), mime: a.mime, size: a.size, previewUrl: a.previewUrl, kind: a.kind }); });
      sentStash[cid] = cur.slice(-10);
      lastHadAttach = pending.length > 0;
    } catch (e) {}
  }
  window.attachClaimForSend = function () {
    try {
      var merged = [];
      try { merged = drainToSend(); } catch (e) {}
      return { attachments: merged.length ? merged : undefined, had: pending.length };
    } catch (e) { return { attachments: undefined, had: 0 }; }
  };
  window.attachMarkSent = function (cid) {
    try {
      if (!pending.length) return;
      try { stashFor(cid); } catch (e) {}
      clearTray();
    } catch (e) {}
  };
  // Ask history: 160px thumbs + chips + Delete attachments menu.
  function paintHistAttach() {
    try {
      var ul = document.getElementById('history-list');
      if (!ul) return;
      var items = ul.querySelectorAll('li');
      items.forEach(function (li) {
        if (li.dataset.attachDone) return;
        li.dataset.attachDone = '1';
        var cid = li.dataset.cid;
        if (!cid) return;
        var bag = sentStash[cid] || [];
        if (!bag.length) return;
        var wrap = document.createElement('div');
        wrap.className = 'attach-menu';
        bag.forEach(function (a) {
          if (a.kind === 'image' && a.previewUrl) {
            var im = document.createElement('img');
            im.className = 'hist-thumb';
            im.alt = base(a.name);
            im.src = a.previewUrl;
            wrap.appendChild(im);
          } else {
            var c = document.createElement('span');
            c.className = 'attach-chip';
            c.textContent = base(a.name) + ' (' + fmtSize(a.size) + ')';
            wrap.appendChild(c);
          }
        });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'linklike';
        del.textContent = 'Delete attachments';
        del.setAttribute('aria-label', 'Delete attachments');
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          // why: the menu stays until the main-process delete lands — a
          // failure keeps its Retry (this button), never a fake "cleared".
          function done() {
            delete sentStash[cid];
            if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
            announce('Delete attachments — cleared');
          }
          try {
            if (window.nexio && window.nexio.attachClear && cid) {
              window.nexio.attachClear(cid).then(done, function () {
                showError('Delete attachments failed — Retry');
              });
            } else done();
          } catch (e2) {}
        });
        wrap.appendChild(del);
        li.appendChild(wrap);
      });
    } catch (e) {}
  }
  try {
    if (typeof refreshHistory === 'function') {
      var _rh = refreshHistory;
      refreshHistory = function () {
        var p = _rh.apply(this, arguments);
        if (p && p.then) p.then(function () { paintHistAttach(); chrome(); }).catch(function () {});
        else { try { paintHistAttach(); } catch (e) {} }
        return p;
      };
    }
  } catch (e) {}
  // Decorate just-sent user bubbles with thumbs/chips (Ask view).
  try {
    if (typeof addMsg === 'function' && typeof messagesEl !== 'undefined' && messagesEl) {
      var _addMsg = addMsg;
      addMsg = function (role, content) {
        var div = _addMsg(role, content);
        try {
          if (role === 'user' && pending.length) {
            var bag = pending.map(function (a) { return { name: a.name, previewUrl: a.previewUrl, kind: a.kind, size: a.size }; });
            bag.forEach(function (a) {
              if (a.kind === 'image' && a.previewUrl) {
                var im = document.createElement('img');
                im.className = 'hist-thumb';
                im.alt = base(a.name);
                im.src = a.previewUrl;
                div.appendChild(im);
              } else {
                var c = document.createElement('span');
                c.className = 'attach-chip';
                c.textContent = base(a.name) + ' (' + fmtSize(a.size) + ')';
                div.appendChild(c);
              }
            });
            try { lastUserText = String(content || ''); } catch (e2) {}
          } else if (role === 'user') {
            try { lastUserText = String(content || ''); } catch (e2) {}
          }
        } catch (e2) {}
        return div;
      };
    }
  } catch (e) {}
  // Non-vision notice: one-click Switch model + single recovery resend (bytes were never sent).
  function maybeVisionNotice(node) {
    try {
      if (!node || !node.classList || !node.classList.contains('assistant')) return;
      var t = node.textContent || '';
      if (t.indexOf('does not support images') < 0) return;
      if (node.dataset.visionBtn) return;
      node.dataset.visionBtn = '1';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Switch model';
      b.setAttribute('aria-label', 'Switch model');
      b.addEventListener('click', function () {
        if (node.dataset.recovered) return;
        node.dataset.recovered = '1';
        b.disabled = true;
        try {
          // Never silently replace the user's provider/model; confirm first.
          if (!window.confirm('Switch model to OpenAI gpt-4o-mini so images can send? Your current provider and model will be replaced.')) {
            node.dataset.recovered = '';
            b.disabled = false;
            return;
          }
          (window.nexio.setSettings({ provider: 'openai', model: 'gpt-4o-mini' }) || Promise.resolve()).then(function () {
            try { if (typeof refreshModelName === 'function') refreshModelName(); } catch (e2) {}
            try {
              if (lastUserText && typeof send === 'function') {
                inputEl2.value = lastUserText;
                try { if (typeof grow === 'function') grow(); } catch (e3) {}
                // The failed send cleared the tray, so image bytes are gone:
                // restore the text but never resend it alone — warn to re-attach.
                if (lastHadAttach) {
                  lastHadAttach = false;
                  showError('Images were not sent — re-attach them, then send.');
                } else {
                  void send();
                }
              }
            } catch (e2) {}
          }).catch(function () { b.disabled = false; });
        } catch (e2) { b.disabled = false; }
      });
      node.appendChild(b);
      chrome();
    } catch (e) {}
  }
  try {
    if (typeof MutationObserver !== 'undefined' && messagesEl) {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          (m.addedNodes || []).forEach(function (n) { maybeVisionNotice(n); });
        });
      }).observe(messagesEl, { childList: true });
    }
  } catch (e) {}
  // why: isEmptyUI gates suggestions on pending attachments without reaching into the tray closure
  try {
    window.attachPendingCount = function () { try { return pending.length; } catch (e) { return 0; } };
    window.clearAttachTray = function () { try { clearTray(); } catch (e) {} };
    window.attachRemoveLast = function () { try { if (pending.length) removeEntry(pending[pending.length - 1].key); } catch (e) {} };
    try { refreshNoticeSettings(); } catch (e) {}
    try { window.addEventListener('focus', function () { refreshNoticeSettings(); }); } catch (e) {}
  } catch (e) {}
})();

/* --- Tasks (appended): multi-task Do runs, one active view, footer badge --- */
// var (not let): early subscribers above reference these helpers before this block executes.
var taskCache = new Map(); // id -> TaskRow
var taskRunCache = new Map(); // runId -> id
var foregroundTaskId = null;
var taskEventBuf = new Map(); // runId -> AgentEvent[] (cap 200, background detail)
var taskDetailId = null;
var taskShowDone = 10;
var taskResumeSeen = false;

function taskCall(a) { return window.nexio.tasks(a); }

function taskEventForBackground(runId, event) {
  try {
    var id = taskRunCache.get(runId);
    if (id) {
      if (id === foregroundTaskId) return false;
      bufferTaskEvent(runId, event);
      return true;
    }
    if (foregroundTaskId) {
      // Unknown run while a foreground task exists: assume background, refresh to confirm.
      bufferTaskEvent(runId, event);
      void refreshTasks();
      return true;
    }
  } catch (e) {}
  return false;
}

function bufferTaskEvent(runId, event) {
  try {
    var list = taskEventBuf.get(runId) || [];
    list.push(event);
    if (list.length > 200) list = list.slice(-200);
    taskEventBuf.set(runId, list);
    if (view === 'tasks') void renderTasksView();
    paintTasksButton();
  } catch (e) {}
}

function taskElapsed(ts) {
  if (!ts) return '';
  try {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    var rtf = new Intl.RelativeTimeFormat(L.tag, { numeric: 'auto' });
    if (s < 60) return rtf.format(-s, 'second');
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    return rtf.format(-Math.round(s / 86400), 'day');
  } catch (e) { return ''; }
}

function taskStatusIcon(state) {
  if (state === 'running') return '<span class="ic spin" aria-hidden="true"></span>';
  if (state === 'waiting_approval') return '<span class="ic" aria-hidden="true">' + stepSvg(ICO_WAIT) + '</span>';
  if (state === 'done') return '<span class="ic" aria-hidden="true">' + stepSvg(ICO_OK) + '</span>';
  if (state === 'failed' || state === 'interrupted') return '<span class="ic" aria-hidden="true">' + stepSvg(ICO_FAIL) + '</span>';
  return '<span class="ic" aria-hidden="true">•</span>'; // queued dot / stopped
}

function taskStateText(row) {
  if (row.detail) return row.detail;
  if (row.state === 'waiting_approval') {
    var n = (row.pendingApprovals || []).length;
    return t('tasks.needsApproval') + (n > 1 ? ' (' + n + ')' : '');
  }
  if (row.state === 'running') return t('tasks.running') + '…';
  if (row.state === 'queued') return t('tasks.queued') + '…';
  if (row.resultSummary) return row.resultSummary.split('\n')[0].slice(0, 120);
  return t('tasks.' + row.state);
}

async function refreshTasks() {
  var res;
  try {
    if (!window.nexio || !window.nexio.tasks) return;
    res = await window.nexio.tasks({ action: 'list' });
  } catch (e) { return; }
  var rows = (res && res.tasks) || [];
  taskCache = new Map(rows.map(function (r) { return [r.id, r]; }));
  taskRunCache = new Map();
  rows.forEach(function (r) { if (r.runId) taskRunCache.set(r.runId, r.id); });
  if (res && 'foregroundTaskId' in res) foregroundTaskId = res.foregroundTaskId || null;
  // Replay buffered events that turned out to belong to the foreground task.
  // Mirrors shared/task-routing.ts shouldReplayBuffered: adopt into an absent
  // view, or into a view waiting for the same run — never into another run.
  try {
    for (const [runId, evs] of taskEventBuf) {
      var cached = taskRunCache.get(runId);
      if (cached !== foregroundTaskId) continue;
      if (!agentState) {
        agentState = { runId: runId, rows: new Map(), answerDiv: assistantDiv };
        var steps = $('agent-steps');
        if (steps) steps.classList.remove('hidden');
        showView('run');
        evs.forEach(function (ev) { handleAgentEvent(runId, ev); });
        taskEventBuf.delete(runId);
      } else if (!agentState.runId || agentState.runId === runId) {
        if (!agentState.runId) agentState.runId = runId;
        evs.forEach(function (ev) { handleAgentEvent(runId, ev); });
        taskEventBuf.delete(runId);
      }
    }
  } catch (e) {}
  paintTasksButton();
  if (view === 'tasks') void renderTasksView();
  maybeResumeBar(rows);
  try { syncChrome(); requestResize(); } catch (e) {}
}

function taskCounts() {
  var running = 0, queued = 0, approval = 0;
  taskCache.forEach(function (r) {
    if (r.state === 'running') running++;
    else if (r.state === 'waiting_approval') { running++; approval++; }
    else if (r.state === 'queued') queued++;
  });
  return { running: running, queued: queued, approval: approval };
}

function paintTasksButton() {
  var btn = $('btn-tasks');
  if (!btn) return;
  var c = taskCounts();
  var badge = $('task-badge'), warn = $('task-warn');
  var n = c.running + c.queued;
  if (badge) {
    badge.textContent = n > 0 ? String(n) : '';
    badge.classList.toggle('hidden', n === 0);
  }
  if (warn) warn.classList.toggle('hidden', c.approval === 0);
  btn.classList.toggle('warn', c.approval > 0);
  var label;
  if (c.approval > 0) label = c.approval + ' ' + t('tasks.waitingApproval');
  else if (c.running > 0) label = t('tasks.running') + ' (' + c.running + ')';
  else if ([...taskCache.values()].some(function (r) { return r.state === 'done' || r.state === 'failed'; })) label = t('tasks.done') + '. ' + t('common.view');
  else label = t('tasks.title');
  // why: icon button — status goes to aria-label/title, never button text.
  var tip = label === t('tasks.title') ? t('tasks.title') + ' (/tasks)' : label;
  btn.setAttribute('aria-label', t('tasks.title') + (n > 0 ? ' (' + n + ')' : ''));
  if (btn.title !== tip) btn.title = tip;
}

function openTasksView() { showView('tasks'); }

async function renderTasksView() {
  var host = $('task-list');
  if (!host) return;
  var rows = [...taskCache.values()].sort(function (a, b) { return a.createdAt - b.createdAt; });
  var c = taskCounts();
  var sum = $('task-summary');
  if (sum) {
    sum.textContent = '';
    var span = document.createElement('span');
    span.textContent = t('tasks.summary', { running: c.running, queued: c.queued });
    sum.appendChild(span);
    if (c.running > 0) {
      var stopAll = ghostBtn(t('tasks.stopAll'), t('tasks.stopAll'));
      stopAll.onclick = function () { void taskOp('stopAll', {}); };
      sum.appendChild(stopAll);
    }
  }
  host.innerHTML = '';
  var empty = $('task-empty');
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  var approval = rows.filter(function (r) { return r.state === 'waiting_approval'; });
  section(host, 'approval', t('tasks.needsApproval'), approval);
  // User tasks are flat rows; subtasks nest under their parent.
  var actives = rows.filter(function (r) { return r.state === 'running' || r.state === 'queued'; });
  var tops = actives.filter(function (r) { return !r.parentId; });
  var orphans = actives.filter(function (r) { return r.parentId && !taskCache.get(r.parentId); });
  var sec = document.createElement('div');
  sec.className = 'task-sec';
  var h = document.createElement('div');
  h.className = 'lb';
  h.textContent = t('tasks.running') + ' / ' + t('tasks.queued');
  sec.appendChild(h);
  tops.concat(orphans).forEach(function (r) {
    sec.appendChild(taskRow(r));
    rows.filter(function (x) { return x.parentId === r.id; }).forEach(function (sub) { sec.appendChild(taskRow(sub, true)); });
  });
  if (sec.children.length > 1) host.appendChild(sec);
  var done = rows.filter(function (r) { return r.state === 'done' || r.state === 'failed' || r.state === 'stopped' || r.state === 'interrupted'; })
    .sort(function (a, b) { return (b.endedAt || 0) - (a.endedAt || 0); });
  var doneShown = done.slice(0, taskShowDone);
  if (doneShown.length) {
    var dsec = document.createElement('div');
    dsec.className = 'task-sec';
    var dh = document.createElement('div');
    dh.className = 'lb';
    dh.textContent = t('tasks.done');
    dsec.appendChild(dh);
    doneShown.forEach(function (r) { dsec.appendChild(taskRow(r)); });
    if (done.length > taskShowDone) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'linklike';
      more.textContent = t('tasks.showMore');
      more.onclick = function () { taskShowDone += 10; void renderTasksView(); };
      dsec.appendChild(more);
    }
    host.appendChild(dsec);
  }
  maybeResumeBar(rows);
  try { syncChrome(); requestResize(); } catch (e) {}
}

function section(host, kind, title, rows) {
  if (!rows.length) return;
  var sec = document.createElement('div');
  sec.className = 'task-sec task-sec-' + kind;
  var h = document.createElement('div');
  h.className = 'lb';
  h.textContent = title;
  sec.appendChild(h);
  rows.forEach(function (r) { sec.appendChild(taskRow(r)); });
  host.appendChild(sec);
}

function taskRow(r, nested) {
  var li = document.createElement('div');
  li.className = 'task-row' + (nested ? ' task-sub' : '') + ' task-' + r.state;
  li.dataset.tid = r.id;
  li.setAttribute('role', 'article');
  li.setAttribute('aria-label', r.title + ' — ' + t('tasks.' + r.state));
  if (nested) {
    var conn = document.createElement('span');
    conn.className = 'task-conn';
    conn.setAttribute('aria-hidden', 'true');
    li.appendChild(conn);
  }
  var ic = document.createElement('span');
  ic.className = 'task-ic';
  ic.innerHTML = taskStatusIcon(r.state);
  li.appendChild(ic);
  var tx = document.createElement('div');
  tx.className = 'task-tx';
  var main = document.createElement('div');
  main.className = 'task-title';
  main.textContent = r.title;
  if (nested) {
    var tag = document.createElement('span');
    tag.className = 'task-agent-tag';
    tag.textContent = t('tasks.agentTag');
    main.appendChild(document.createTextNode(' '));
    main.appendChild(tag);
  }
  if (r.priority === 'high') {
    var pri = document.createElement('span');
    pri.className = 'task-pri';
    pri.textContent = t('tasks.high');
    main.appendChild(document.createTextNode(' '));
    main.appendChild(pri);
  }
  tx.appendChild(main);
  var meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.dir = 'auto';
  meta.textContent = taskStateText(r);
  tx.appendChild(meta);
  li.appendChild(tx);
  var right = document.createElement('div');
  right.className = 'task-right';
  var el = document.createElement('span');
  el.className = 'task-elapsed';
  el.textContent = taskElapsed(r.startedAt || r.createdAt);
  right.appendChild(el);
  var menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'task-menu-btn';
  menuBtn.textContent = '…';
  menuBtn.setAttribute('aria-label', t('common.details'));
  menuBtn.setAttribute('aria-expanded', 'false');
  var menu = document.createElement('div');
  menu.className = 'task-menu hidden';
  menu.setAttribute('role', 'menu');
  taskMenuItems(r).forEach(function (it) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.setAttribute('role', 'menuitem');
    b.onclick = function (e) { e.stopPropagation(); menu.classList.add('hidden'); it.fn(); };
    menu.appendChild(b);
  });
  menuBtn.onclick = function (e) {
    e.stopPropagation();
    var open = menu.classList.toggle('hidden');
    menuBtn.setAttribute('aria-expanded', String(!open));
  };
  right.appendChild(menuBtn);
  right.appendChild(menu);
  li.appendChild(right);
  li.onclick = function (e) {
    if (e.target.closest('button') || e.target.closest('.task-menu') || e.target.closest('.task-detail')) return;
    taskDetailId = taskDetailId === r.id ? null : r.id;
    void renderTasksView();
  };
  // Queued rows reorder with a drag handle and Alt+Up/Alt+Down.
  if (r.state === 'queued' && !r.parentId) {
    li.draggable = true;
    var handle = document.createElement('span');
    handle.className = 'task-drag';
    handle.textContent = '⠿';
    handle.title = t('tasks.moveUp') + ' / ' + t('tasks.moveDown');
    handle.setAttribute('aria-hidden', 'true');
    li.insertBefore(handle, ic);
    li.addEventListener('dragstart', function (e) { try { e.dataTransfer.setData('text/task-id', r.id); } catch (err) {} });
    li.addEventListener('dragover', function (e) { e.preventDefault(); });
    li.addEventListener('drop', function (e) {
      e.preventDefault();
      try {
        var from = e.dataTransfer.getData('text/task-id');
        if (from && from !== r.id) void taskMoveRelative(from, r.id);
      } catch (err) {}
    });
  }
  if (taskDetailId === r.id) li.appendChild(taskDetail(r));
  return li;
}

async function taskMoveRelative(fromId, toId) {
  // Move by repeated up/down steps toward the drop target (queue order).
  var rows = [...taskCache.values()].filter(function (r) { return r.state === 'queued' && !r.parentId; })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
  var fi = rows.findIndex(function (r) { return r.id === fromId; });
  var ti = rows.findIndex(function (r) { return r.id === toId; });
  if (fi < 0 || ti < 0) return;
  var dir = fi < ti ? 1 : -1;
  for (var i = fi; i !== ti; i += dir) {
    try { await window.nexio.tasks({ action: 'move', id: fromId, dir: dir }); } catch (e) { break; }
  }
  say(t('tasks.moveUp'));
  await refreshTasks();
}

function taskMenuItems(r) {
  var items = [];
  items.push({ label: t('tasks.open'), fn: function () { taskDetailId = r.id; void renderTasksView(); } });
  if (r.state === 'running' || r.state === 'waiting_approval' || r.state === 'queued') {
    items.push({ label: t('tasks.stop'), fn: function () { void taskOp('stop', { id: r.id }); } });
  }
  if (r.state === 'queued' && !r.parentId) {
    items.push({ label: t('tasks.moveUp'), fn: function () { void taskOp('move', { id: r.id, dir: -1 }); } });
    items.push({ label: t('tasks.moveDown'), fn: function () { void taskOp('move', { id: r.id, dir: 1 }); } });
    items.push({ label: r.priority === 'high' ? t('tasks.setNormal') : t('tasks.setHigh'), fn: function () { void taskOp('priority', { id: r.id, priority: r.priority === 'high' ? 'normal' : 'high' }); } });
  }
  if (r.state === 'done' || r.state === 'failed' || r.state === 'stopped' || r.state === 'interrupted') {
    items.push({ label: t('tasks.retry'), fn: function () { void taskOp('retry', { id: r.id }); } });
    items.push({ label: t('tasks.undo'), fn: function () { void taskUndo(r.id, false); } });
    if (!r.parentId) items.push({ label: t('tasks.undoFamily'), fn: function () { void taskUndo(r.id, true); } });
    items.push({ label: t('tasks.remove'), fn: function () { void taskOp('remove', { id: r.id }); } });
  }
  return items;
}

async function taskOp(action, params) {
  try { await window.nexio.tasks(Object.assign({ action: action }, params)); } catch (e) { say(errText(e)); }
  await refreshTasks();
}

async function taskUndo(id, family) {
  try {
    var r = await window.nexio.tasks({ action: 'undo', id: id, family: family });
    var lines = (r.undone || []).concat((r.failed || []).map(function (f) { return t('tasks.retry') + ': ' + f; }));
    say(lines.length ? lines.join('; ').slice(0, 300) : t('tasks.done'));
  } catch (e) { say(errText(e)); }
  await refreshTasks();
}

function taskDetail(r) {
  var d = document.createElement('div');
  d.className = 'task-detail';
  var by = document.createElement('div');
  by.className = 'task-by';
  by.textContent = r.parentId ? t('tasks.createdByNexio') : t('tasks.startedByYou');
  d.appendChild(by);
  var you = document.createElement('div');
  you.className = 'task-you';
  you.dir = 'auto';
  you.textContent = r.prompt;
  d.appendChild(you);
  if (r.resultSummary) {
    var out = document.createElement('div');
    out.className = 'task-outcome';
    out.dir = 'auto';
    out.textContent = r.resultSummary.slice(0, 500);
    d.appendChild(out);
  }
  var chips = document.createElement('div');
  chips.className = 'task-chips';
  if (r.cwd) {
    var open = ghostBtn(t('tasks.open'), r.cwd);
    open.onclick = function () { try { window.nexio.reveal(r.cwd); } catch (e) {} };
    chips.appendChild(open);
  }
  if (r.runId && r.state === 'done') {
    var undo = ghostBtn(t('tasks.undo'), t('tasks.undo'));
    undo.onclick = function () { void taskUndo(r.id, false); };
    chips.appendChild(undo);
  }
  if (!r.parentId && r.state === 'done') {
    var ufam = ghostBtn(t('tasks.undoFamily'), t('tasks.undoFamily'));
    ufam.onclick = function () { void taskUndo(r.id, true); };
    chips.appendChild(ufam);
  }
  if (r.state === 'failed' && r.resultSummary) {
    var retry = ghostBtn(t('tasks.retry'), t('tasks.retry'));
    retry.onclick = function () { void taskOp('retry', { id: r.id }); };
    chips.appendChild(retry);
  }
  if (r.state === 'running' || r.state === 'waiting_approval' || r.state === 'queued') {
    var stop = ghostBtn(t('tasks.stop'), t('tasks.stop'));
    stop.onclick = function () { void taskOp('stop', { id: r.id }); };
    chips.appendChild(stop);
  }
  d.appendChild(chips);
  // Pending approval cards live in the task's own view only.
  var pend = (r.pendingApprovals || []).concat(pendingCardsFor(r));
  if (pend.length) {
    var ahead = document.createElement('div');
    ahead.className = 'task-appr-head';
    var review = ghostBtn(t('tasks.reviewAll') + ' (' + pend.length + ')', t('tasks.reviewAll'));
    review.onclick = function () {
      var first = d.querySelector('.appr');
      if (first) first.scrollIntoView({ block: 'nearest' });
    };
    ahead.appendChild(review);
    d.appendChild(ahead);
    pend.forEach(function (p) {
      try {
        var card = buildApprovalCard(p.runId, { id: p.callId, tool: p.tool, summary: p.summary, risk: 'write' });
        d.appendChild(card);
      } catch (e) {}
    });
  }
  // Buffered step list, collapsed.
  var evs = r.runId ? (taskEventBuf.get(r.runId) || []) : [];
  var calls = evs.filter(function (e) { return e && (e.type === 'tool_call' || e.type === 'step'); });
  if (calls.length) {
    var tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'steps-toggle';
    var shown = false;
    var list = document.createElement('div');
    list.className = 'task-steps hidden';
    tog.textContent = calls.length + ' steps';
    tog.setAttribute('aria-expanded', 'false');
    tog.onclick = function () {
      shown = !shown;
      list.classList.toggle('hidden', !shown);
      tog.setAttribute('aria-expanded', String(shown));
    };
    calls.slice(-30).forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'astep';
      var label = e.type === 'step' ? (e.text || '') : (e.summary || e.tool || '');
      row.innerHTML = '<span class="tx"></span>';
      row.querySelector('.tx').textContent = String(label).slice(0, 160);
      list.appendChild(row);
    });
    d.appendChild(tog);
    d.appendChild(list);
  }
  return d;
}

/** Pending cards from buffered approval_request events not yet in the row. */
function pendingCardsFor(r) {
  var out = [];
  try {
    var seen = {};
    (r.pendingApprovals || []).forEach(function (p) { seen[p.callId] = true; });
    var evs = (r.runId && taskEventBuf.get(r.runId)) || [];
    evs.forEach(function (e) {
      if (e && e.type === 'approval_request' && !seen[e.id]) {
        out.push({ runId: r.runId, callId: e.id, tool: e.tool, summary: e.summary });
      }
    });
  } catch (e) {}
  return out;
}

function maybeResumeBar(rows) {
  var bar = $('task-resume-bar');
  if (!bar) return;
  if (taskResumeSeen) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  var waiting = rows.filter(function (r) { return r.state === 'queued' || r.state === 'interrupted'; });
  if (!waiting.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  var span = document.createElement('span');
  span.textContent = t('tasks.resumePrompt', { n: waiting.length });
  bar.appendChild(span);
  var go = ghostBtn(t('tasks.resume'), t('tasks.resume'));
  go.onclick = async function () { taskResumeSeen = true; await taskOp('resumeAll', {}); };
  var no = ghostBtn(t('tasks.discard'), t('tasks.discard'));
  no.onclick = async function () { taskResumeSeen = true; await taskOp('discardAll', {}); };
  bar.appendChild(go);
  bar.appendChild(no);
}

// --- submit routing: Enter / Ctrl+Enter / while-busy choice / ghost buttons ---
function tasksRunningCount() {
  var n = 0;
  taskCache.forEach(function (r) { if (r.state === 'running' || r.state === 'waiting_approval') n++; });
  return n;
}

function showTaskChoice(text) {
  var box = $('task-choice');
  if (!box) { void send({ taskAction: 'spawn' }); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  [
    [t('tasks.runSeparately'), 'spawn'],
    [t('tasks.addToQueue'), 'queue'],
    [t('tasks.replaceCurrent'), 'replace'],
  ].forEach(function (pair) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = pair[0];
    b.onclick = function () {
      hideTaskChoice();
      var remember = box.querySelector('input');
      if (remember && remember.checked) {
        void window.nexio.setSettings({ taskConfirmOnSubmit: false, taskSubmitDefault: pair[1] }).catch(function () {});
      }
      inputEl.value = text;
      void send({ taskAction: pair[1] });
    };
    box.appendChild(b);
  });
  var lab = document.createElement('label');
  lab.className = 'task-dontask';
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(' ' + t('tasks.dontAsk')));
  box.appendChild(lab);
  say(t('tasks.runSeparately'));
}

function hideTaskChoice() {
  var box = $('task-choice');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

// --- slash commands for tasks (renderer-side, before the router) ---
async function runCancelCommand(arg) {
  var n = parseInt(String(arg || '').trim(), 10);
  var rows = [...taskCache.values()]
    .filter(function (r) { return r.state === 'running' || r.state === 'waiting_approval' || r.state === 'queued'; })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
  var target = rows[isNaN(n) ? 0 : n - 1];
  if (!target) { say(t('tasks.empty')); return; }
  await taskOp('stop', { id: target.id });
}

async function runClearQueueCommand() {
  var rows = [...taskCache.values()].filter(function (r) { return r.state === 'queued'; });
  if (!rows.length) return;
  addMsg('user', '/clear-queue');
  showView('run');
  var div = addMsg('assistant', '…');
  div.textContent = '';
  var span = document.createElement('span');
  span.textContent = t('tasks.clearQueueConfirm', { n: rows.length }) + ' ';
  div.appendChild(span);
  var go = ghostBtn(t('tasks.remove'), t('tasks.clearQueueConfirm', { n: rows.length }));
  go.onclick = async function () { await taskOp('clearQueue', {}); say(t('tasks.cleared')); };
  var keep = ghostBtn(t('common.cancel'), t('common.cancel'));
  keep.onclick = function () { div.remove(); };
  div.appendChild(go);
  div.appendChild(keep);
}

// --- settings: Agent > Tasks section ---
function paintTaskSettings(s) {
  if ($('set-task-parallel')) $('set-task-parallel').value = s.taskMaxParallel || 2;
  if ($('set-task-queued')) $('set-task-queued').value = s.taskMaxQueued || 20;
  if ($('set-task-subtasks')) $('set-task-subtasks').checked = s.taskAllowSubtasks !== false;
  if ($('set-task-asksub')) $('set-task-asksub').checked = s.taskAskBeforeSubtasks !== false;
  if ($('set-task-confirm')) $('set-task-confirm').checked = s.taskConfirmOnSubmit !== false;
  if ($('set-task-notify')) $('set-task-notify').checked = s.taskNotifications !== false;
  if ($('set-task-prune')) $('set-task-prune').value = s.taskPruneDays || 30;
  var seg = $('set-task-resume');
  if (seg) seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tr === (s.taskResume || 'ask')); });
}

function readTaskSettings(patch) {
  var mc = parseInt($('set-task-parallel') && $('set-task-parallel').value, 10);
  if (Number.isFinite(mc)) patch.taskMaxParallel = Math.min(4, Math.max(1, mc));
  var mq = parseInt($('set-task-queued') && $('set-task-queued').value, 10);
  if (Number.isFinite(mq)) patch.taskMaxQueued = Math.min(100, Math.max(1, mq));
  if ($('set-task-subtasks')) patch.taskAllowSubtasks = $('set-task-subtasks').checked;
  if ($('set-task-asksub')) patch.taskAskBeforeSubtasks = $('set-task-asksub').checked;
  if ($('set-task-confirm')) patch.taskConfirmOnSubmit = $('set-task-confirm').checked;
  if ($('set-task-notify')) patch.taskNotifications = $('set-task-notify').checked;
  var pd = parseInt($('set-task-prune') && $('set-task-prune').value, 10);
  if (Number.isFinite(pd)) patch.taskPruneDays = Math.min(3650, Math.max(1, pd));
  var on = document.querySelector('#set-task-resume button.on');
  if (on && on.dataset.tr) patch.taskResume = on.dataset.tr;
}

// --- boot: subscribe, paint, resume prompt ---
(function () {
  var seg = $('set-task-resume');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    });
  });
})();
if ($('btn-tasks')) $('btn-tasks').onclick = function () { togglePanel('tasks'); };
if ($('btn-tasks-back')) $('btn-tasks-back').onclick = function () { showView(backTarget()); try { inputEl.focus(); } catch (e) {} };
if (window.nexio && typeof window.nexio.onTasksChanged === 'function') {
  window.nexio.onTasksChanged(function () { void refreshTasks(); });
}
void refreshTasks();
