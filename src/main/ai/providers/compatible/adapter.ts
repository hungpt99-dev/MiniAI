import type { NormalizedRequest, ProviderAdapter, ToolTurn } from '../types';
import { stripTrailingSlash } from '../base';
import { capabilitiesFor } from './capabilities';
import { parseError } from './errors';
import { VisionNotSupportedError, assertVision, toOpenAIContent } from '../vision';

const BASE = 'http://localhost:11434/v1';

/** Local servers usually ignore unknown fields instead of 400ing — keep bodies small. */
export const compatibleAdapter: ProviderAdapter = {
  id: 'compatible',
  label: 'OpenAI-compatible',
  defaultBaseUrl: BASE,
  chatEndpoint: (b) => `${stripTrailingSlash(b || BASE)}/chat/completions`,
  headers: (k) => ({ 'Content-Type': 'application/json', ...(k ? { Authorization: `Bearer ${k}` } : {}) }),
  listModels(apiKey, baseUrl?: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string[]> {
    const base = stripTrailingSlash(baseUrl || BASE);
    return fetchFn(`${base}/models`, { headers: (compatibleAdapter.headers(apiKey)) as HeadersInit, signal })
      .then((r) => (r.ok ? r.json().catch(() => undefined) : undefined))
      .then((j) => {
        const ids = (j as { data?: Array<{ id?: string; name?: string }> } | undefined)?.data
          ?.map((d) => d.id || d.name).filter((x): x is string => !!x) || [];
        return ids;
      })
      .catch(() => []);
  },
  buildRequest(model, req: NormalizedRequest, baseUrl?: string) {
    const caps = capabilitiesFor(model);
    // Compatible image mode: Off blocks images locally; Auto (default) probes by sending.
    if ((req.imageMode || 'auto') === 'off') {
      let n = 0;
      for (const m of req.messages) if (Array.isArray((m as { content?: unknown }).content)) n += ((m as { content: Array<{ type?: string }> }).content).filter((p) => p?.type === 'image').length;
      if (n > 0) throw new VisionNotSupportedError(n);
    } else assertVision(req, caps);
    const messages: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: typeof m.content === 'string' ? (m.content || null) : toOpenAIContent(m.content),
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        });
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else {
        messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : toOpenAIContent(m.content) });
      }
    }
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: req.stream,
    };
    // Local backends often 400 on sampling params — only send what the caller set
    // and the model row allows (settings toggle maps to temperature undefined).
    if (req.temperature !== undefined && caps.supportsTemperature) body.temperature = req.temperature;
    if (req.stop?.length) body.stop = req.stop;
    const limit = caps.limitParam === 'auto' ? 'max_tokens' : caps.limitParam;
    body[limit] = req.maxOutputTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }
    return { url: compatibleAdapter.chatEndpoint(baseUrl), headers: compatibleAdapter.headers(''), body };
  },
  parseResponse(json: unknown): ToolTurn {
    const msg = (json as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> })
      ?.choices?.[0]?.message;
    const calls = (msg?.tool_calls || []).map((c) => {
      let input: unknown = {};
      try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* keep {} */ }
      return { id: c.id, name: c.function.name, input };
    });
    // Tool detection fallback: servers without tool support return text only — valid.
    return { text: msg?.content || '', calls };
  },
  parseStreamEvent(json: unknown): string | undefined {
    return (json as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> })
      ?.choices?.[0]?.delta?.content
      || (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content
      || undefined;
  },
  parseError,
  capabilitiesFor,
};
