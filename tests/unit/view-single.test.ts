import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultView,
  openView,
  goBack,
  isViewSlash,
  handleViewSlash,
  runChipLabel,
  shouldShowPlanning,
} from '../../src/shared/view';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');

describe('single-view component: extensions holds no run content', () => {
  it('wraps the run unit in #run in DOM order', () => {
    const h = html();
    expect(h).toContain('id="run"');
    const run = h.slice(h.indexOf('id="run"'), h.indexOf('id="attach-preview"'));
    for (const id of ['id="messages"', 'id="agent-steps"', 'id="answer-meta"', 'id="actions"']) {
      expect(run).toContain(id);
    }
    expect(run.indexOf('id="messages"')).toBeLessThan(run.indexOf('id="agent-steps"'));
    expect(run.indexOf('id="agent-steps"')).toBeLessThan(run.indexOf('id="answer-meta"'));
  });
  it('extensions markup never mounts run/steps/You nodes', () => {
    const h = html();
    const ext = h.slice(h.indexOf('id="extensions"'), h.indexOf('id="extensions"') + 400);
    for (const s of ['run-chips', 'agent-steps', 'you-label', '>You<']) expect(ext).not.toContain(s);
    const src = appJs();
    const start = src.indexOf('function renderExtensions');
    const end = src.indexOf('function extRecords');
    const body = src.slice(start, end);
    for (const s of ['agent-steps', 'run-chips', 'you-label', 'you-prompt', 'msg user']) {
      expect(body).not.toContain(s);
    }
  });
});

describe('view-slash handler: before router/agent, cleared, palette hidden', () => {
  it('routes /extensions /settings /history /log with mocks, no submit/router/agent', () => {
    const cases: Array<[string, string]> = [
      ['/extensions', 'openExtensions'],
      ['/settings', 'openSettings'],
      ['/history', 'openHistory'],
      ['/log', 'openLog'],
    ];
    for (const [trigger, winner] of cases) {
      const calls: Record<string, number> = {};
      const input = { value: trigger + ' leftover' };
      const ok = handleViewSlash(trigger, {
        clearInput: () => { input.value = ''; calls.clear = (calls.clear || 0) + 1; },
        hidePalette: () => { calls.hide = (calls.hide || 0) + 1; },
        openExtensions: () => { calls.openExtensions = (calls.openExtensions || 0) + 1; },
        openSettings: () => { calls.openSettings = (calls.openSettings || 0) + 1; },
        openHistory: () => { calls.openHistory = (calls.openHistory || 0) + 1; },
        openLog: () => { calls.openLog = (calls.openLog || 0) + 1; },
      });
      expect(isViewSlash(trigger)).toBe(true);
      expect(ok).toBe(true);
      expect(input.value).toBe('');
      expect(calls.clear).toBe(1);
      expect(calls.hide).toBe(1);
      expect(calls[winner]).toBe(1);
      for (const k of ['openExtensions', 'openSettings', 'openHistory', 'openLog']) {
        if (k !== winner) expect(calls[k] || 0).toBe(0);
      }
    }
    expect(isViewSlash('/model')).toBe(false);
    expect(handleViewSlash('/model', {
      clearInput: () => { throw new Error('must not clear'); },
      hidePalette: () => { throw new Error('must not hide'); },
      openExtensions: () => { throw new Error('x'); },
      openSettings: () => { throw new Error('x'); },
      openHistory: () => { throw new Error('x'); },
      openLog: () => { throw new Error('x'); },
    })).toBe(false);
  });
  it('shared handler never touches submit/router/agent', () => {
    const src = read('src/shared/view.ts');
    const body = src.slice(src.indexOf('export function handleViewSlash'));
    for (const s of ['submit', 'router', 'agentStart', 'nexio.send', 'startAgentRun']) {
      expect(body).not.toContain(s);
    }
  });
  it('renderer handles view slashes before the run guard + footer stays view-only', () => {
    const src = appJs();
    const early = src.indexOf('View-only slashes work during a run');
    const guard = src.indexOf('if (agentRunning() && !submitOpts.queued && !submitOpts.taskAction) return; // foreground busy');
    expect(early).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(early);
    for (const t of ['/extensions', '/settings', '/history', '/log', '/tasks']) expect(src.slice(early, guard)).toContain(t);
    const extLine = src.slice(src.indexOf("if ($('btn-ext'))"), src.indexOf('Launcher (appended)'));
    for (const s of ['nexio.send', 'agentStart', 'slashResolve']) expect(extLine).not.toContain(s);
  });
});

