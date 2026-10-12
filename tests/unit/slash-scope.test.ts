import { describe, it, expect } from 'vitest';
import { buildRegistry, querySlash, filterByScope } from '../../src/main/slash/registry';

describe('slash scope filter per mode', () => {
  const reg = buildRegistry({
    prompts: [
      { trigger: '/chat-only', label: 'C', description: 'c', source: 'prompt', scope: 'chat' },
      { trigger: '/agent-only', label: 'A', description: 'a', source: 'prompt', scope: 'agent' },
      { trigger: '/both', label: 'B', description: 'b', source: 'prompt', scope: 'all' },
    ],
  });

  it('filterByScope splits chat vs agent', () => {
    expect(filterByScope(reg, 'chat').map((e) => e.trigger)).toContain('/chat-only');
    expect(filterByScope(reg, 'chat').map((e) => e.trigger)).not.toContain('/agent-only');
    expect(filterByScope(reg, 'agent').map((e) => e.trigger)).toContain('/agent-only');
    expect(filterByScope(reg, 'agent').map((e) => e.trigger)).not.toContain('/chat-only');
    expect(filterByScope(reg, 'chat').map((e) => e.trigger)).toContain('/both');
  });

  it('querySlash respects mode param', () => {
    // /model is chat-scoped builtin
    expect(querySlash(reg, '/mod', 8, 'chat').map((e) => e.trigger)).toContain('/model');
    expect(querySlash(reg, '/mod', 8, 'agent').map((e) => e.trigger)).not.toContain('/model');
    expect(querySlash(reg, '/agent', 8, 'agent').map((e) => e.trigger)).toContain('/agent-only');
    expect(querySlash(reg, '/agent', 8, 'chat').map((e) => e.trigger)).not.toContain('/agent-only');
  });

  it('unscoped legacy entries remain visible in both modes', () => {
    const legacy = buildRegistry({ prompts: [{ trigger: '/old', label: 'O', description: 'o', source: 'prompt' }] });
    expect(filterByScope(legacy, 'chat').map((e) => e.trigger)).toContain('/old');
    expect(filterByScope(legacy, 'agent').map((e) => e.trigger)).toContain('/old');
  });
});
