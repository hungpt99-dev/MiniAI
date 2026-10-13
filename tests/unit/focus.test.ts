import { describe, it, expect } from 'vitest';
import { shouldRefocusComposer } from '../../src/shared/focus';

// Regression test: the popup focus handler stole focus from approval-card
// buttons on every window focus event, stranding keyboard users on the
// composer while a destructive approval awaited a decision.
describe('popup focus rule', () => {
  it('keeps focus inside approval cards', () => {
    expect(shouldRefocusComposer('BUTTON', true)).toBe(false);
    expect(shouldRefocusComposer('DIV', true)).toBe(false);
  });
  it('grabs focus when nothing or body is focused', () => {
    expect(shouldRefocusComposer(null, false)).toBe(true);
    expect(shouldRefocusComposer('DIV', false)).toBe(true);
    expect(shouldRefocusComposer('BUTTON', false)).toBe(true);
  });
  it('leaves form fields alone', () => {
    expect(shouldRefocusComposer('INPUT', false)).toBe(false);
    expect(shouldRefocusComposer('TEXTAREA', false)).toBe(false);
    expect(shouldRefocusComposer('SELECT', false)).toBe(false);
  });
});
