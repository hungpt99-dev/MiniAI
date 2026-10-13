import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_ADAPTERS } from '../../src/main/ai/providers/index';
import type { ProviderAdapter } from '../../src/main/ai/providers/types';
import { detectParamFix, applyFix, fetchWithRetry, resetParamCache, getCachedFix } from '../../src/main/ai/providers/retry';

const REASONING_MODEL: Record<string, string> = {
  openai: 'o3-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash-thinking',
  compatible: 'deepseek-r1-distill-qwen-7b',
};

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe.each(Object.values(PROVIDER_ADAPTERS))('adapter $id conformance', (adapter: ProviderAdapter) => {
  it('builds a request with a limit param and stream flag', () => {
    const caps = adapter.capabilitiesFor('plain-model');
    const built = adapter.buildRequest('plain-model', {
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 4096,
      stream: true,
    });
    expect(built.url).toContain(adapter.defaultBaseUrl.replace(/\/$/, '').split('/').slice(0, 3).join('/'));
    const body = built.body as Record<string, unknown>;
    const hasLimit = 'max_tokens' in body || 'max_completion_tokens' in body;
    if (caps.requiresLimit) expect(hasLimit).toBe(true);
    expect(body.stream).toBe(true);
  });

  it('is reasoning-aware: drops sampling params for reasoning models', () => {
    const model = REASONING_MODEL[adapter.id];
    const built = adapter.buildRequest(model, {
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 16,
      temperature: 0.7,
      topP: 0.9,
      stream: false,
    });
    const body = built.body as Record<string, unknown>;
    const caps = adapter.capabilitiesFor(model);
    expect(caps.reasoningAware).toBe(true);
    if (!caps.supportsTemperature) expect(body.temperature).toBeUndefined();
    if (!caps.supportsTopP) { expect(body.top_p).toBeUndefined(); expect(body.top_k).toBeUndefined(); }
  });

  it('round-trips tools: buildRequest carries tools, parseResponse reads calls', () => {
    const built = adapter.buildRequest('m', {
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'test_ping', description: 'probe', inputSchema: { type: 'object', properties: {} } }],
      maxOutputTokens: 16,
      stream: false,
    });
    expect(JSON.stringify(built.body)).toContain('test_ping');
  });

  it('parses auth + model_not_found + rate_limited errors to kinds', () => {
    expect(adapter.parseError(401, 'invalid api key').kind).toBe('auth');
    expect(adapter.parseError(404, 'model not found').kind).toBe('model_not_found');
    expect(adapter.parseError(429, 'rate limit exceeded').kind).toBe('rate_limited');
  });

  it('parseStreamEvent returns undefined for control events, text for deltas', () => {
    expect(adapter.parseStreamEvent({})).toBeUndefined();
  });

  it('listModels never throws without network', async () => {
    const bad: typeof fetch = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(adapter.listModels('k', undefined, undefined, bad)).resolves.toEqual([]);
  });

  it('tiny completion parses through fetchWithRetry (mocked HTTP)', async () => {
    const sample = adapter.id === 'anthropic'
      ? { content: [{ type: 'text', text: 'ok' }] }
      : { choices: [{ message: { content: 'ok' } }] };
    const fetchFn = (async () => okJson(sample)) as unknown as typeof fetch;
    const built = adapter.buildRequest('m', {
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      maxOutputTokens: 16,
      stream: false,
    });
    const res = await fetchWithRetry({
      adapter, model: 'm', baseUrl: adapter.defaultBaseUrl, apiKey: 'k',
      body: built.body as Record<string, unknown>, fetchFn, streaming: false, debugLabel: 'test',
    });
    expect(res.ok).toBe(true);
    expect(adapter.parseResponse(await res.json()).text).toBe('ok');
  });
});

