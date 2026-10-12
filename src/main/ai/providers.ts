import type { ChatMessage, MiniAIError, ProviderId } from '../../shared/types';

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

export interface ProviderDef {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  chatEndpoint(baseUrl?: string): string;
  headers(apiKey: string): Record<string, string>;
  buildBody(model: string, messages: ChatMessage[], temperature?: number): unknown;
  extractDelta(json: unknown): string | undefined;
  extractMessage(json: unknown): string | undefined;
}

function msgs(o: ChatOptions): Array<{ role: string; content: string }> {
  return o.messages.map((m) => ({ role: m.role, content: m.content }));
}

export const PROVIDER_DEFS: Record<ProviderId, ProviderDef> = {
  openai: {
    id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1',
    chatEndpoint: (b) => `${b || 'https://api.openai.com/v1'}/chat/completions`,
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
    buildBody: (model, messages, temperature) => ({ model, messages: msgs({ messages } as ChatOptions), temperature, stream: true }),
    extractDelta: (j) => (j as { choices?: Array<{ delta?: { content?: string } }> })?.choices?.[0]?.delta?.content,
    extractMessage: (j) => (j as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content,
  },
  compatible: {
    id: 'compatible', label: 'OpenAI-compatible', defaultBaseUrl: 'http://localhost:11434/v1',
    chatEndpoint: (b) => `${b || 'http://localhost:11434/v1'}/chat/completions`,
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
    buildBody: (model, messages, temperature) => ({ model, messages: msgs({ messages } as ChatOptions), temperature, stream: true }),
    extractDelta: (j) => (j as { choices?: Array<{ delta?: { content?: string } }> })?.choices?.[0]?.delta?.content,
    extractMessage: (j) => (j as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content,
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com',
    chatEndpoint: (b) => `${b || 'https://api.anthropic.com'}/v1/messages`,
    headers: (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }),
    buildBody: (model, messages, temperature) => {
      const ms = msgs({ messages } as ChatOptions);
      const system = ms.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const rest = ms.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      return { model, system: system || undefined, messages: rest, max_tokens: 1024, temperature, stream: true };
    },
    extractDelta: (j) => (j as { delta?: { text?: string } })?.delta?.text,
    extractMessage: (j) => (j as { content?: Array<{ text?: string }> })?.content?.map((c) => c.text || '').join(''),
  },
  gemini: {
    id: 'gemini', label: 'Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    chatEndpoint: (b) => `${b || 'https://generativelanguage.googleapis.com'}/v1beta/openai/chat/completions`,
    headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
    buildBody: (model, messages, temperature) => ({ model, messages: msgs({ messages } as ChatOptions), temperature, stream: true }),
    extractDelta: (j) => (j as { choices?: Array<{ delta?: { content?: string } }> })?.choices?.[0]?.delta?.content,
    extractMessage: (j) => (j as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content,
  },
};

export function mapHttpError(status: number, bodyText: string): MiniAIError {
  if (status === 401 || status === 403) return { code: 'auth', message: `Authentication failed (${status})` };
  if (status === 429) return { code: 'rate-limit', message: 'Rate limited (429)' };
  if (status === 404 || status === 400) {
    if (/model/i.test(bodyText)) return { code: 'model', message: `Model error (${status}): ${bodyText.slice(0, 200)}` };
    return { code: 'unknown', message: `Request failed (${status}): ${bodyText.slice(0, 200)}` };
  }
  if (status >= 500) return { code: 'network', message: `Server error (${status})` };
  return { code: 'unknown', message: `Request failed (${status}): ${bodyText.slice(0, 200)}` };
}

export function toMiniAIError(e: unknown): MiniAIError {
  if (e && typeof e === 'object' && 'code' in e) return e as MiniAIError;
  const err = e as Error;
  if (err?.name === 'AbortError') return { code: 'aborted', message: 'Aborted' };
  if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(err?.message || '')) return { code: 'timeout', message: err.message };
  if (/fetch failed|network|ENOTFOUND|ECONN/i.test(err?.message || '')) return { code: 'network', message: err.message };
  return { code: 'unknown', message: err?.message || String(e) };
}

export async function testConnectivity(provider: ProviderId, apiKey: string, model: string, baseUrl?: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; error?: MiniAIError }> {
  try {
    const def = PROVIDER_DEFS[provider];
    const res = await fetchFn(def.chatEndpoint(baseUrl || def.defaultBaseUrl), {
      method: 'POST',
      headers: def.headers(apiKey || 'test'),
      body: JSON.stringify({ ...(def.buildBody(model, [{ id: 't', role: 'user', content: 'ping', createdAt: 0 }]) as object), stream: false, max_tokens: 1 } as object),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    // 400 on ping often means auth OK but payload rejected — treat as reachable but report model error distinctly.
    return { ok: false, error: mapHttpError(res.status, text) };
  } catch (e) {
    return { ok: false, error: toMiniAIError(e) };
  }
}
