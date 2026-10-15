import type { NormalizedRequest, ProviderAdapter, ToolTurn } from '../types';
import { stripTrailingSlash } from '../base';
import { capabilitiesFor } from './capabilities';
import { parseError } from './errors';
import { assertVision, toOpenAIContent } from '../vision';
import { assertAttachments, getAttachmentCapabilities } from '../attachments';

const BASE = 'https://api.openai.com/v1';

function listModels(apiKey: string, baseUrl?: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const base = stripTrailingSlash(baseUrl || BASE);
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
  chatEndpoint: (b) => `${stripTrailingSlash(b || BASE)}/chat/completions`,
  headers: (k) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }),
  listModels,
  buildRequest(model, req: NormalizedRequest, baseUrl?: string) {
    const caps = capabilitiesFor(model);
    assertVision(req, caps);
    assertAttachments(req, getAttachmentCapabilities('openai', model, caps));
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
      } else if (m.role === 'system' && caps.supportsDeveloperRole && caps.reasoningAware) {
        messages.push({ role: 'developer', content: typeof m.content === 'string' ? m.content : toOpenAIContent(m.content) });
      } else {
        messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : toOpenAIContent(m.content) });
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
      // why: o1/o3/gpt-5/gpt-6 tool calls fail unless reasoning is off
      if (/\bo1\b|\bo3\b|gpt-5|gpt-6|o[34](-mini)?\b/i.test(model)) body.reasoning_effort = 'none';
      else if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
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