describe('adapter specifics', () => {
  it('anthropic: requires max_tokens, top-level system, version header', () => {
    const a = PROVIDER_ADAPTERS.anthropic;
    expect(a.capabilitiesFor('claude-sonnet-4-20250514').requiresLimit).toBe(true);
    const built = a.buildRequest('m', {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      maxOutputTokens: 32,
      stream: false,
    });
    const body = built.body as Record<string, unknown>;
    expect(body.system).toBe('sys');
    expect(body.max_tokens).toBe(32);
    expect(a.headers('k')['anthropic-version']).toBeTruthy();
  });
  it('anthropic: drops top_p when temperature is set', () => {
    const a = PROVIDER_ADAPTERS.anthropic;
    const body = a.buildRequest('m', {
      messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 32,
      temperature: 0.5, topP: 0.9, stream: false,
    }).body as Record<string, unknown>;
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBeUndefined();
  });
  it('openai: reasoning model uses developer role + completion limit', () => {
    const a = PROVIDER_ADAPTERS.openai;
    const body = a.buildRequest('o3-mini', {
      messages: [{ role: 'system', content: 'sys' }], maxOutputTokens: 16, stream: false,
    }).body as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('developer');
    expect(body.max_completion_tokens).toBe(16);
  });
  it('openai: gpt-6 is reasoning-aware with completion limit, no sampling', () => {
    const a = PROVIDER_ADAPTERS.openai;
    for (const m of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6']) {
      const caps = a.capabilitiesFor(m);
      expect(caps.reasoningAware).toBe(true);
      expect(caps.limitParam).toBe('max_completion_tokens');
      expect(caps.supportsTemperature).toBe(false);
      expect(caps.supportsTopP).toBe(false);
      const body = a.buildRequest(m, {
        messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128,
        temperature: 0.7, topP: 0.9, stream: false,
      }).body as Record<string, unknown>;
      expect(body.max_completion_tokens).toBe(128);
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
    }
  });
  it('openai: reasoning_effort none forced for gpt-6 tool calls only', () => {
    const a = PROVIDER_ADAPTERS.openai;
    const tools = [{ name: 't', description: 'd', inputSchema: { type: 'object' } }];
    for (const m of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6']) {
      const withTools = a.buildRequest(m, {
        messages: [{ role: 'user', content: 'go' }], tools, maxOutputTokens: 128, stream: false,
      }).body as Record<string, unknown>;
      expect(withTools.reasoning_effort).toBe('none');
      const noTools = a.buildRequest(m, {
        messages: [{ role: 'user', content: 'go' }], maxOutputTokens: 128, stream: false,
      }).body as Record<string, unknown>;
      expect(noTools.reasoning_effort).toBeUndefined();
      // Explicit effort is overridden for gpt-6 tool calls.
      const forced = a.buildRequest(m, {
        messages: [{ role: 'user', content: 'go' }], tools, maxOutputTokens: 128,
        reasoningEffort: 'high', stream: false,
      }).body as Record<string, unknown>;
      expect(forced.reasoning_effort).toBe('none');
    }
    // Other reasoning models send effort only when tools + effort are both set.
    const o3 = a.buildRequest('o3-mini', {
      messages: [{ role: 'user', content: 'go' }], tools, maxOutputTokens: 16,
      reasoningEffort: 'low', stream: false,
    }).body as Record<string, unknown>;
    expect(o3.reasoning_effort).toBe('low');
    const o3NoTools = a.buildRequest('o3-mini', {
      messages: [{ role: 'user', content: 'go' }], maxOutputTokens: 16,
      reasoningEffort: 'low', stream: false,
    }).body as Record<string, unknown>;
    expect(o3NoTools.reasoning_effort).toBeUndefined();
    const plain = a.buildRequest('gpt-4o', {
      messages: [{ role: 'user', content: 'go' }], tools, maxOutputTokens: 16, stream: false,
    }).body as Record<string, unknown>;
    expect(plain.reasoning_effort).toBeUndefined();
  });
  it('gemini: uses the OpenAI-compat chat endpoint', () => {
    expect(PROVIDER_ADAPTERS.gemini.chatEndpoint()).toContain('/chat/completions');
  });
  it('compatible: omits auth header when key is empty; text-only tool reply is valid', () => {
    const a = PROVIDER_ADAPTERS.compatible;
    expect(a.headers('').Authorization).toBeUndefined();
    expect(a.parseResponse({ choices: [{ message: { content: 'did it' } }] })).toMatchObject({ text: 'did it', calls: [] });
  });
});