describe('view store: run -> ext -> Back intact, chip, no double', () => {
  it('defaultView is idle|run', () => {
    expect(defaultView(false)).toBe('idle');
    expect(defaultView(true)).toBe('run');
  });
  it('run -> extensions -> Back returns to the intact run', () => {
    const runMsgs = ['hello'];
    let s = { view: 'run' as const, returnTo: 'idle' as const };
    s = openView(s, 'extensions');
    expect(s).toEqual({ view: 'extensions', returnTo: 'run' });
    expect(runMsgs.length).toBe(1); // transitions never touch content
    expect(goBack(s, true).view).toBe('run');
    expect(goBack(s, false).view).toBe('idle'); // cleared run falls back
  });
  it('footer chip: Running/View -> Done/View, hidden on the run, never duplicated', () => {
    expect(runChipLabel(true, false, false)).toBe('Running / View');
    expect(runChipLabel(false, true, false)).toBe('Done / View');
    expect(runChipLabel(true, true, true)).toBeNull();
    expect(runChipLabel(false, true, true)).toBeNull();
    expect(runChipLabel(false, false, false)).toBeNull();
    const h = html();
    expect(h.split('id="btn-runview"').length - 1).toBe(1);
    // chip DOM (dot + Done | View) rebuilds only on state change, never per tick
    const src = appJs();
    const chip = src.slice(src.indexOf('function updateRunChip'), src.indexOf("if ($('btn-runview'))"));
    expect(chip).toContain("$('btn-runview')");
    expect(chip).toContain('btn.dataset.rstate');
    expect(chip).toContain("className = 'rundot'");
    expect(chip).toContain("className = 'runsep'");
    expect(chip).toContain('Run finished. View result');
    expect(chip).not.toContain('Running / View');
    expect(chip).not.toContain('Done / View');
    const chips = src.slice(src.indexOf('function renderRunChips'), src.indexOf('async function startUndoRun'));
    expect(chips.indexOf(".remove()")).toBeLessThan(chips.indexOf('createElement'));
  });
});

describe('e2e-fake: fresh shows no Planning, slow run shows the chip', () => {
  it('planning exists only while active with zero tool steps', () => {
    expect(shouldShowPlanning(false, 0)).toBe(false); // fresh: never mount on empty
    expect(shouldShowPlanning(true, 0)).toBe(true); // slow run: spinner narration
    expect(shouldShowPlanning(true, 2)).toBe(false); // steps replace it
    expect(shouldShowPlanning(false, 2)).toBe(false); // done: removed
    expect(runChipLabel(true, false, false)).toBe('Running / View');
  });
  it('renderer: spinner -> steps -> removed, fail expanded, height via resize IPC', () => {
    const src = appJs();
    expect(src).toContain("document.querySelector('#agent-steps .plan-row')");
    const done = src.slice(src.indexOf("ev.type === 'done'"), src.indexOf("ev.type === 'done'") + 400);
    expect(done).toContain('.plan-row');
    expect(done).toContain('remove()');
    expect(done).toContain('collapseSteps()');
    const err = src.slice(src.indexOf("ev.type === 'error'"), src.indexOf("ev.type === 'error'") + 800);
    expect(err).toContain('.plan-row');
    expect(err).toContain('remove()');
    expect(err).toContain('finalizeSpinners()');
    expect(err).toContain('addErrorRow(');
    expect(err).toContain('expandSteps()');
    expect(err).toContain('endAgentRun()');
    const stop = src.slice(src.indexOf("ev.type === 'stopped'"), src.indexOf("ev.type === 'stopped'") + 400);
    expect(stop).toContain('expandSteps()');
    const steps = src.slice(src.indexOf('function syncSteps'), src.indexOf('function renderRunChips'));
    expect(steps).toContain('if (!rows)');
    expect(src).toContain('window.nexio.resize(h)');
  });
});

