import { PROVIDER_DEFS, mapHttpError, toNexioError } from './providers';
import type { ProviderId } from '../../shared/types';
import type { Tool } from '../agent/types';
import { toProviderTools } from '../agent/tools/registry';

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

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function requestOpenAICompatible(
  provider: ProviderId,
  opts: ToolChatOpts,
): Promise<ToolTurn> {
  const def = PROVIDER_DEFS[provider];
  const fetchFn = opts.fetchFn || fetch;
  const messages: Array<Record<string, unknown>> = [];
  for (const m of opts.messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        })),
      });
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const res = await fetchFn(def.chatEndpoint(opts.baseUrl || def.defaultBaseUrl), {
    method: 'POST',
    headers: def.headers(opts.apiKey),
    body: JSON.stringify({
      model: opts.model,
      messages,
      tools: toProviderTools(opts.tools),
      tool_choice: 'auto',
      stream: false,
    }),
    signal: opts.signal,
  }).catch((e) => { throw toNexioError(e); });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapHttpError(res.status, text);
  }
  const json = await res.json().catch(() => undefined) as
    | { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }
    | undefined;
  const msg = json?.choices?.[0]?.message;
  const calls: RequestedCall[] = (msg?.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function.name,
    input: parseArgs(c.function.arguments),
  }));
  return { text: msg?.content || '', calls };
}

async function requestAnthropic(opts: ToolChatOpts): Promise<ToolTurn> {
  const def = PROVIDER_DEFS.anthropic;
  const fetchFn = opts.fetchFn || fetch;
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const messages: Array<Record<string, unknown>> = [];
  for (const m of opts.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
      messages.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
    } else {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  const res = await fetchFn(def.chatEndpoint(opts.baseUrl || def.defaultBaseUrl), {
    method: 'POST',
    headers: def.headers(opts.apiKey),
    body: JSON.stringify({
      model: opts.model,
      system: system || undefined,
      messages,
      tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      max_tokens: 1024,
      stream: false,
    }),
    signal: opts.signal,
  }).catch((e) => { throw toNexioError(e); });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapHttpError(res.status, text);
  }
  const json = await res.json().catch(() => undefined) as
    | { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }
    | undefined;
  let text = '';
  const calls: RequestedCall[] = [];
  for (const b of json?.content || []) {
    if (b.type === 'text' && b.text) text += b.text;
    else if (b.type === 'tool_use' && b.id && b.name) calls.push({ id: b.id, name: b.name, input: b.input ?? {} });
  }
  return { text, calls };
}

/**
 * Single tool-calling turn behind one interface for all providers.
 * Reuses PROVIDER_DEFS endpoints/headers — no second set of clients.
 */
export async function requestToolTurn(provider: ProviderId, opts: ToolChatOpts): Promise<ToolTurn> {
  if (opts.signal?.aborted) throw { code: 'aborted', message: 'Aborted' };
  try {
    if (provider === 'anthropic') return await requestAnthropic(opts);
    return await requestOpenAICompatible(provider, opts);
  } catch (e) {
    throw toNexioError(e);
  }
}
