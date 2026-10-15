import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const css = () => read('src/renderer/styles.css');
const html = () => read('src/renderer/index.html');

describe('follow-bottom: when the button appears', () => {
  it('within-48px counts as bottom (never strict equality)', () => {
    const src = appJs();
    expect(src).toContain('var FOLLOW_PX = 48;');
    expect(src).toContain('distToBottom(el) <= 48');
    expect(src).toContain('fractional scrollTop and high-DPI');
  });
  it('only real user input writes followBottom; programmatic sets are echo-guarded', () => {
    const src = appJs();
    expect(src).toContain('function onViewScroll()');
    expect(src).toContain('var progScroll = false;');
    expect(src).toContain('var lastSetTop = -1;');
    expect(src).toContain('Math.abs(el.scrollTop - lastSetTop) < 2');
    // content growth fires no scroll event — the handler is the only writer
    expect(src).toContain('The ONLY writer of followBottom');
  });
  it('growth and resizes follow after layout, instantly (never smooth)', () => {
    const src = appJs();
    expect(src).toContain('new ResizeObserver(');
    expect(src).toContain("ro.observe($('view'))");
    expect(src).toContain("ro.observe($('run'))");
    expect(src).toContain('requestAnimationFrame(() => { if (followBottom) scrollBottomNow(); });');
    expect(src).toContain('never smooth');
  });
  it('button shows only when unfollowed AND overflowing; dot while streaming below', () => {
    const src = appJs();
    const sync = src.slice(src.indexOf('function syncJump()'), src.indexOf('function onViewScroll()'));
    expect(sync).toContain('!followBottom && hasOverflow(el)');
    expect(sync).toContain("btn.classList.toggle('streaming', show && agentRunning())");
    expect(sync).toContain('hasOverflow(el)');
  });
  it('click and sends re-enable following; scrolling to bottom hides', () => {
    const src = appJs();
    const click = src.slice(src.indexOf("if ($('jump-latest'))"), src.indexOf('function paintChip()'));
    expect(click).toContain('followBottom = true;');
    expect(click).toContain('scrollBottomNow();');
    expect(src).toContain('followBottom = isAtBottom(el);');
  });
  it('view/task switches park and restore positions per view (run per conversation)', () => {
    const src = appJs();
    expect(src).toContain('var savedScroll = {};');
    expect(src).toContain('function scrollKey(v)');
    expect(src).toContain('function restoreScroll()');
    expect(src).toContain("savedScroll[scrollKey(view)]");
    expect(src).toContain('restoreScroll();');
  });
});

describe('jump button: pinned sibling, never in the scroll flow', () => {
  it('lives beside the scroller under the panel, with icon + localized label', () => {
    const h = html();
    const viewClose = h.indexOf('id="view"');
    const btn = h.indexOf('id="jump-latest"');
    const foot = h.indexOf('<footer');
    expect(btn).toBeGreaterThan(viewClose);
    expect(btn).toBeLessThan(foot);
    // not inside the scrolling element: the #view div closes before the button
    const viewDiv = h.indexOf('<div class="view scroll hidden" id="view">');
    expect(h.slice(viewDiv, btn)).toContain('</div>');
    expect(h).toContain('aria-label="Jump to latest message"');
    expect(h).toContain('data-i18n="action.jumpLatest"');
    expect(h).toContain('<svg width="14" height="14"');
    for (const tag of ['en', 'vi']) {
      const dict = JSON.parse(read(`src/main/i18n/locales/${tag}.json`));
      expect(typeof dict['action.jumpLatest']).toBe('string');
      expect(typeof dict['action.jumpLatestMsg']).toBe('string');
    }
  });
  it('floats at the visible corner: no layout space, above content, below dialogs', () => {
    const c = css();
    expect(c).toContain('#jump-latest { position: absolute; inset-inline-end: 16px; bottom: calc(var(--control-h) + 2 * var(--popup-inset) + 12px); z-index: 6;');
    expect(c).toContain('height: 32px; padding: 0 12px; border-radius: 999px;');
    expect(c).toContain('background: var(--surface); border: 1px solid var(--border);');
    expect(c).toContain('#jump-latest:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }');
    expect(c).toContain('#jump-latest.streaming::after');
    expect(c).toContain('background: var(--accent);');
    expect(c).toContain('@keyframes jump-in');
    expect(c).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('one scroll container: no nested vertical scrollers in answers', () => {
  it('.view stays the only vertical scroller; code scrolls horizontally only', () => {
    const c = css();
    expect(c).toContain('.view { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden;');
    expect(c).toContain('.msg.assistant pre {');
    expect(c).toContain('overflow-x: auto; overflow-y: hidden;');
    expect(c).not.toMatch(/\.msg\.assistant pre \{[^}]*max-height/);
    expect(c).toContain('.astep pre.out {');
    expect(c).toContain('overflow-x: auto; overflow-y: hidden;');
  });
});
