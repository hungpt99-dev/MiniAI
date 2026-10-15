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
    expect(c).toContain('#run { padding-top: 12px; }');
    expect(c).toContain('.turn { display: flex; flex-direction: column; gap: 8px;');
    expect(c).toContain('.mode-div { display: flex; align-items: center; gap: 12px; margin: 16px 0; }');
    expect(c).toContain('.mode-div .mode-line { flex: 1; height: 1px; background: var(--divider); }');
    expect(c).toContain('.mode-div .mode-text { font-size: 12px; font-weight: 400; color: var(--muted);');
    expect(c).toContain('.you-prompt { font-size: 14px; color: var(--text-soft);');
    expect(c).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.6; font-weight: 400; }');
  });
});

describe('scroll: padding, autoscroll-unless-up, jump button', () => {
  it('jump control exists, wired, and gated to the run view', () => {
    expect(html()).toContain('id="jump-latest"');
    expect(html()).toContain('aria-label="Jump to latest"');
    const src = appJs();
    expect(src).toContain('var userScrolledUp = false;');
    expect(src).toContain('function syncJump()');
    expect(src).toContain("view !== 'run'");
    expect(src).toContain('scrollHeight - el.scrollTop - el.clientHeight > 120');
    expect(src).toContain('function scrollToLatest(force)');
    const c = css();
    expect(c).toContain('#jump-latest { position: absolute;');
    expect(c).toContain('bottom: 60px;');
  });
  it('streaming respects a scrolled-up reader; user turns always show', () => {
    const src = appJs();
    expect(src).toContain('if (userScrolledUp) { syncJump(); return; }');
    expect(src).toContain('if (role === \'user\') userScrolledUp = false;');
    expect(src).toContain('scrollToLatest(role === \'user\')');
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
    expect(c).toContain('.switch-do-row { margin-top: 8px; }');
  });
});

describe('mode consistency: pill, footer, placeholder, divider', () => {
  it('setMode marks the seam and keeps chrome in sync', () => {
    const src = appJs();
    const setMode = slice(src, 'function setMode(m, persist)', 'function updateModeUI()');
    expect(setMode).toContain('className = \'msg mode-div\'');
    expect(setMode).toContain('hasRun()');
    expect(setMode).toContain("t('mode.switchedDo')");
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
    const setMode = slice(src, 'function setMode(m, persist)', 'function updateModeUI()');
    expect(setMode).toContain("role', 'separator'");
    expect(setMode).toContain('mode-line');
    expect(setMode).toContain('mode-text');
    expect(setMode).toContain('hasRun()');
    const c = css();
    expect(c).toContain('.mode-div { display: flex; align-items: center; gap: 12px; margin: 16px 0; }');
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
