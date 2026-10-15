import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');
const css = () => read('src/renderer/styles.css');
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + 1);
  return src.slice(a, b === -1 ? undefined : b);
};

describe('turns: one block per { You, answer }, windowed at 100', () => {
  it('submit paths open a turn; history groups pairs; clears reset', () => {
    const src = appJs();
    expect(src).toContain('function startTurn()');
    expect(src).toContain('function startTurnQuiet()');
    expect(src).toContain('var MAX_TURNS = 100;');
    expect(src).toContain('currentTurn = null;');
    // every submit path groups its rows
    expect(src).toContain('startTurn();');
    expect(src).toContain('startTurnQuiet();');
    expect(src).toContain('if (m.role === \'user\') startTurnQuiet();');
    expect(src).toContain('function pruneTurns()');
    expect(src).toContain(':scope > .turn');
  });
  it('last answer marked; shared meta moves under hovered/focused earlier answers', () => {
    const src = appJs();
    expect(src).toContain('function markLastAnswer()');
    expect(src).toContain("classList.add('last')");
    expect(src).toContain('function placeAnswerMeta(anchor)');
    expect(src).toContain('anchor.after(meta)');
    expect(src).toContain('runHost.appendChild(meta)');
    expect(src).toContain("addEventListener('mouseover'");
    expect(src).toContain("addEventListener('focusin'");
    expect(src).toContain('relatedTarget');
  });
  it('turn rhythm in CSS, quiet separator, regular weights only', () => {
    const c = css();
    expect(c).toContain('.turn { display: flex; flex-direction: column; gap: calc(6px * var(--space-scale));');
    expect(c).toContain('.mode-div { display: flex; align-items: center;');
    expect(c).toContain('margin: 0; padding: calc(2px * var(--space-scale)) 0;');
    expect(c).toContain('.mode-div .mode-line { flex: 1; height: 1px; background: var(--divider); }');
    expect(c).toContain('.mode-div .mode-text { font-size: 12px; font-weight: 400; color: var(--muted);');
    expect(c).toContain('.you-prompt { font-size: 14px; line-height: 20px;');
    expect(c).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.5; font-weight: 400; margin-top: 2px; }');
  });
});

describe('scroll: padding, follow-bottom, jump button', () => {
  it('jump control exists, wired, and gated to the run view', () => {
    expect(html()).toContain('id="jump-latest"');
    expect(html()).toContain('aria-label="Jump to latest message"');
    // sibling of the scroller (never inside scrolling content), pinned above the footer
    const h = html();
    expect(h.indexOf('id="jump-latest"')).toBeGreaterThan(h.indexOf('id="view"'));
    expect(h).toContain('data-i18n="action.jumpLatest"');
    const src = appJs();
    expect(src).toContain('var followBottom = true;');
    expect(src).toContain('function syncJump()');
    expect(src).toContain("view !== 'run'");
    expect(src).toContain('distToBottom(el) <= 48');
    expect(src).toContain('function scrollToLatest(force)');
    expect(src).toContain('function onViewScroll()');
    const c = css();
    expect(c).toContain('#jump-latest { position: absolute;');
    expect(c).toContain('inset-inline-end: 16px; bottom: 56px;');
    expect(c).toContain('height: 32px;');
  });
  it('streaming respects a scrolled-up reader; user turns always show', () => {
    const src = appJs();
    expect(src).toContain('if (!followBottom) { syncJump(); return; }');
    expect(src).toContain('if (role === \'user\') followBottom = true;');
    expect(src).toContain('scrollToLatest(role === \'user\')');
    // programmatic sets are echo-guarded; only user input writes followBottom
    expect(src).toContain('var progScroll = false;');
    expect(src).toContain('var lastSetTop = -1;');
    // growth follows after layout, instantly (never smooth)
    expect(src).toContain('new ResizeObserver(');
    expect(src).toContain('requestAnimationFrame(() => { if (followBottom) scrollBottomNow(); });');
  });
});

