import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');
const css = () => read('src/renderer/styles.css');
const foot = () => {
  const h = html();
  return h.slice(h.indexOf('<footer'), h.indexOf('</footer>'));
};
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + 1);
  return src.slice(a, b === -1 ? undefined : b);
};

describe('answer meta: one row, never wraps', () => {
  it('meta CSS: flex, 8px gap, exactly 28px, no extra margin, nowrap children', () => {
    const c = css();
    const block = slice(c, '#answer-meta {', '#answer-meta #model-name');
    expect(block).toContain('display: flex');
    expect(block).toContain('gap: calc(8px * var(--space-scale))');
    expect(block).toContain('height: 28px; margin: 0; padding: 0;');
    expect(block).toContain('line-height: 1');
    expect(c).toContain('#answer-meta > * { white-space: nowrap;');
    expect(c).toContain('#answer-meta #model-name { min-width: 0;');
    expect(c).toContain('text-overflow: ellipsis');
    expect(c).toContain('max-width: 160px');
  });
  it('model label: accent dot + ellipsis + full-name tooltip', () => {
    const h = html();
    expect(h).toContain('<span id="model-name">');
    const src = appJs();
    const fn = slice(src, 'async function refreshModelName()', 'void refreshModelName();');
    expect(fn).toContain("$('model-name').title = s.model");
    expect(fn).toContain('.dot');
    // steps/memory toggles stay above in agent-steps, not in this row
    expect(src).toContain("steps.prepend(head)");
    expect(h.indexOf('id="agent-steps"')).toBeLessThan(h.indexOf('id="answer-meta"'));
  });
  it('actions sit right with 2px gaps; ghost spec kept', () => {
    const c = css();
    expect(c).toContain('#answer-meta #actions { display: flex; gap: 2px; margin-inline-start: auto;');
    expect(c).toContain('height: 28px;');
    expect(c).toContain('padding: 0 10px;');
    expect(c).toContain('border-radius: 8px;');
    expect(c).toContain('#answer-meta #actions button:hover');
    expect(c).toContain('background: var(--hover); color: var(--text);');
    expect(c).toContain('#answer-meta #actions button:focus-visible');
    expect(c).toContain('outline: 2px solid var(--accent); outline-offset: 2px;');
  });
  it('result rhythm: view-owned padding, 16px turns, 15px/1.5 answer, markdown sibling rule', () => {
    const c = css();
    expect(c).toContain('padding: calc(12px * var(--space-scale)) calc(22px * var(--space-scale)) calc(12px * var(--space-scale));');
    expect(c).toContain('#messages { display: flex; flex-direction: column; gap: calc(16px * var(--space-scale)); padding: 0; }');
    expect(c).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.5; font-weight: 400; margin-top: 2px; }');
    expect(c).toContain('.msg.assistant.answer > * + * { margin-top: calc(8px * var(--space-scale)); }');
  });
});

describe('More menu: two visible actions, the rest behind dots', () => {
  it('markup: copy + followup + more button + role=menu with three items', () => {
    const h = html();
    for (const id of ['btn-copy', 'btn-followup', 'btn-more', 'more-menu', 'btn-menu-newchat', 'btn-task-spawn', 'btn-task-queue']) {
      expect(h).toContain(`id="${id}"`);
    }
    const menu = h.slice(h.indexOf('id="more-menu"'), h.indexOf('id="more-menu"') + 2200);
    expect(menu).toContain('role="menu"');
    expect(menu).toContain('role="menuitem"');
    expect(menu).toContain('class="menu-hint"');
    const more = h.slice(h.indexOf('id="btn-more"'), h.indexOf('id="btn-more"') + 400);
    expect(more).toContain('aria-haspopup="menu"');
    expect(more).toContain('aria-expanded="false"');
    expect(more).toContain('aria-label="More actions"');
    expect(more).toContain('<circle cx="5" cy="12"');
  });
  it('menu styles: right-aligned surface card, flips up, 32px items with hints', () => {
    const c = css();
    expect(c).toContain('#more-menu { position: absolute;');
    expect(c).toContain('min-width: 220px;');
    expect(c).toContain('background: var(--surface);');
    expect(c).toContain('border: 1px solid var(--border);');
    expect(c).toContain('border-radius: 12px;');
    expect(c).toContain('padding: 4px;');
    expect(c).toContain('#more-menu.flip');
    expect(c).toContain('#answer-meta #actions #more-menu button { display: flex;');
    expect(c).toContain('height: 32px;');
    expect(c).toContain('#more-menu .menu-hint');
  });
  it('behavior: toggle, outside-click close, item clicks close, shortcuts untouched', () => {
    const src = appJs();
    expect(src).toContain('function openMoreMenu()');
    expect(src).toContain('function closeMoreMenu(refocus)');
    expect(src).toContain('function toggleMoreMenu()');
    expect(src).toContain('closeMoreMenuOutside');
    expect(src).toContain("aria-expanded', 'true'");
    // keyboard: arrows/home/end/esc/tab, focus returns to More
    expect(src).toContain("e.key === 'ArrowDown'");
    expect(src).toContain("e.key === 'ArrowUp'");
    expect(src).toContain("e.key === 'Home'");
    expect(src).toContain("e.key === 'End'");
    expect(src).toContain('closeMoreMenu(true)');
    expect(src).toContain('closeMoreMenu(false)');
    // capture-phase Esc dismisses the menu before run-clearing below
    const cap = slice(src, '// Esc: results showing', "if (agentRunning()) { // Esc stops");
    expect(cap).toContain("getElementById('more-menu')");
    expect(cap).toContain('closeMoreMenu(true)');
    // spawn/queue sends keep working without the menu
    expect(src).toContain("void send({ taskAction: 'spawn' })");
    expect(src).toContain('void send({ queued: true })');
    expect(src).toContain("trigger === '/spawn'");
    expect(src).toContain("trigger === '/queue'");
  });
  it('Ask mode: New chat visible instead of More; task items hidden', () => {
    const src = appJs();
    const fn = slice(src, 'function layoutAnswerActions()', 'function moreMenuItems()');
    expect(fn).toContain("mode === 'chat'");
    expect(fn).toContain('btn-newchat');
    expect(fn).toContain('btn-task-spawn');
    expect(fn).toContain('btn-task-queue');
    expect(src).toContain('updateModeUI');
    expect(fn).toContain('tasksAvailable()');
  });
  it('copy still confirms inline for 1.5s', () => {
    const src = appJs();
    expect(src).toContain("btn.innerHTML = copySvg() + 'Copied'");
    expect(src).toContain('setTimeout(() => { btn.innerHTML = orig; }, 1500)');
  });
});

