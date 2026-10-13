import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultView,
  openView,
  goBack,
  isEmpty,
  shouldShowPlanning,
} from '../../src/shared/view';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + 1);
  return src.slice(a, b === -1 ? undefined : b);
};
const empty = { msgCount: 0, toolCount: 0, active: false, attachCount: 0, inputEmpty: true };

describe('suggest component: idle-only gate across every non-empty dimension', () => {
  const maybe = () => slice(appJs(), 'function maybeSuggest()', 'async function renderSuggest');
  const render = () => slice(appJs(), 'async function renderSuggest(seq)',
    "if (!inputEl.value) maybeSuggest(); else hideSuggest();");
  const hide = () => slice(appJs(), 'function hideSuggest()', 'async function suggestList');
  it('idle: maybe + render both require the idle view', () => {
    expect(maybe()).toContain("view !== 'idle'");
    expect(render()).toContain("view !== 'idle'");
  });
  it('msg/run/tool: isEmptyUI counts messages, tool names and live runs', () => {
    const ui = slice(appJs(), 'function isEmptyUI()', '// Fail visibly');
    expect(ui).toContain('messagesEl.children.length');
    expect(ui).toContain('.tool-name');
    expect(ui).toContain('agentRunning()');
  });
  it('attach: tray exposes a pending getter wired into isEmptyUI', () => {
    const src = appJs();
    expect(src).toContain('window.attachPendingCount');
    expect(src).toContain('window.clearAttachTray');
    expect(slice(src, 'function isEmptyUI()', '// Fail visibly')).toContain('attachPending()');
    const add = slice(src, 'function addEntries(list)', 'function readFiles(');
    expect(add).toContain('hideSuggest');
  });
  it('typed: non-empty input blocks, clearing restores', () => {
    expect(slice(appJs(), 'function isEmptyUI()', '// Fail visibly')).toContain('!inputEl.value');
    expect(isEmpty({ ...empty, inputEmpty: false })).toBe(false);
    expect(isEmpty({ ...empty, inputEmpty: true })).toBe(true);
  });
  it('palette: hidden-gate both ways, never co-shown', () => {
    expect(maybe()).toContain("paletteEl.classList.contains('hidden')");
    expect(render()).toContain("paletteEl.classList.contains('hidden')");
    expect(slice(appJs(), 'renderPalette = function', 'const _hidePalette')).toContain('hideSuggest');
  });
  it('settings/ext/history: panels block, showView hides off idle, assert counts suggest', () => {
    expect(maybe()).toContain("view === 'settings'");
    expect(slice(appJs(), 'function showView(name)', '// dev-only')).toContain("if (name !== 'idle') hideSuggest()");
    expect(slice(appJs(), 'function assertSingleView()', 'function togglePanel')).toContain("'suggest'");
  });
  it('hide unmounts (innerHTML + hidden); render never unhides the view', () => {
    expect(hide()).toContain("box.innerHTML = ''");
    expect(hide()).toContain("classList.add('hidden')");
    expect(render()).not.toContain('$viewEl');
    const h = html();
    expect(h.indexOf('id="suggest"')).toBeLessThan(h.indexOf('id="view"')); // outside .view
  });
  it('race: suggestSeq invalidates stale timers and in-flight awaits', () => {
    const src = appJs();
    expect(src).toContain('var suggestSeq = 0');
    expect(maybe()).toContain('++suggestSeq');
    expect(hide()).toContain('suggestSeq');
    expect(render().split('seq !== suggestSeq').length - 1).toBeGreaterThanOrEqual(3);
  });
  it('pick: fills + focuses, never sends', () => {
    const r = render();
    expect(r).toContain('inputEl.value = text');
    expect(r).toContain('inputEl.focus()');
    for (const s of ['void send(', 'startAgentRun', 'nexio.send', 'agentStart']) expect(r).not.toContain(s);
  });
});

