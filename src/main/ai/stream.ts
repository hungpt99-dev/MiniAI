import { getAdapter, DEFAULT_MAX_OUTPUT_TOKENS, CHAT_TIMEOUT_MS } from './providers/index';
import { fetchWithRetry } from './providers/retry';
import { toProviderError } from './errors/provider-error';
import type { ProviderId } from '../../shared/types';
import type { ChatMessage } from '../../shared/types';

/** Back-compat chat options; temperature maps to the neutral request field. */
export interface ChatOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  fetchFn?: typeof fetch;
}

/** Parse SSE `data:` lines from a chunk, invoking cb for each JSON payload. Returns pending tail. */
export function feedSSE(buffer: string, onEvent: (data: string) => void): string {
  const parts = buffer.split('\n');
  const tail = parts.pop() || '';
  for (const line of parts) {
    const t = line.trim();
    if (t.startsWith('data:')) onEvent(t.slice(5).trim());
  }
  return tail;
}

export async function streamChat(provider: ProviderId, opts: ChatOptions): Promise<string> {
  const adapter = getAdapter(provider);
  const fetchFn = opts.fetchFn || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), CHAT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const built = adapter.buildRequest(opts.model, {
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
    }, opts.baseUrl || adapter.defaultBaseUrl);
    const res = await fetchWithRetry({
      adapter, model: opts.model, baseUrl: opts.baseUrl || adapter.defaultBaseUrl,
      apiKey: opts.apiKey, body: built.body as Record<string, unknown>,
      signal: opts.signal ? anySignal([opts.signal, ctrl.signal]) : ctrl.signal,
      fetchFn, streaming: true, debugLabel: `chat:${provider}`,
    }).catch((e) => { throw toProviderError(e); });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw adapter.parseError(res.status, text);
    }
    if (!res.body) {
      // Non-streaming fallback
      const json = await res.json().catch(() => undefined);
      const turn = adapter.parseResponse(json);
      if (!turn.text) throw toProviderError({ kind: 'unknown', message: 'Empty response from provider' });
      opts.onToken?.(turn.text);
      return turn.text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let sawPayload = false;
    for (;;) {
      if (opts.signal?.aborted) throw toProviderError({ kind: 'aborted', message: 'Aborted' });
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = feedSSE(buf, (data) => {
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          sawPayload = true;
          const delta = adapter.parseStreamEvent(json) || '';
          if (delta) { full += delta; opts.onToken?.(delta); }
        } catch { /* ignore keep-alive */ }
      });
    }
    if (!sawPayload) throw toProviderError({ kind: 'unknown', message: 'Empty response from provider' });
    return full;
  } catch (e) {
    throw toProviderError(e);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
