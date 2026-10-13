import { describe, it, expect } from 'vitest';
import { testConnectivity } from '../../src/main/ai/providers/testing';
import { TEST_MAX_OUTPUT_TOKENS, TEST_MAX_REASONING_TOKENS } from '../../src/main/ai/providers/constants';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('testConnectivity flow', () => {
  it('uses unsaved values: listModels, tiny completion, then tool check', async () => {
    const seen: Array<{ url: string; auth: string; body: string }> = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      const h = (init as { headers: Record<string, string> }).headers;
      const body = (init as { body: string }).body;
      seen.push({ url: String(url), auth: h.Authorization || h['x-api-key'] || '', body });
      if (String(url).endsWith('/models')) return okJson({ data: [{ id: 'm1' }, { id: 'm2' }] });
      const b = JSON.parse(body) as { tools?: unknown[] };
      if (b.tools) return okJson({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'test_ping', arguments: '{}' } }] } }] });
      return okJson({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const r = await testConnectivity('openai', 'unsaved-key', 'm1', 'https://example.test/v1', fetchFn);
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ provider: 'openai', model: 'm1', toolsOk: true, modelsListed: 2 });
    // Unsaved base URL + key used on every call, never stored settings.
    for (const s of seen) {
      expect(s.url.startsWith('https://example.test/v1')).toBe(true);
      expect(s.auth).toContain('unsaved-key');
    }
    expect(seen.length).toBe(3);
  });
  it('fails friendly without a key (except compatible) and without a model', async () => {
    const never = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    await expect(testConnectivity('openai', '', 'm', undefined, never))
      .resolves.toMatchObject({ ok: false, error: { kind: 'auth' } });
    await expect(testConnectivity('openai', 'k', '  ', undefined, never))
      .resolves.toMatchObject({ ok: false, error: { kind: 'bad_request' } });
  });
  it('surfaces provider errors with kinds (failed run stops, no placeholder)', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'model not found', type: 'not_found' } }), { status: 404 })) as unknown as typeof fetch;
    const r = await testConnectivity('compatible', '', 'nope', 'http://localhost:11434/v1', fetchFn);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('model_not_found');
    expect(r.details).toBeUndefined();
  });
  it('uses a reasoning-aware budget: 128 for reasoning models, 16 otherwise', async () => {
    for (const [model, want] of [['gpt-6-sol', TEST_MAX_REASONING_TOKENS], ['gpt-4o', TEST_MAX_OUTPUT_TOKENS]] as const) {
      const bodies: Array<Record<string, unknown>> = [];
      const fetchFn = (async (_url: unknown, init: unknown) => {
        const raw = (init as { body: string }).body;
        if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
        const url = String(_url);
        if (url.endsWith('/models')) return okJson({ data: [] });
        return okJson({ choices: [{ message: { content: 'ok' } }] });
      }) as unknown as typeof fetch;
      const r = await testConnectivity('openai', 'k', model, undefined, fetchFn);
      expect(r.ok).toBe(true);
      // bodies[0] = tiny completion, bodies[1] = tool probe
      expect(bodies[0].max_completion_tokens).toBe(want);
      expect(bodies[1].max_completion_tokens).toBe(want);
    }
  });
  it('tool probe sends reasoning_effort none (mocked, no keys)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: unknown, init: unknown) => {
      const raw = (init as { body: string }).body;
      if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
      if (String(_url).endsWith('/models')) return okJson({ data: [] });
      return okJson({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const r = await testConnectivity('openai', 'k', 'gpt-6-luna', undefined, fetchFn);
    expect(r.ok).toBe(true);
    expect(bodies[1].reasoning_effort).toBe('none');
    // Tiny completion carries no tools and no reasoning_effort.
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].tools).toBeUndefined();
  });
  it('keeps network mapping: fetch failure surfaces kind network', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const r = await testConnectivity('openai', 'k', 'gpt-6-sol', undefined, down);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('network');
  });
});