describe('view store: isEmpty across new/Esc/typing/clear', () => {
  it('isEmpty is true only when every dimension is empty', () => {
    expect(isEmpty(empty)).toBe(true);
    expect(isEmpty({ ...empty, msgCount: 1 })).toBe(false);
    expect(isEmpty({ ...empty, toolCount: 1 })).toBe(false);
    expect(isEmpty({ ...empty, active: true })).toBe(false);
    expect(isEmpty({ ...empty, attachCount: 1 })).toBe(false);
    expect(isEmpty({ ...empty, inputEmpty: false })).toBe(false);
  });
  it('isEmpty reuses shouldShowPlanning (active + zero-tool never reads empty)', () => {
    const src = read('src/shared/view.ts');
    expect(src.slice(src.indexOf('export function isEmpty'))).toContain('shouldShowPlanning');
    expect(shouldShowPlanning(true, 0)).toBe(true);
    expect(isEmpty({ ...empty, active: true })).toBe(false);
  });
  it('newChat resets input + attach, returns to idle, reschedules', () => {
    const n = slice(appJs(), 'async function newChat()', 'async function refreshHistory');
    for (const s of ["inputEl.value = ''", 'clearAttachTray', 'hideSuggest', "showView('idle')", 'maybeSuggest']) {
      expect(n).toContain(s);
    }
  });
  it('Esc clear resets input + attach, returns to idle, reschedules', () => {
    const e = slice(appJs(), '// Esc: results showing', '/* --- Agent mode');
    expect(e).toContain('if (hasRun())');
    for (const s of ["inputEl.value = ''", 'clearAttachTray', 'hideSuggest', "showView('idle')", 'maybeSuggest']) {
      expect(e).toContain(s);
    }
  });
  it('run -> ext -> Back returns intact; cleared runs fall back to idle', () => {
    let s = { view: 'run' as const, returnTo: 'idle' as const };
    s = openView(s, 'extensions');
    expect(goBack(s, true).view).toBe('run');
    expect(goBack(s, false).view).toBe('idle');
    expect(defaultView(false)).toBe('idle');
  });
});

describe('run: Ask renders no steps, Do runs the plan -> tools -> done lifecycle', () => {
  const step = () => slice(appJs(), "ev.type === 'step'", "ev.type === 'tool_call'");
  const done = () => slice(appJs(), "ev.type === 'done'", "ev.type === 'error'");
  const err = () => slice(appJs(), "ev.type === 'error'", "ev.type === 'stopped'");
  const stop = () => slice(appJs(), "ev.type === 'stopped'", 'syncSteps();');
  it('Ask streams with no plan row; senders switch to run explicitly', () => {
    expect(shouldShowPlanning(false, 0)).toBe(false);
    const stream = slice(appJs(), 'window.nexio.onStream((ev) => {', "window.addEventListener('focus'");
    expect(stream).not.toContain('plan-row');
    const send = slice(appJs(), 'async function sendInner()', 'window.nexio.onStream');
    expect(send).toContain("showView('run')");
    const add = slice(appJs(), 'function addMsg(role, content)', 'function copySvg');
    expect(add).not.toContain('showView'); // no Ask yank
    const appr = slice(appJs(), "ev.type === 'approval_request'", "ev.type === 'tool_result'");
    expect(appr).toContain("showView('run')"); // approval yank kept
  });
  it('Do step narrates once; first tool call replaces it', () => {
    expect(shouldShowPlanning(true, 0)).toBe(true);
    expect(shouldShowPlanning(true, 2)).toBe(false);
    expect(step()).toContain('plan-row');
    const tool = slice(appJs(), "ev.type === 'tool_call'", "ev.type === 'approval_request'");
    expect(tool).toContain('plan-row');
    expect(tool).toContain('remove()');
  });
  it('text/done/error/stopped all drop the plan row', () => {
    const text = slice(appJs(), "ev.type === 'text_delta'", "ev.type === 'done'");
    for (const body of [text, done(), err(), stop()]) {
      expect(body).toContain('plan-row');
      expect(body).toContain('remove()');
    }
  });
  it('done removes before finalizing (zero-tool keeps no checkmark), then collapses', () => {
    const d = done();
    expect(d.indexOf('plan-row')).toBeLessThan(d.indexOf('finalizeSpinners()'));
    expect(d.indexOf('finalizeSpinners()')).toBeLessThan(d.indexOf('collapseSteps()'));
    expect(err()).toContain('expandSteps()');
    expect(stop()).toContain('expandSteps()');
  });
});

describe('e2e-fake: fresh -> hello -> new -> tools', () => {
  it('walks the composer lifecycle on pure view state', () => {
    expect(isEmpty(empty)).toBe(true); // fresh: suggestions allowed, no Planning
    expect(shouldShowPlanning(empty.active, empty.toolCount)).toBe(false);
    const hello = { ...empty, msgCount: 2 }; // user + answer rendered
    expect(isEmpty(hello)).toBe(false);
    expect(isEmpty({ ...empty })).toBe(true); // /new resets to fresh
    expect(defaultView(false)).toBe('idle');
    const slow = { ...empty, active: true }; // Do run, tools pending
    expect(isEmpty(slow)).toBe(false);
    expect(shouldShowPlanning(slow.active, slow.toolCount)).toBe(true);
    const stepped = { ...slow, toolCount: 2 }; // tools replace narration
    expect(shouldShowPlanning(stepped.active, stepped.toolCount)).toBe(false);
    expect(isEmpty(stepped)).toBe(false);
    const finished = { msgCount: 2, toolCount: 2, active: false, attachCount: 0, inputEmpty: true };
    expect(isEmpty(finished)).toBe(false); // history stays, composer not fresh
    expect(shouldShowPlanning(finished.active, finished.toolCount)).toBe(false);
  });
});