describe('switch-to-Do chip: Ask action-plausible answers only', () => {
  it('done branch gates on isActionLike and renders a sibling row', () => {
    const src = appJs();
    expect(src).toContain('function isActionLike(text)');
    expect(src).toContain('function doSwitchRow(promptText)');
    const done = slice(src, "} else if (ev.type === 'done')", "} else if (ev.type === 'error')");
    expect(done).toContain('isActionLike(lastAskPrompt)');
    expect(done).toContain('st.answerDiv.after(row)');
    expect(done).not.toContain('appendChild(switchToDoChip');
    expect(src).toContain("setAttribute('aria-label', 'Switch to Do and run this')");
    expect(src).toContain("btn.closest('.switch-do-row')?.remove()");
  });
  it('chip goes away on click and on switching to Do', () => {
    const src = appJs();
    expect(src).toContain("querySelectorAll('.switch-do-row')");
    const setMode = slice(src, 'function setMode(m, persist)', 'function updateModeUI()');
    expect(setMode).toContain('.switch-do-row');
    const c = css();
    expect(c).toContain('.switch-do-row { margin-top: calc(8px * var(--space-scale)); }');
  });
});

describe('mode consistency: pill, footer, placeholder, divider', () => {
  it('setMode toggles nothing into the conversation; dividers are lazy and derived', () => {
    const src = appJs();
    const setMode = slice(src, 'function setMode(m, persist)', '// --- lazy mode dividers');
    expect(setMode).not.toContain('msg mode-div');
    expect(setMode).not.toContain('hasRun()');
    expect(setMode).toContain('maybeModeDivider');
    expect(src).toContain('function maybeModeDivider(newMode)');
    expect(src).toContain('function normalizeDividers()');
    expect(src).toContain('function modeDividerEl(st)');
    const ui = slice(src, 'function updateModeUI()', '// why: autosize composer');
    expect(ui).toContain('tab-chat');
    expect(ui).toContain('hint-readonly');
    expect(ui).toContain('composer.placeholder');
    for (const tag of ['en', 'vi']) {
      const dict = JSON.parse(read(`src/main/i18n/locales/${tag}.json`));
      expect(typeof dict['mode.switchedDo']).toBe('string');
      expect(typeof dict['mode.switchedAsk']).toBe('string');
    }
  });
});

describe('mode divider: quiet separator, both directions', () => {
  it('renders lines + muted label with separator role, never a heading', () => {
    const src = appJs();
    expect(src).toContain('function modeDividerEl(st)');
    expect(src).toContain("role', 'separator'");
    expect(src).toContain('mode-line');
    expect(src).toContain('mode-text');
    // lazy: one divider before a differently-moded message, never two in a row
    expect(src).toContain('lastMsgMode()');
    expect(src).toContain('prev === newMode');
    expect(src).toContain('normalizeDividers()');
    // rows carry their turn mode; history derives dividers from stored modes
    expect(src).toContain('dataset.mode');
    expect(src).toContain('maybeModeDivider(m.mode)');
    const c = css();
    expect(c).toContain('.mode-div { display: flex; align-items: center;');
    expect(c).toContain('margin: 0; padding: calc(2px * var(--space-scale)) 0;');
    expect(c).toContain('.mode-div .mode-line { flex: 1; height: 1px; background: var(--divider); }');
    expect(c).toContain('.mode-div .mode-text { font-size: 12px; font-weight: 400; color: var(--muted);');
    expect(c).not.toContain('.mode-div { text-align: center;');
  });
});

describe('footer hints: Ask never queues, Tab/Esc follow one rule', () => {
  it('queue hint hidden in Ask in every footer state', () => {
    const src = appJs();
    expect(src).toContain("if (id === 'hint-queue' && askMode) el.classList.add('hidden')");
    expect(src).toContain("if (queue && isChat) queue.classList.add('hidden'); // Ask never queues");
  });
  it('Tab/Esc visibility has no mode branch', () => {
    const src = appJs();
    const ui = slice(src, 'function updateModeUI()', '// why: autosize composer');
    expect(ui).not.toContain('hint-tab');
    expect(ui).not.toContain('hint-esc');
  });
  it('real provider/model label; friendly errors pass through untouched', () => {
    const src = appJs();
    expect(src).toContain("$('model-name').textContent = s.model;");
    expect(src).toContain("$('model-name').title = s.model;");
    // envelope + event fields reach the UI verbatim (mapping is main-side)
    expect(src).toContain('e.technical');
    expect(src).toContain('ev.technical');
  });
});

