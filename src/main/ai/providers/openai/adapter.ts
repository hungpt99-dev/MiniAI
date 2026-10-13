import type { NormalizedRequest, ProviderAdapter, ToolTurn } from '../types';
import { capabilitiesFor } from './capabilities';
import { parseError } from './errors';

const BASE = 'https://api.openai.com/v1';

function listModels(apiKey: string, baseUrl?: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const base = baseUrl || BASE;
  return fetchFn(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
    .then((r) => (r.ok ? r.json().catch(() => undefined) : undefined))
    .then((j) => {
      const ids = (j as { data?: Array<{ id?: string }> } | undefined)?.data
        ?.map((d) => d.id).filter((x): x is string => !!x) || [];
      return ids;
    })
    .catch(() => []);
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: BASE,
  chatEndpoint: (b) => `${b || BASE}/chat/completions`,
  headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
  listModels,
  buildRequest(model, req: NormalizedRequest, baseUrl?: string) {
    const caps = capabilitiesFor(model);
    const messages: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        });
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === 'system' && caps.supportsDeveloperRole && caps.reasoningAware) {
        messages.push({ role: 'developer', content: m.content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const body: Record<string, unknown> = { model, messages, stream: req.stream };
    // Reasoning models reject sampling params — send only when supported.
    if (req.temperature !== undefined && caps.supportsTemperature) body.temperature = req.temperature;
    if (req.topP !== undefined && caps.supportsTopP) body.top_p = req.topP;
    if (req.stop?.length) body.stop = req.stop;
    if (req.stream && caps.streamUsage) body.stream_options = { include_usage: true };
    const limit = caps.limitParam === 'auto' ? 'max_completion_tokens' : caps.limitParam;
    body[limit] = req.maxOutputTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }
    return { url: openaiAdapter.chatEndpoint(baseUrl), headers: openaiAdapter.headers(''), body };
  },
  parseResponse(json: unknown): ToolTurn {
    const msg = (json as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> })
      ?.choices?.[0]?.message;
    const calls = (msg?.tool_calls || []).map((c) => {
      let input: unknown = {};
      try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* keep {} */ }
      return { id: c.id, name: c.function.name, input };
    });
    return { text: msg?.content || '', calls };
  },
  parseStreamEvent(json: unknown): string | undefined {
    return (json as { choices?: Array<{ delta?: { content?: string } }> })?.choices?.[0]?.delta?.content || undefined;
  },
  parseError,
  capabilitiesFor,
};
