import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildRegistry, filterByScope, rankMatches, querySlash, resolveSlash } from '../../src/main/slash/registry';

const prompts = [{ trigger: '/translate', label: 'Translate', description: 't', source: 'prompt' as const }];
const workflows = [{ trigger: '/email-reply', label: 'Email', description: 'w', source: 'workflow' as const }];

describe('slash registry', () => {
  it('merges builtin+prompt+workflow without dupes', () => {
    const reg = buildRegistry({ prompts, workflows });
    expect(reg.length).toBe(18 + 2); // 18 builtins (/help /new /clear /model /history /settings /log /extensions /memory /remember /forget /incognito /spawn /queue /tasks /cancel /clear-queue /pin)
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

describe('/queue registration, scope, ranking and handler', () => {
  const reg = buildRegistry({});

  it('is registered with the enqueue descriptor (agent scope)', () => {
    const q = reg.find((e) => e.trigger === '/queue');
    expect(q).toMatchObject({ label: 'Queue task', source: 'builtin', action: 'queue', scope: 'agent' });
  });

  it('scope filtering: visible in Do, hidden in Ask (same as /spawn)', () => {
    expect(filterByScope(reg, 'agent').map((e) => e.trigger)).toContain('/queue');
    expect(filterByScope(reg, 'chat').map((e) => e.trigger)).not.toContain('/queue');
    expect(filterByScope(reg, 'chat').map((e) => e.trigger)).toContain('/tasks');
  });

  it('prefix/fuzzy ranking finds /queue for "/q" and "/que" in Do mode', () => {
    expect(querySlash(reg, '/q', 50, 'agent')[0].trigger).toBe('/queue');
    expect(querySlash(reg, '/que', 50, 'agent')[0].trigger).toBe('/queue');
    expect(querySlash(reg, '/q', 50, 'chat').map((e) => e.trigger)).not.toContain('/queue');
  });

  it('bare "/" lists /queue (limit covers all builtins + extras)', () => {
    const regFull = buildRegistry({ prompts, workflows });
    expect(querySlash(regFull, '/', 50, 'agent').map((e) => e.trigger)).toContain('/queue');
  });

  it('unknown-command suggestions include /queue', () => {
    const r = resolveSlash(reg, '/queu');
    expect(r.found).toBeUndefined();
    expect(r.suggestions.map((e) => e.trigger)).toContain('/queue');
  });

  it('renderer: /queue enqueues via send({queued:true}), usage + scope-only strings exist', () => {
    const src = fs.readFileSync('src/renderer/app.js', 'utf8');
    expect(src).toContain("trigger === '/spawn' || trigger === '/queue'");
    expect(src).toContain('{ queued: true }');
    expect(src).toContain('slash.usageQueue');
    expect(src).toContain('slash.scopeOnly');
  });

  it('renderer: /help output lists /queue', () => {
    const src = fs.readFileSync('src/renderer/app.js', 'utf8');
    expect(src).toContain('/queue /tasks /cancel /clear-queue');
  });
});