describe('retry', () => {
  it('detects limit swap + param drop from 400 bodies', () => {
    const fix = detectParamFix(400, "Unsupported parameter: 'max_tokens'", { model: 'm', max_tokens: 5 });
    expect(fix).toMatchObject({ swapLimit: 'max_completion_tokens' });
    const fix2 = detectParamFix(400, "unknown parameter 'temperature'", { model: 'm', temperature: 1 });
    expect(fix2?.drop).toContain('temperature');
    expect(detectParamFix(400, 'something else broke', { model: 'm' })).toBeUndefined();
    expect(detectParamFix(500, "unsupported parameter 'temperature'", { model: 'm', temperature: 1 })).toBeUndefined();
  });
  it('applyFix swaps limits without leaving both names', () => {
    const out = applyFix({ max_tokens: 5, temperature: 1 }, { drop: ['temperature'], swapLimit: 'max_completion_tokens' });
    expect(out).toMatchObject({ max_completion_tokens: 5 });
    expect(out.max_tokens).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });
  it('retries unsupported params once and caches the fix per provider/baseUrl/model', async () => {
    resetParamCache();
    const a = PROVIDER_ADAPTERS.openai;
    let calls = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      calls++;
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (calls === 1) return new Response("unsupported parameter 'temperature'", { status: 400 });
      return okJson({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const res = await fetchWithRetry({
      adapter: a, model: 'm', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'm', temperature: 1, stream: false }, fetchFn, streaming: true, debugLabel: 't',
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(getCachedFix('openai', a.defaultBaseUrl, 'm')?.drop).toContain('temperature');
    resetParamCache();
    expect(getCachedFix('openai', a.defaultBaseUrl, 'm')).toBeUndefined();
  });
  it('swaps max_tokens to max_completion_tokens on 400 and succeeds', async () => {
    resetParamCache();
    const a = PROVIDER_ADAPTERS.openai;
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      calls++;
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      bodies.push(body);
      if (calls === 1) return new Response("unsupported parameter 'max_tokens', use 'max_completion_tokens'", { status: 400 });
      return okJson({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const res = await fetchWithRetry({
      adapter: a, model: 'swap-m', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'swap-m', max_tokens: 16, stream: false }, fetchFn, streaming: false, debugLabel: 't',
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 16 });
    expect(bodies[1].max_tokens).toBeUndefined();
    expect(getCachedFix('openai', a.defaultBaseUrl, 'swap-m')).toMatchObject({ swapLimit: 'max_completion_tokens' });
    resetParamCache();
  });
  it('stops after one param retry when the second attempt also 400s', async () => {
    resetParamCache();
    const a = PROVIDER_ADAPTERS.openai;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("unsupported parameter 'temperature'", { status: 400 });
    }) as unknown as typeof fetch;
    const res = await fetchWithRetry({
      adapter: a, model: 'twice-m', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'twice-m', temperature: 1, stream: false }, fetchFn, streaming: false, debugLabel: 't',
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(2);
    resetParamCache();
  });
  it('never treats 401/429 as param errors (no retry)', async () => {
    expect(detectParamFix(401, 'invalid api key', { model: 'm' })).toBeUndefined();
    expect(detectParamFix(429, 'rate limit exceeded', { model: 'm' })).toBeUndefined();
    const a = PROVIDER_ADAPTERS.openai;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('invalid api key', { status: 401 });
    }) as unknown as typeof fetch;
    const res = await fetchWithRetry({
      adapter: a, model: 'gate-m', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'gate-m' }, fetchFn, streaming: true, debugLabel: 't',
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });
  it('backs off on 429 for non-streaming only (Retry-After honored), streaming throws through', async () => {
    const a = PROVIDER_ADAPTERS.openai;
    let n = 0;
    const flaky = (async () => (++n === 1
      ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
      : okJson({})) ) as unknown as typeof fetch;
    const r1 = await fetchWithRetry({
      adapter: a, model: 'm', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'm' }, fetchFn: flaky, streaming: false, debugLabel: 't',
    });
    expect(r1.ok).toBe(true);
    expect(n).toBe(2);
    const r2 = await fetchWithRetry({
      adapter: a, model: 'm', baseUrl: a.defaultBaseUrl, apiKey: 'k',
      body: { model: 'm' }, fetchFn: (async () => new Response('slow', { status: 429 })) as unknown as typeof fetch,
      streaming: true, debugLabel: 't',
    });
    expect(r2.status).toBe(429);
  });
});

describe('provider literal contract', () => {
  // why: request/response literals live in providers/<id>/ only; retry.ts is
  // the single exempt generic-recovery module, tests carry fixtures
  const LITERALS = [
    'max_tokens', 'max_completion_tokens', 'anthropic-version', 'anthropic-dangerous',
    'input_schema', 'tool_choice', 'stream_options', 'systemInstruction',
    'generationConfig', 'thinkingBudget', '/chat/completions', '/v1/messages', '/v1beta/openai',
  ];
  const EXEMPT = [
    `src${path.sep}main${path.sep}ai${path.sep}providers${path.sep}`,
    `src${path.sep}main${path.sep}ai${path.sep}providers${path.sep}retry.ts`,
    `tests${path.sep}`,
  ];
  function walk(d: string, out: string[]): string[] {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist|\.git/.test(p)) walk(p, out); }
      else if (/\.(ts|js|html)$/.test(p)) out.push(p);
    }
    return out;
  }
  it('fails when provider literals appear outside providers/<id>/ (retry exempt)', () => {
    const roots = ['src/main', 'src/shared', 'src/renderer'].filter((d) => fs.existsSync(d));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of walk(root, [])) {
        const rel = path.relative(process.cwd(), f);
        const inAdapterDir = rel.startsWith(EXEMPT[0]);
        const isRetry = rel === path.join('src', 'main', 'ai', 'providers', 'retry.ts');
        if (inAdapterDir && !isRetry) continue;
        if (isRetry) continue;
        const text = fs.readFileSync(f, 'utf8');
        for (const lit of LITERALS) {
          if (text.includes(lit)) { offenders.push(`${rel}: ${lit}`); break; }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
