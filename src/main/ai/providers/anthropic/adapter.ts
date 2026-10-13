import type { NormalizedRequest, ProviderAdapter, ToolTurn } from '../types';
import { stripTrailingSlash } from '../base';
import { capabilitiesFor } from './capabilities';
import { parseError } from './errors';

const BASE = 'https://api.anthropic.com';
const VERSION = '2023-06-01';

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  defaultBaseUrl: BASE,
  chatEndpoint: (b) => `${stripTrailingSlash(b || BASE)}/v1/messages`,
  // why: direct-browser flag keeps the same headers in Electron + tests
  headers: (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }),
  // Anthropic exposes no list-models endpoint — suggestions come from the model input.
  listModels: async () => [],
  buildRequest(model, req: NormalizedRequest, baseUrl?: string) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const messages: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: Array<Record<string, unknown>> = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
        messages.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
      } else {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }
    }
    const body: Record<string, unknown> = {
      model,
      ...(system ? { system } : {}),
      messages,
      max_tokens: req.maxOutputTokens,
      stream: req.stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Anthropic rejects temperature+top_p combos — temperature wins.
    else if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop?.length) body.stop_sequences = req.stop;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }
    return { url: anthropicAdapter.chatEndpoint(baseUrl), headers: anthropicAdapter.headers(''), body };
  },
  parseResponse(json: unknown): ToolTurn {
    const blocks = (json as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> })?.content || [];
    let text = '';
    const calls: ToolTurn['calls'] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) text += b.text;
      else if (b.type === 'tool_use' && b.id && b.name) calls.push({ id: b.id, name: b.name, input: b.input ?? {} });
    }
    return { text, calls };
  },
  parseStreamEvent(json: unknown): string | undefined {
    // Anthropic streams content_block_delta events with delta.text.
    return (json as { delta?: { text?: string } })?.delta?.text || undefined;
  },
  parseError,
  capabilitiesFor,
};
