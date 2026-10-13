import { PROVIDER_DEFS, mapHttpError, toNexioError, type ChatOptions } from './providers';
import type { ProviderId } from '../../shared/types';

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
  const def = PROVIDER_DEFS[provider];
  const fetchFn = opts.fetchFn || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 60_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(def.chatEndpoint(opts.baseUrl || def.defaultBaseUrl), {
      method: 'POST',
      headers: def.headers(opts.apiKey),
      body: JSON.stringify(def.buildBody(opts.model, opts.messages, opts.temperature)),
      signal: opts.signal ? anySignal([opts.signal, ctrl.signal]) : ctrl.signal,
    }).catch((e) => { throw toNexioError(e); });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw mapHttpError(res.status, text);
    }
    if (!res.body) {
      // Non-streaming fallback
      const json = await res.json().catch(() => undefined);
      const msg = def.extractMessage(json) || '';
      if (!msg) throw { code: 'unknown', message: 'Empty response from provider' };
      opts.onToken?.(msg);
      return msg;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let sawPayload = false;
    for (;;) {
      if (opts.signal?.aborted) throw { code: 'aborted', message: 'Aborted' };
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = feedSSE(buf, (data) => {
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          sawPayload = true;
          const delta = def.extractDelta(json) || '';
          if (delta) { full += delta; opts.onToken?.(delta); }
        } catch { /* ignore keep-alive */ }
      });
    }
    if (!sawPayload) throw { code: 'unknown', message: 'Empty response from provider' };
    return full;
  } catch (e) {
    throw toNexioError(e);
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
