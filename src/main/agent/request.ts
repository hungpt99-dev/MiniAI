import type { ChatMessage } from '../../shared/types';
import type { AgentMsg } from '../ai/tools-chat';
import type { ContentPart } from '../ai/providers/types';

/** Seed window: newest turns win; the system prompt + newest user message always survive. */
export const MAX_SEED_MESSAGES = 20;

function textOf(content: string | ContentPart[]): string | null {
  if (typeof content === 'string') return content;
  for (const p of content) {
    if (p.type === 'text' && typeof p.text === 'string') return p.text;
  }
  return null;
}

function seedOne(m: ChatMessage): AgentMsg | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  return { role: m.role, content: m.content };
}

/**
 * One place that assembles the model turn: capped history (oldest dropped,
 * newest kept) + the new user message exactly once, last. Callers store the
 * user message in the conversation BEFORE building, so a trailing history
 * item identical to the new text is that same turn — drop it, never send it
 * twice. Repeated prompts ("list full file" twice) still work: dropping one
 * copy and appending the new text is a no-op for them.
 */
export function buildAgentMessages(
  history: ChatMessage[],
  userText: string,
  userParts?: ContentPart[],
): AgentMsg[] {
  const seed: AgentMsg[] = [];
  for (const m of history.slice(-MAX_SEED_MESSAGES)) {
    const s = seedOne(m);
    if (s) seed.push(s);
  }
  const incoming = userParts ?? userText;
  const incomingText = textOf(incoming);
  const last = seed[seed.length - 1];
  if (last && last.role === 'user' && incomingText !== null && textOf(last.content) === incomingText) {
    seed.pop();
  }
  seed.push({ role: 'user', content: incoming });
  return seed;
}