describe('memory view: single-view mount, list/filter/edit/pin/forget, empty state', () => {
  it('declares no duplicate top-level functions (later defs would shadow earlier ones)', () => {
    const src = appJs();
    const names = [...src.matchAll(/^function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
  it('mounts exactly one memory node with tabs, search, list, form and add', () => {
    const h = html();
    expect(h.split('id="memory"').length - 1).toBe(1);
    const mem = h.slice(h.indexOf('id="memory"'), h.indexOf('id="memory"') + 3000);
    expect(mem).toContain('id="btn-memory-back"');
    for (const t of ['data-mk="all"', 'data-mk="preference"', 'data-mk="fact"', 'data-mk="folder_rule"', 'data-mk="procedure"', 'data-mk="episode"']) {
      expect(mem).toContain(t);
    }
    for (const id of ['id="mem-search"', 'id="mem-list"', 'id="mem-form"', 'id="btn-mem-add"', 'id="mem-empty"', 'id="mem-review"']) {
      expect(mem).toContain(id);
    }
    const src = appJs();
    expect(src).toContain("$('memory').classList.toggle('hidden', name !== 'memory')");
  });
  it('lists, filters, edits, pins and forgets through the memory channel', () => {
    const src = appJs();
    for (const fn of ['function openMemoryView', 'function renderMemoryView', 'function memRow(', 'function renderMemForm', 'function renderMemoryUsed', 'function renderMemoryPush']) {
      expect(src).toContain(fn);
    }
    expect(src).toContain("memCall({ action: 'list'");
    expect(src).toContain("memCall({ action: 'forget', id:");
    expect(src).toContain("memCall({ action: 'update', id:");
    expect(src).toContain('enforced-badge');
    expect(src).toContain('scope-chip');
    // no native selects in the memory form (seg buttons for kind)
    const form = src.slice(src.indexOf('function renderMemForm'), src.indexOf('function memPrivacyNotice'));
    expect(form).toContain('mem-kind-seg');
    expect(form).not.toContain('createElement(\'select\')');
  });
  it('run-view rows: Used N memories (collapsed), Remembered with Undo/Edit, suggestions with Save/Dismiss', () => {
    const src = appJs();
    expect(src).toContain('function renderMemoryUsed');
    expect(src).toContain("t('memory.used'");
    expect(src).toContain("t('memory.usedOne')");
    expect(src).toContain("t('memory.remembered'");
    expect(src).toContain("t('memory.askSave'");
    expect(src).toContain('memory.replacePrompt');
    expect(src).toContain('memory.notSaved');
    // memory_used never adopts a run; pushes attach under the answer
    expect(src).toContain("if (event.type === 'memory_used') return void renderMemoryUsed(runId, event)");
    expect(src).toContain('function memoryHost');
  });
  it('one-tap row: memory_search makes no step, real tools get labels', () => {
    const src = appJs();
    // suppressed before any row exists; results skipped too; ids cleared per run
    expect(src).toContain("if (ev.tool === 'memory_search') { memSuppressed.add(ev.id); return; }");
    expect(src).toContain('if (memSuppressed.has(ev.id)) { memSuppressed.delete(ev.id); agentScroll(); return; }');
    expect(src).toContain('memSuppressed.clear()');
    expect(src).toContain("fs_read: 'Read file'");
    expect(src).toContain("shell_run: 'Ran command'");
    expect(src).toContain('title="${esc(ev.tool)}"');
    // one-tap row with Save / Not now and the master-off turn-on flow
    expect(src).toContain('function renderOneTapRow');
    expect(src).toContain("t('memory.askSave'");
    expect(src).toContain('memory.turnOnAsk');
    expect(src).toContain('memoryEnabled: true');
    expect(src).toContain("memCall({ action: 'dismiss', hash: ev.hash })");
  });
  it('sr-only announcements go through the single live region', () => {
    const src = appJs();
    const say = src.slice(src.indexOf('function say('), src.indexOf('function say(') + 200);
    expect(say).toContain('attach-live');
    expect(src).toContain("t('memory.savedSr')");
    expect(src).toContain("t('memory.remembered'");
  });
  it('slash commands clear input and never route: /memory /remember /forget /incognito', () => {
    const src = appJs();
    expect(src).toContain("if (trigger === '/memory')");
    expect(src).toContain('function runRememberCommand');
    expect(src).toContain('function runForgetCommand');
    expect(src).toContain('function runIncognitoCommand');
    expect(src).toContain("if (early === '/memory') return void openMemoryView()");
  });
  it('settings Memory section, onboarding single screen, incognito badge', () => {
    const h = html();
    for (const id of ['id="set-mem"', 'id="set-mem-kinds"', 'id="set-mem-suggest"', 'id="set-mem-semantic"', 'id="set-mem-ask"', 'id="set-incognito"', 'id="mem-info"', 'id="btn-mem-export"', 'id="btn-mem-forgetall"', 'id="mem-import-text"', 'id="incog-badge"']) {
      expect(h).toContain(id);
    }
    const src = appJs();
    expect(src).not.toContain('var OB_STEPS = ');
    expect(src).not.toContain('ob-progress');
    expect(src).toContain('onboard.title');
    expect(src).toContain('memoryOneTap === false');
    expect(src).toContain('function paintIncognito');
    // settings status line reflects the three states
    expect(src).toContain('On: asks before saving');
    expect(src).toContain('On: only when I say remember');
  });
});
describe('settings: one switch row per boolean, helper notes, chips, footer chip', () => {
  it('every boolean setting renders a visible track (root cause: hidden input, track span missing)', () => {
    const h = html();
    // all sixteen boolean rows carry the paint span; the native input is always hidden by CSS
    const tracks = h.split('switch-track" aria-hidden').length - 1;
    expect(tracks).toBe(16);
    for (const id of ['set-sendtemp', 'set-askread', 'set-reqapprove', 'set-mem', 'set-mem-suggest',
      'set-mem-semantic', 'set-mem-ask', 'set-incognito', 'set-login', 'set-hideblur', 'set-compact',
      'set-localtext',
      'set-task-subtasks', 'set-task-asksub', 'set-task-confirm', 'set-task-notify']) {
      const at = h.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(-1);
      expect(h.slice(at, at + 400)).toContain('switch-track');
    }
    const css = read('src/renderer/styles.css');
    // OFF track is a visible pill, not transparent-on-surface
    expect(css).toContain('background: var(--border); border: 1px solid var(--border); position: relative;');
    expect(css).toContain('.fld.check input:focus-visible + .switch-track');
  });
  it('MCP empty note is plain helper text with an Extensions link, never a code box', () => {
    const src = appJs();
    expect(src).toContain("note.className = 'form-note'");
    expect(src).toContain("link.className = 'textlink'");
    expect(src).toContain('void openExtensions()');
    expect(src).not.toContain('No MCP tools known — start a server in Extensions to browse them.</span>');
    const css = read('src/renderer/styles.css');
    expect(css).toContain('.form-note { font-size: 12px;');
    expect(css).not.toMatch(/\.form-note \{[^}]*mono/i);
  });
  it('memory kinds are checkbox chips with two visible states, no pills', () => {
    const src = appJs();
    expect(src).toContain("lab.className = 'chip-toggle'");
    expect(src).toContain('chip-check');
    expect(src).toContain('toLocaleLowerCase');
    expect(src).toContain('aria-disabled');
    expect(src).not.toContain("lab.className = 'fld check';\n    lab.innerHTML = `<span class=\"switch-tx\"");
    const css = read('src/renderer/styles.css');
    expect(css).toContain('.chip-toggle { height: 32px;');
    expect(css).toContain('.chip-toggle input:checked + .chip-tx');
    expect(css).toContain('.chip-group { display: flex; flex-wrap: wrap; gap: 8px;');
    expect(css).not.toMatch(/\.chip-toggle[^{]*\{[^}]*opacity:\s*\.5/);
    // save path untouched: hidden inputs keep data-memkind
    expect(src).toContain("box.dataset.memkind = k;");
    expect(src).toContain("input[data-memkind]");
  });
  it('settings sections stack with titles and 20px groups; footer never covers content', () => {
    const h = html();
    expect(h).toContain('class="set-section"');
    expect(h).toContain('class="set-title">Ask mode');
    expect(h).toContain('class="set-title">Memory');
    expect(h).toContain('class="group"');
    const css = read('src/renderer/styles.css');
    expect(css).toContain('#settings { display: flex; flex-direction: column; gap: calc(20px * var(--space-scale)); }');
    expect(css).toContain('#settings .group { display: flex; flex-direction: column; gap: 8px; }');
  });
});
describe('footer: always-visible panel shell, once, send disabled when empty', () => {
  it('renders exactly once, outside .view, after it, as .f-hints + .f-actions', () => {
    const h = html();
    expect(h.split('<footer').length - 1).toBe(1);
    expect(h.split('id="hints"').length - 1).toBe(1);
    const viewOpen = h.indexOf('id="view"');
    const footerOpen = h.indexOf('<footer');
    expect(footerOpen).toBeGreaterThan(viewOpen);
    // no per-view footer copies: every view section starts before the single footer
    for (const id of ['id="run"', 'id="settings"', 'id="history"', 'id="extensions"', 'id="onboard"']) {
      expect(h.indexOf(id)).toBeLessThan(footerOpen);
    }
    const foot = h.slice(footerOpen, h.indexOf('</footer>'));
    expect(foot).toContain('class="f-hints"');
    expect(foot).toContain('class="f-actions"');
    expect(foot.indexOf('f-hints')).toBeLessThan(foot.indexOf('f-actions'));
    // right-side icon group present in the single copy
    for (const id of ['id="btn-ext"', 'id="btn-history"', 'id="btn-settings"', 'id="btn-attach"', 'id="btn-send"']) {
      expect(foot).toContain(id);
    }
  });
  it('hints are single cap+label units; badge + separator lead, Ask-only', () => {
    const h = html();
    const foot = h.slice(h.indexOf('<footer'), h.indexOf('</footer>'));
    // each hint pairs one .k cap with its label inside .hint
    expect(foot).toContain('<span class="hint" id="hint-tab"><span class="k">Tab</span><span>switch mode</span></span>');
    expect(foot).toContain('<span class="hint" id="hint-enter"><span class="k">Enter</span><span>run</span></span>');
    expect(foot).toContain('<span class="hint" id="hint-esc">');
    // badge carries the label, separator follows it, both hidden in Do
    expect(foot).toContain('class="badge hidden" id="hint-readonly" aria-label="Ask mode is read-only"');
    expect(foot).toContain('class="f-sep hidden" id="hint-sep"');
    expect(foot.indexOf('hint-readonly')).toBeLessThan(foot.indexOf('hint-sep'));
    expect(foot.indexOf('hint-sep')).toBeLessThan(foot.indexOf('hint-nav'));
    const src = appJs();
    expect(src).toContain("sep.classList.toggle('hidden', !isChat)");
  });
  it('settings button shows the gear, not the sun', () => {
    const h = html();
    expect(h.split('id="btn-settings"').length - 1).toBe(1);
    // Lucide settings gear (cog path + r=3 circle), 18px / stroke 1.8 like the other footer icons
    expect(h).toContain('M12.22 2h-.44a2 2 0 0 0-2 2v.18');
    expect(h).toContain('<circle cx="12" cy="12" r="3"/>');
    // old sun/brightness glyph gone everywhere (dark-only UI, no theme toggle)
    expect(h).not.toContain('M12 2.8v3');
    const src = appJs();
    expect(src).not.toContain('M12 2.8v3');
  });
  it('no view or mode switch ever hides it (idle/palette/run/settings/extensions/history, chat+agent)', () => {
    const src = appJs();
    expect(src).not.toMatch(/\$\('hints'\)\)\.classList/);
    for (const line of src.split('\n')) {
      if (line.includes('hints') && !line.includes('hint-')) expect(line).not.toContain('hidden');
    }
    for (const fn of ['function showView', 'function updateModeUI', 'function syncChrome']) {
      const start = src.indexOf(fn);
      const end = src.indexOf('function ', start + 10);
      const body = end === -1 ? src.slice(start) : src.slice(start, end);
      expect(body).not.toMatch(/hints['"]?\)\)?\.(classList\.toggle|classList\.add|remove\(\))/);
    }
  });
  it('idle hints read Tab/Enter/Esc-close, typing keeps Enter-run/Esc-clear', () => {
    const src = appJs();
    expect(src).toContain("escLabel = (hasInput || hasAttach || hasMsgs) ? 'clear' : 'close'");
    // one state machine for both modes: Tab only empty + focused + idle,
    // Esc everywhere except runs (Stop owns the cap there)
    expect(src).toContain("else if (id === 'hint-tab') el.classList.toggle('hidden', quiet || !empty || !focused);");
    expect(src).toContain("$('hint-esc')) $('hint-esc').classList.toggle('hidden', running);");
  });
  it('send disables while input and attachments are empty', () => {
    const src = appJs();
    const start = src.indexOf('function syncChrome');
    const body = src.slice(start, src.indexOf('renderPalette = function'));
    expect(body).toContain("sendEmpty = !inputEl.value && attachPending() === 0");
    expect(body).toContain('sendBtn.disabled = sendEmpty');
    expect(body).toContain('aria-disabled');
  });
  it('footer metrics: control-h + 2*inset, divider top, groups, caps, buttons, never scrolled away', () => {
    const css = read('src/renderer/styles.css');
    const block = css.slice(css.indexOf('#hints {'), css.indexOf('#hints {') + 400);
    expect(block).toContain('min-height: calc(var(--control-h) + 2 * var(--popup-inset))');
    expect(block).toContain('padding: var(--popup-inset)');
    expect(block).toContain('1px solid var(--divider)');
    expect(block).toContain('flex: none');
    expect(block).toContain('white-space: nowrap');
    expect(css).toContain('.f-hints { display: flex; align-items: center; gap: 14px; min-width: 0; overflow: hidden; }');
    expect(css).toContain('.f-actions { margin-inline-start: auto; display: flex; align-items: center; gap: 4px; flex: none; }');
    expect(css).toContain('.hint { display: inline-flex; align-items: center; gap: 6px;');
    expect(css).toContain('.badge { display: inline-flex; align-items: center; gap: 6px; height: 22px;');
    expect(css).toContain('.f-sep { width: 1px; height: 14px; background: var(--divider);');
    expect(css).toContain('height: 20px; padding: 0 6px;');
    // disabled send: surface + border + muted, never opacity or darkened accent
    const dis = css.slice(css.indexOf('.fbtn.send:disabled'), css.indexOf('.fbtn.send:disabled') + 200);
    expect(dis).toContain('var(--surface)');
    expect(dis).toContain('var(--border)');
    expect(dis).toContain('var(--muted)');
    expect(dis).not.toContain('opacity');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('prefers-reduced-motion');
    // .view stays the only scroller; footer is in-flow after it so resize includes it
    expect(css).toMatch(/\.view \{[^}]*flex: 1/);
    const src = appJs();
    expect(src).toContain("panel.scrollHeight");
  });
});