describe('packaging: test providers cannot ship', () => {
  it('builder file list excludes harnesses; no-fakes script covers markers', () => {
    const yml = read('electron-builder.yml');
    expect(yml).not.toMatch(/-\s+.*e2e\//);
    expect(yml).not.toMatch(/-\s+.*tests\//);
    const script = read('scripts/check-no-fakes.mjs');
    for (const m of ['Echo:', 'hello to you too', 'NEXIO_E2E']) {
      expect(script).toContain(m);
    }
    expect(script).toContain('e2e/');
  });
});

describe('registry: only real providers, unknown ids rejected', () => {
  it('adapter map holds the four real providers; settings validation rejects the rest', async () => {
    const { PROVIDER_ADAPTERS, getAdapter } = await import('../../src/main/ai/providers/index');
    expect(Object.keys(PROVIDER_ADAPTERS).sort()).toEqual(['anthropic', 'compatible', 'gemini', 'openai']);
    expect(() => (getAdapter as (p: string) => unknown)('echo')).toThrow();
    const { validateSettings, isKnownProvider } = await import('../../src/main/store/settings');
    expect(validateSettings({ provider: 'echo' } as never).length).toBeGreaterThan(0);
    expect(isKnownProvider('echo')).toBe(false);
    expect(isKnownProvider('openai')).toBe(true);
  });
});
describe('threading made explicit: follow-ups continue, spawns isolate', () => {
  it('scheduler tasks run with empty history; snapshots carry no messages', () => {
    const src = read('src/main/agent/taskRunner.ts');
    expect(src).toContain('history: []');
    const sch = read('src/main/ipc.ts');
    expect(sch).toContain('routeTaskSubmit');
  });
});
describe('failed message write: one error state, retry sends once', () => {
  const src = appJs();
  it('detects sqlite schema errors without matching normal text', () => {
    expect(src).toContain('function isDbWriteError(e)');
    expect(src).toContain('/no such column|has no column|');
    expect(src).toContain("t('send.saveError')");
  });
  it('drops the optimistic bubble and shows short error + Retry + Copy details', () => {
    expect(src).toContain('function dropLastUserBubble()');
    expect(src).toContain("querySelectorAll('.msg.user')");
    expect(src).toContain('function showSaveError(box, text, e)');
    expect(src).toContain("span.textContent = t('send.saveError')");
    expect(src).toContain("retry.textContent = 'Retry'");
    expect(src).toContain("copy.textContent = 'Copy details'");
    // retry removes the error box and sends exactly once (no second bubble)
    const start = src.indexOf('function showSaveError');
    const retry = src.slice(start, start + 1400);
    expect(retry).toContain('box.remove()');
    expect(retry.match(/void send\(\)/g)?.length).toBe(1);
    // prompt stays in the composer on every send failure
    expect(src).toContain('inputEl.value = text; // keep unsent input after failures');
  });
  it('wires every send catch through the save-error path (Ask plain/template/queued, Do direct)', () => {
    const hits = src.split('if (isDbWriteError(e)) { dropLastUserBubble(); showSaveError(assistantDiv, text, e); }').length - 1;
    expect(hits).toBe(3);
    expect(src).toContain('const dbWrite = isDbWriteError(e);');
    expect(src).toContain("message: dbWrite ? t('send.saveError')");
  });
  it('send.saveError is a translated key (en + vi)', () => {
    const en = JSON.parse(read('src/main/i18n/locales/en.json'));
    const vi = JSON.parse(read('src/main/i18n/locales/vi.json'));
    expect(en['send.saveError']).toBe("Couldn't save message");
    expect(vi['send.saveError']).toBeTruthy();
  });
});
