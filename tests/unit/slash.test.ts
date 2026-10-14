import { describe, it, expect } from 'vitest';
import { buildRegistry, rankMatches, querySlash, resolveSlash } from '../../src/main/slash/registry';

const prompts = [{ trigger: '/translate', label: 'Translate', description: 't', source: 'prompt' as const }];
const workflows = [{ trigger: '/email-reply', label: 'Email', description: 'w', source: 'workflow' as const }];

describe('slash registry', () => {
  it('merges builtin+prompt+workflow without dupes', () => {
    const reg = buildRegistry({ prompts, workflows });
    expect(reg.length).toBe(12 + 2); // 12 builtins (/help /new /clear /model /history /settings /log /extensions /memory /remember /forget /incognito)
    expect(reg[0].trigger).toBe('/help');
  });
  it('exact beats prefix beats fuzzy', () => {
    const reg = buildRegistry({ prompts, workflows });
    expect(rankMatches(reg, 'help')[0].trigger).toBe('/help');
    expect(rankMatches(reg, 'his')[0].trigger).toBe('/history');
    // fuzzy subsequence: 'emrp' ~ email-reply
    const fuzzy = rankMatches(reg, 'emrp');
    expect(fuzzy[0].trigger).toBe('/email-reply');
  });
  it('querySlash only matches trailing slash token', () => {
    const reg = buildRegistry({ prompts, workflows });
    expect(querySlash(reg, 'hello')).toEqual([]);
    expect(querySlash(reg, 'hi /tra')[0].trigger).toBe('/translate');
  });
  it('unknown trigger returns top-3 suggestions', () => {
    const reg = buildRegistry({ prompts, workflows });
    const r = resolveSlash(reg, '/xyz');
    expect(r.found).toBeUndefined();
    expect(r.suggestions.length).toBeLessThanOrEqual(3);
    const ok = resolveSlash(reg, '/help');
    expect(ok.found?.trigger).toBe('/help');
  });
});
