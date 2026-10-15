import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const css = () => read('src/renderer/styles.css');

describe('spacing: one owner per gap on the 4px scale', () => {
  it('view owns outer padding; conversation/turn gaps on the scale var', () => {
    const c = css();
    expect(c).toContain('--space-scale: 1;');
    expect(c).toContain('.view {');
    expect(c).toContain('padding: calc(var(--popup-pad-y) * var(--space-scale)) calc(22px * var(--space-scale)) calc(var(--popup-pad-y) * var(--space-scale));');
    expect(c).toContain('#messages { display: flex; flex-direction: column; gap: calc(16px * var(--space-scale)); padding: 0; }');
    expect(c).toContain('.turn { display: flex; flex-direction: column; gap: calc(6px * var(--space-scale));');
    expect(c).toContain('#run { order: 2; display: flex; flex-direction: column; gap: calc(6px * var(--space-scale)); }');
  });
  it('answer type: 15px/1.5 regular with 2px top; markdown blocks use one sibling rule', () => {
    const c = css();
    expect(c).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.5; font-weight: 400; margin-top: 2px; }');
    expect(c).toContain('.msg.assistant.answer > * { margin-block-start: 0; margin-block-end: 0; }');
    expect(c).toContain('.msg.assistant.answer > * + * { margin-top: calc(8px * var(--space-scale)); }');
    expect(c).toContain('.you-label { font-size: 12px; line-height: 16px;');
    expect(c).toContain('.you-prompt { font-size: 14px; line-height: 20px;');
  });
  it('meta row is exactly 28px with no extra margin; steps toggle 24px', () => {
    const c = css();
    expect(c).toContain('#answer-meta { display: flex; align-items: center;');
    expect(c).toContain('height: 28px; margin: 0; padding: 0;');
    expect(c).not.toMatch(/#answer-meta \{[^}]*min-height/);
    expect(c).not.toMatch(/#answer-meta \{[^}]*margin-top/);
    expect(c).toContain('.steps-toggle {');
    expect(c).toContain('height: 24px;');
  });
  it('mode divider is marginless with 2px padding; jump floats without layout space', () => {
    const c = css();
    expect(c).toContain('.mode-div { display: flex; align-items: center;');
    expect(c).toContain('margin: 0; padding: calc(2px * var(--space-scale)) 0;');
    expect(c).toContain('#jump-latest { position: absolute;');
    expect(c).toContain('inset-inline-end: 16px; bottom: calc(var(--control-h) + 2 * var(--popup-inset) + 12px);');
  });
  it('footer control-h + 2*inset; action buttons 28px with 0 8px padding', () => {
    const c = css();
    expect(c).toContain('#hints { display: flex;');
    expect(c).toContain('min-height: calc(var(--control-h) + 2 * var(--popup-inset));');
    expect(c).toContain('padding: var(--popup-inset);');
    expect(c).toContain('#answer-meta #actions button { min-height: 28px; height: 28px;');
    expect(c).toContain('padding: 0 8px;');
  });
  it('palette owns inset/gap and scrolls: shared rhythm, 34px rows, own scroller', () => {
    const c = css();
    expect(c).toContain('#palette { display: flex; flex-direction: column; gap: 2px; padding: var(--popup-gap) var(--popup-inset);');
    expect(c).toContain('overflow-y: auto;');
    expect(c).toContain('#palette .item { display: flex; gap: 12px;');
    expect(c).toContain('margin-inline: -12px; padding-block: 4px; min-height: 34px;');
    expect(c).toContain('#palette .lb {');
    expect(c).toContain('padding: 6px 12px 2px;');
  });
  it('footer run chip is one inline row: dot + label centered', () => {
    const c = css();
    expect(c).toContain('#btn-runview {');
    expect(c).toContain('display: inline-flex; align-items: center;');
    expect(c).toContain('#btn-runview .rundot { width: 6px; height: 6px;');
    const src = read('src/renderer/app.js');
    expect(src).toContain("btn.title = state === 'running' ? 'Running — view run' : 'Done — view run';");
  });
  it('secondary views follow: zero outer padding, 20px sections, 8px rows', () => {
    const c = css();
    expect(c).toContain('#settings, #history { position: static;');
    expect(c).toContain('padding: 0; }');
    expect(c).toContain('#settings { display: flex; flex-direction: column; gap: calc(20px * var(--space-scale)); }');
    expect(c).toContain('.task-row { position: relative; display: flex; gap: calc(8px * var(--space-scale));');
  });
  it('compact spacing applies the 0.75 scale from settings', () => {
    const src = read('src/renderer/app.js');
    expect(src).toContain('function applySpaceScale(compact)');
    expect(src).toContain("'0.75'");
    expect(src).toContain('compactSpacing');
    const html = read('src/renderer/index.html');
    expect(html).toContain('id="set-compact"');
    expect(html).toContain('id="set-hideblur"');
  });
});
