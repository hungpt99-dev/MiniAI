import { describe, it, expect } from 'vitest';
import { testConnectivity } from '../../src/main/ai/providers/testing';

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
});
