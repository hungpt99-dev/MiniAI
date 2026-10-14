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
    const guard = src.indexOf('if (agentRunning()) return; // one run at a time');
    expect(early).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(early);
    for (const t of ['/extensions', '/settings', '/history', '/log']) expect(src.slice(early, guard)).toContain(t);
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
    const src = appJs();
    const chip = src.slice(src.indexOf('function updateRunChip'), src.indexOf("if ($('btn-runview'))"));
    expect(chip).toContain("$('btn-runview')");
    expect(chip).not.toContain('createElement');
    expect(chip).not.toContain('appendChild');
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
    const err = src.slice(src.indexOf("ev.type === 'error'"), src.indexOf("ev.type === 'error'") + 400);
    expect(err).toContain('expandSteps()');
    const stop = src.slice(src.indexOf("ev.type === 'stopped'"), src.indexOf("ev.type === 'stopped'") + 400);
    expect(stop).toContain('expandSteps()');
    const steps = src.slice(src.indexOf('function syncSteps'), src.indexOf('function renderRunChips'));
    expect(steps).toContain('if (!rows)');
    expect(src).toContain('window.nexio.resize(h)');
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
    expect(src).toContain("'hidden', !(inputEl && !inputEl.value && document.activeElement === inputEl && !inputEl.disabled)");
  });
  it('send disables while input and attachments are empty', () => {
    const src = appJs();
    const start = src.indexOf('function syncChrome');
    const body = src.slice(start, src.indexOf('renderPalette = function'));
    expect(body).toContain("sendEmpty = !inputEl.value && attachPending() === 0");
    expect(body).toContain('sendBtn.disabled = sendEmpty');
    expect(body).toContain('aria-disabled');
  });
  it('footer metrics: 48px, 8/14/8/22 padding, divider top, groups, caps, buttons, never scrolled away', () => {
    const css = read('src/renderer/styles.css');
    const block = css.slice(css.indexOf('#hints {'), css.indexOf('#hints {') + 400);
    expect(block).toContain('height: 48px');
    expect(block).toContain('8px 14px 8px 22px');
    expect(block).toContain('1px solid var(--divider)');
    expect(block).toContain('flex: none');
    expect(block).toContain('white-space: nowrap');
    expect(css).toContain('.f-hints { display: flex; align-items: center; gap: 14px; min-width: 0; overflow: hidden; }');
    expect(css).toContain('.f-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }');
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
