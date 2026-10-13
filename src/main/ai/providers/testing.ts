import type { ProviderId } from '../../../shared/types';
import { providerError, toProviderError, type ProviderError } from '../errors/provider-error';
import { getAdapter } from './index';
import { TEST_MAX_OUTPUT_TOKENS, TEST_TIMEOUT_MS } from './constants';
import { fetchWithRetry } from './retry';

export interface TestDetails {
  provider: string;
  model: string;
  ms: number;
  toolsOk: boolean;
  modelsListed: number;
}

export interface TestResult {
  ok: boolean;
  error?: ProviderError;
  details?: TestDetails;
}

function withTimeout(signal?: AbortSignal, ms = TEST_TIMEOUT_MS): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

/**
 * Test button flow with caller-supplied (possibly unsaved) values — never reads
 * stored settings itself. Steps: listModels (best-effort) → tiny completion
 * (small limit, reasoning-aware via adapter caps) → trivial tool check.
 * Never logs keys.
 */
export async function testConnectivity(
  provider: ProviderId,
  apiKey: string,
  model: string,
  baseUrl?: string,
  fetchFn: typeof fetch = fetch,
  parentSignal?: AbortSignal,
): Promise<TestResult> {
  const start = Date.now();
  const t = withTimeout(parentSignal);
  try {
    if (!apiKey && provider !== 'compatible') {
      return { ok: false, error: providerError('auth', 'no API key entered') };
    }
    if (!model?.trim()) return { ok: false, error: providerError('bad_request', 'no model entered') };
    const adapter = getAdapter(provider);
    const base = baseUrl || adapter.defaultBaseUrl;
    const models = await adapter.listModels(apiKey || 'test', base, t.signal, fetchFn).catch(() => [] as string[]);
    // Tiny completion: reasoning-aware limit/sampling handled by the adapter.
    const built = adapter.buildRequest(model, {
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      stream: false,
    }, base);
    // why: header placeholder swapped here so adapters stay fetch-free
    const res = await fetchWithRetry({
      adapter, model, baseUrl: base, apiKey, body: built.body as Record<string, unknown>,
      signal: t.signal, fetchFn, streaming: false, debugLabel: `test:${provider}`,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: adapter.parseError(res.status, text) };
    }
    const turn = adapter.parseResponse(await res.json().catch(() => undefined));
    if (!turn.text && !turn.calls.length) {
      return { ok: false, error: providerError('unknown', 'Empty response from provider') };
    }
    // Trivial tool check: offer one echo tool; text-only backends pass as fallback.
    let toolsOk = true;
    if (adapter.capabilitiesFor(model).supportsTools) {
      const toolReq = adapter.buildRequest(model, {
        messages: [{ role: 'user', content: 'Call test_ping with {}' }],
        tools: [{ name: 'test_ping', description: 'Connectivity probe tool', inputSchema: { type: 'object', properties: {} } }],
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
        stream: false,
      }, base);
      try {
        const r2 = await fetchWithRetry({
          adapter, model, baseUrl: base, apiKey, body: toolReq.body as Record<string, unknown>,
          signal: t.signal, fetchFn, streaming: false, debugLabel: `test-tools:${provider}`,
        });
        if (r2.ok) {
          const turn2 = adapter.parseResponse(await r2.json().catch(() => undefined));
          toolsOk = !!(turn2.calls.length || turn2.text);
        }
      } catch { toolsOk = false; }
    }
    return { ok: true, details: { provider, model, ms: Date.now() - start, toolsOk, modelsListed: models.length } };
  } catch (e) {
    return { ok: false, error: toProviderError(e) };
  } finally {
    t.done();
  }
}
