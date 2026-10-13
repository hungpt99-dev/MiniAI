import { getAdapter, DEFAULT_MAX_OUTPUT_TOKENS } from './providers/index';
import { fetchWithRetry } from './providers/retry';
import { toProviderError } from './errors/provider-error';
import type { ProviderId } from '../../shared/types';
import type { Tool } from '../agent/types';
import type { NormalizedMessage } from './providers/types';

/** Provider-agnostic conversation item with full tool fidelity (DB stays plain text). */
export type AgentMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: Array<{ id: string; name: string; input: unknown }> }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface RequestedCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolTurn {
  text: string;
  calls: RequestedCall[];
}

export interface ToolChatOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  messages: AgentMsg[];
  tools: Tool[];
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

function toNeutralMessages(messages: AgentMsg[]): NormalizedMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}) };
    if (m.role === 'tool') return { role: 'tool' as const, toolCallId: m.toolCallId, toolName: m.toolName, content: m.content };
    return { role: m.role, content: m.content };
  });
}

/**
 * Single tool-calling turn behind one interface for all providers.
 * Request shape lives in each adapter — no provider literals here.
 */
export async function requestToolTurn(provider: ProviderId, opts: ToolChatOpts): Promise<ToolTurn> {
  if (opts.signal?.aborted) throw toProviderError({ kind: 'aborted', message: 'Aborted' });
  try {
    const adapter = getAdapter(provider);
    const built = adapter.buildRequest(opts.model, {
      messages: toNeutralMessages(opts.messages),
      tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      stream: false,
    }, opts.baseUrl || adapter.defaultBaseUrl);
    const res = await fetchWithRetry({
      adapter, model: opts.model, baseUrl: opts.baseUrl || adapter.defaultBaseUrl,
      apiKey: opts.apiKey, body: built.body as Record<string, unknown>,
      signal: opts.signal, fetchFn: opts.fetchFn, streaming: false,
      debugLabel: `tools:${provider}`,
    }).catch((e) => { throw toProviderError(e); });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw adapter.parseError(res.status, text);
    }
    const json = await res.json().catch(() => undefined);
    const turn = adapter.parseResponse(json);
    return { text: turn.text, calls: turn.calls };
  } catch (e) {
    throw toProviderError(e);
  }
}
