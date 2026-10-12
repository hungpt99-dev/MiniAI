import { describe, it, expect } from 'vitest';
import { shouldInterceptKey, saveDraft, restoreDraft, filterByScope, type Drafts } from '../../src/shared/mode-utils';

describe('tab mode utils', () => {
  it('preserves drafts per mode', () => {
    let drafts: Drafts = { chat: '', agent: '' };
    drafts = saveDraft(drafts, 'chat', 'hello');
    expect(restoreDraft(drafts, 'chat')).toBe('hello');
    expect(restoreDraft(drafts, 'agent')).toBe('');
    drafts = saveDraft(drafts, 'agent', 'task');
    expect(restoreDraft(drafts, 'chat')).toBe('hello');
    expect(restoreDraft(drafts, 'agent')).toBe('task');
  });

  it('intercepts Tab only when input focused, palette closed, not composing', () => {
    const base = { key: 'Tab', inputFocused: true, paletteOpen: false, isComposing: false };
    expect(shouldInterceptKey(base)).toBe(true);
    expect(shouldInterceptKey({ ...base, paletteOpen: true })).toBe(false);
    expect(shouldInterceptKey({ ...base, isComposing: true })).toBe(false);
    expect(shouldInterceptKey({ ...base, inputFocused: false })).toBe(false);
    expect(shouldInterceptKey({ ...base, key: 'Enter' })).toBe(false);
  });

  it('filterByScope keeps all/matching, drops other mode', () => {
    const entries = [
      { trigger: '/a', scope: 'chat' as const },
      { trigger: '/b', scope: 'agent' as const },
      { trigger: '/c', scope: 'all' as const },
      { trigger: '/d' },
    ];
    expect(filterByScope(entries, 'chat').map((e) => e.trigger)).toEqual(['/a', '/c', '/d']);
    expect(filterByScope(entries, 'agent').map((e) => e.trigger)).toEqual(['/b', '/c', '/d']);
  });
});
