import type { NormalizedRequest, ProviderAdapter, ToolTurn } from '../types';
import { stripTrailingSlash } from '../base';
import { capabilitiesFor } from './capabilities';
import { parseError } from './errors';
import { assertVision, toAnthropicContent } from '../vision';
import { assertAttachments, getAttachmentCapabilities } from '../attachments';

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
    const caps = capabilitiesFor(model);
    assertVision(req, caps);
    assertAttachments(req, getAttachmentCapabilities('anthropic', model, caps));
    const systemParts: string[] = [];
    for (const m of req.messages) {
      if (m.role !== 'system') continue;
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(toAnthropicContent(m.content)));
    }
    const system = systemParts.join('\n');
    const messages: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: Array<Record<string, unknown>> = [];
        const tc = typeof m.content === 'string' ? m.content : toAnthropicContent(m.content);
        if (typeof tc === 'string') { if (tc) blocks.push({ type: 'text', text: tc }); }
        else for (const b of tc as Array<Record<string, unknown>>) blocks.push(b);
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
        messages.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
      } else {
        const c = typeof m.content === 'string' ? m.content : toAnthropicContent(m.content);
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
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