describe('narrow widths: container-driven compact, then dot-only model', () => {
  it('hysteresis fit (no fixed breakpoints, no ping-pong) drives compact then minimal', () => {
    const src = appJs();
    expect(src).toContain('function fitAnswerMeta()');
    expect(src).toContain('function fitFooterHints()');
    expect(src).toContain('new ResizeObserver');
    expect(src).toContain('w < 420');
    expect(src).toContain('w > 460');
    expect(src).toContain('minimal never outlives compact');
    expect(src).toContain('fitAnswerMetaOnMode');
    const c = css();
    expect(c).toContain('#answer-meta #actions.compact button span { display: none; }');
    expect(c).toContain('#answer-meta #actions.compact button { width: 28px;');
    expect(c).toContain('#answer-meta.minimal #model-name { display: none; }');
  });
  it('icon-only buttons keep tooltips and names; layout uses logical props', () => {
    const h = html();
    expect(h).toContain('aria-label="Copy answer"');
    expect(h).toContain('aria-label="Follow up"');
    expect(h).toContain('title="Copy answer"');
    const c = css();
    expect(c).toContain('margin-inline-start: auto;');
    expect(c).toContain('padding-inline-start: 12px;');
    expect(c).toContain('inset-inline-end: 0;');
  });
});

describe('footer: three hints max, one queue cap pair, hide from the right', () => {
  it('queue hint is one cap pair plus the word', () => {
    const f = foot();
    expect(f).toContain('id="hint-queue"');
    expect(f).toContain('id="queue-cap-mod"');
    expect(f).not.toContain('<span class="k">Ctrl+Enter</span>');
    const src = appJs();
    expect(src).toContain("qm.textContent");
    expect(src).toContain("'Cmd'");
  });
  it('crowd-hide drops queue, clear, run, switch mode in order and never wraps', () => {
    const src = appJs();
    expect(src).toContain("['hint-queue', 'hint-esc', 'hint-enter', 'hint-tab']");
    expect(src).toContain('crowd-hide');
    expect(src).toContain('lastFooterKey');
    expect(src).toContain('fitFooterHints();');
    const c = css();
    expect(c).toContain('#hints .crowd-hide { display: none !important; }');
    expect(c).toContain('#hints .hint { display: inline-flex; align-items: center; gap: 6px;');
    expect(c).toContain('#hints .f-hints { display: flex; align-items: center; gap: 14px;');
    expect(c).toContain('#hints { display: flex;');
    expect(c).toContain('white-space: nowrap;');
  });
  it('icon group unchanged: extensions, history, tasks, settings, attach, send', () => {
    const f = foot();
    for (const id of ['btn-ext', 'btn-history', 'btn-tasks', 'btn-settings', 'btn-attach', 'btn-send']) {
      expect(f).toContain(`id="${id}"`);
    }
  });
});

describe('answer.more locale pair', () => {
  it('exists in en and vi', () => {
    for (const tag of ['en', 'vi']) {
      const dict = JSON.parse(read(`src/main/i18n/locales/${tag}.json`));
      expect(typeof dict['answer.more']).toBe('string');
    }
    expect(html()).toContain('data-i18n-aria="answer.more"');
  });
  it('fit guards: hidden/zero-size containers reset instead of sticking', () => {
    const src = appJs();
    expect(html()).toContain('id="f-hints"');
    expect(src).toContain('var lastFooterKey');
    expect(src).toContain('unmeasurable (hidden window)');
  });
});
