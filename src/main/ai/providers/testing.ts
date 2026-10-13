import type { ProviderId } from '../../../shared/types';
import { providerError, toProviderError, type ProviderError } from '../errors/provider-error';
import { getAdapter } from './index';
import { resolveBase } from './base';
import { TEST_MAX_OUTPUT_TOKENS, TEST_MAX_REASONING_TOKENS, TEST_TIMEOUT_MS } from './constants';
import { fetchWithRetry } from './retry';

export interface TestDetails {
  provider: string;
  model: string;
  ms: number;
  toolsOk: boolean;
  modelsListed: number;
  /** listModels failure text (display-only; the probe still runs). Never a key. */
  listError?: string;
}

export interface TestResult {
  ok: boolean;
  error?: ProviderError;
  details?: TestDetails;
}

function withTimeout(signal?: AbortSignal, ms = TEST_TIMEOUT_MS): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(new Error('timeout')); }, ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }, timedOut: () => timedOut };
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
    const key = (apiKey || '').trim();
    const cleanModel = (model || '').trim();
    if (!key && provider !== 'compatible') {
      return { ok: false, error: providerError('auth', 'no API key entered') };
    }
    if (!cleanModel) return { ok: false, error: providerError('bad_request', 'no model entered') };
    const adapter = getAdapter(provider);
    const base = resolveBase(baseUrl, adapter.defaultBaseUrl);
    // why: real adapters swallow list failures into [] so this catch only fires for throwing fakes
    let listError: string | undefined;
    const models = await adapter.listModels(key, base, t.signal, fetchFn).catch((e: unknown) => {
      listError = e instanceof Error ? e.message : String(e);
      return [] as string[];
    });
    // Tiny completion: reasoning-aware limit/sampling handled by the adapter.
    const budget = adapter.capabilitiesFor(cleanModel).reasoningAware ? TEST_MAX_REASONING_TOKENS : TEST_MAX_OUTPUT_TOKENS;
    const built = adapter.buildRequest(cleanModel, {
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      maxOutputTokens: budget,
      stream: false,
    }, base);
    // why: header placeholder swapped here so adapters stay fetch-free
    const res = await fetchWithRetry({
      adapter, model: cleanModel, baseUrl: base, apiKey: key, body: built.body as Record<string, unknown>,
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
    if (adapter.capabilitiesFor(cleanModel).supportsTools) {
      const toolReq = adapter.buildRequest(cleanModel, {
        messages: [{ role: 'user', content: 'Call test_ping with {}' }],
        tools: [{ name: 'test_ping', description: 'Connectivity probe tool', inputSchema: { type: 'object', properties: {} } }],
        maxOutputTokens: budget,
        reasoningEffort: 'none',
        stream: false,
      }, base);
      try {
        const r2 = await fetchWithRetry({
          adapter, model: cleanModel, baseUrl: base, apiKey: key, body: toolReq.body as Record<string, unknown>,
          signal: t.signal, fetchFn, streaming: false, debugLabel: `test-tools:${provider}`,
        });
        if (r2.ok) {
          const turn2 = adapter.parseResponse(await r2.json().catch(() => undefined));
          toolsOk = !!(turn2.calls.length || turn2.text);
        }
      } catch { toolsOk = false; }
    }
    return { ok: true, details: { provider, model: cleanModel, ms: Date.now() - start, toolsOk, modelsListed: models.length, ...(listError ? { listError } : {}) } };
  } catch (e) {
    if (t.timedOut() && !parentSignal?.aborted) return { ok: false, error: providerError('timeout', 'test timed out') };
    return { ok: false, error: toProviderError(e) };
  } finally {
    t.done();
  }
}
