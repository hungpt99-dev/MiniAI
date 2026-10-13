import { RETRY_CACHE_TTL_MS, RETRY_MAX_ATTEMPTS_NON_STREAMING } from './constants';
import type { ProviderAdapter } from './types';

export interface ParamFix {
  drop?: string[];
  swapLimit?: 'max_tokens' | 'max_completion_tokens';
}

// shortcut: in-memory only — fixes are forgotten on restart, re-learned on next 400/422. Persist to settings if this annoys.
const cache = new Map<string, { fix: ParamFix; expires: number }>();

export function cacheKey(provider: string, baseUrl: string, model: string): string {
  return `${provider}|${baseUrl}|${model}`;
}

export function getCachedFix(provider: string, baseUrl: string, model: string): ParamFix | undefined {
  const e = cache.get(cacheKey(provider, baseUrl, model));
  if (!e) return undefined;
  if (Date.now() > e.expires) { cache.delete(cacheKey(provider, baseUrl, model)); return undefined; }
  return e.fix;
}

export function rememberFix(provider: string, baseUrl: string, model: string, fix: ParamFix): void {
  cache.set(cacheKey(provider, baseUrl, model), { fix, expires: Date.now() + RETRY_CACHE_TTL_MS });
}

/** Reset button + tests. */
export function resetParamCache(): void {
  cache.clear();
}

const LIMIT_PARAMS = ['max_tokens', 'max_completion_tokens'];
const DROPPABLE = ['temperature', 'top_p', 'top_k', 'stop', 'stream_options', 'response_format', 'reasoning', 'reasoning_effort', 'stop_sequences', 'tool_choice'];
// Unnamed 400s retry only the safest extras — dropping tool_choice/response_format would silently break tool calls.
const SAFE_FALLBACK_DROP = ['temperature', 'top_p', 'stream_options'];

/**
 * Detect an unsupported-param fix from a 400/422 body. Returns undefined when
 * the error is not param-shaped (no blind retries).
 */
export function detectParamFix(status: number, bodyText: string, sentBody: Record<string, unknown>): ParamFix | undefined {
  if (status !== 400 && status !== 422) return undefined;
  const m = bodyText || '';
  if (!/unsupported|unknown (parameter|argument|field)|unrecognized|not supported|additional properties|unexpected/i.test(m)) return undefined;
  const fix: ParamFix = {};
  const lower = m.toLowerCase();
  for (const p of DROPPABLE) {
    if (lower.includes(p) && p in sentBody) (fix.drop ||= []).push(p);
  }
  const hasMaxTokens = 'max_tokens' in sentBody;
  const hasMaxCompletion = 'max_completion_tokens' in sentBody;
  if (/max_tokens|max_completion_tokens|max output/i.test(m)) {
    if (hasMaxTokens) fix.swapLimit = 'max_completion_tokens';
    else if (hasMaxCompletion) fix.swapLimit = 'max_tokens';
  }
  // Param-shaped error but no named param: retry only safe extras, else give up (no blind cache).
  if (!fix.drop?.length && !fix.swapLimit) {
    const present = SAFE_FALLBACK_DROP.filter((p) => p in sentBody);
    if (present.length) fix.drop = present;
    else return undefined;
  }
  return fix;
}

export function applyFix(body: Record<string, unknown>, fix: ParamFix): Record<string, unknown> {
  const next = { ...body };
  for (const p of fix.drop || []) delete next[p];
  if (fix.swapLimit) {
    const other = fix.swapLimit === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    if (other in next && !(fix.swapLimit in next)) {
      next[fix.swapLimit] = next[other];
      delete next[other];
    }
  }
  // Keep both limit names out: some servers 400 when both are present.
  for (const p of LIMIT_PARAMS) {
    if (fix.swapLimit && p !== fix.swapLimit) delete next[p];
  }
  return next;
}

function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers?.get?.('retry-after');
  const secs = h ? Number(h) : NaN;
  const base = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 500 * 2 ** attempt;
  return Math.min(base + Math.random() * 250, 10_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryRequest {
  adapter: ProviderAdapter;
  model: string;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** True for SSE chats: single param retry, no 429/5xx backoff, never replay output. */
  streaming: boolean;
  debugLabel: string;
}

function logFix(label: string, action: string, params: string[]): void {
  // why: param names + action only — bodies may hold keys or prompts
  console.debug(`[provider-retry] ${label} ${action} params=${params.join(',') || '-'}`);
}

/**
 * Provider fetch with once-only param recovery and bounded rate/backoff retries.
 * Param fixes apply before any output exists, so tools/stream output never replay.
 */
export async function fetchWithRetry(o: RetryRequest): Promise<Response> {
  const fetchFn = o.fetchFn || fetch;
  const base = o.baseUrl || o.adapter.defaultBaseUrl;
  const url = o.adapter.chatEndpoint(base);
  const headers = o.adapter.headers(o.apiKey);
  let body = { ...o.body };
  const cached = getCachedFix(o.adapter.id, base, o.model);
  if (cached) {
    body = applyFix(body, cached);
    logFix(o.debugLabel, 'cached-fix', [...(cached.drop || []), cached.swapLimit || ''].filter(Boolean));
  }
  const post = (b: Record<string, unknown>) => fetchFn(url, {
    method: 'POST', headers, body: JSON.stringify(b), signal: o.signal,
  });
  let res = await post(body);
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const text = await res.text().catch(() => '');
    const fix = detectParamFix(res.status, text, body);
    if (fix && !cached) {
      rememberFix(o.adapter.id, base, o.model, fix);
      logFix(o.debugLabel, 'retry-once unsupported-param', [...(fix.drop || []), fix.swapLimit || ''].filter(Boolean));
      body = applyFix(body, fix);
      return post(body);
    }
    // Rebuild a failed body read for the caller to parse.
    return new Response(text, { status: res.status, headers: res.headers });
  }
  if (!o.streaming && !res.ok && (res.status === 429 || res.status >= 500)) {
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS_NON_STREAMING; attempt++) {
      const wait = retryAfterMs(res, attempt);
      logFix(o.debugLabel, `backoff ${res.status} attempt=${attempt + 1} wait=${Math.round(wait)}ms`, []);
      await sleep(wait);
      if (o.signal?.aborted) break;
      res = await post(body);
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
    }
  }
  return res;
}
