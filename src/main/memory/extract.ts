import type { ChatMessage } from '../../shared/types';
import { scanSecretsText } from '../../shared/attachments';
import { graphemeLength, takeGraphemes } from '../../shared/text';
import { streamChat } from '../ai/stream';
import { blockedMemoryText, memoryHash } from './types';

export interface ExtractorDeps {
  provider: import('../../shared/types').ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Suggest 0–3 candidates from the conversation's USER messages ONLY.
 * Tool results, file contents, web/attachment/MCP output never enter here.
 */
export async function extractCandidates(
  history: ChatMessage[],
  dismissed: string[],
  deps: ExtractorDeps,
): Promise<string[]> {
  const users = history.filter((m) => m.role === 'user').map((m) => m.content).slice(-10);
  if (users.length < 2) return [];
  const dismissedSet = new Set(dismissed);
  let acc = '';
  try {
    await streamChat(deps.provider, {
      apiKey: deps.apiKey,
      model: deps.model,
      baseUrl: deps.baseUrl,
      temperature: 0,
      messages: [{
        id: 'mem-extract',
        role: 'user',
        content: 'List durable things to remember about the user from THESE USER MESSAGES ONLY (preferences, facts, folder rules, repeated procedures). One per line, each under 60 words, no secrets or credentials. Reply with at most 3 lines, or "none".\n---\n' +
          users.map((u) => String(u).slice(0, 1000)).join('\n---\n'),
        createdAt: Date.now(),
      }],
      signal: deps.signal,
      onToken: (t) => { acc += t; },
    });
  } catch {
    return []; // extractor never breaks runs
  }
  if (/^\s*none\s*$/i.test(acc.trim())) return [];
  const out: string[] = [];
  for (const line of acc.split('\n')) {
    const t = takeGraphemes(line.replace(/^[-*\d.)\s]+/, '').trim(), 300);
    if (!t || graphemeLength(t) < 12 || graphemeLength(t) > 300) continue;
    if (dismissedSet.has(memoryHash(t))) continue;
    // why: single structural scanner, no per-language word list.
    if (blockedMemoryText(t, scanSecretsText)) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}
