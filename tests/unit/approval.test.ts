import { describe, it, expect } from 'vitest';
import { approvalEnterAction } from '../../src/shared/approval';

// Regression test for a real P0: Enter with Deny focused fired Allow once,
// executing a destructive shell command the user meant to deny.
describe('approval card Enter behavior', () => {
  it('focused Deny/Always/scope buttons activate natively', () => {
    expect(approvalEnterAction('BUTTON', false)).toBe('native');
  });
  it('focused Allow once activates natively (same outcome)', () => {
    expect(approvalEnterAction('BUTTON', true)).toBe('allow');
  });
  it('non-button targets mean Allow once', () => {
    expect(approvalEnterAction('DIV', false)).toBe('allow');
    expect(approvalEnterAction('P', false)).toBe('allow');
    expect(approvalEnterAction(null, false)).toBe('allow');
  });
});
