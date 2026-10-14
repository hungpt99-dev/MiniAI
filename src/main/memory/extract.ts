import type { ChatMessage } from '../../shared/types';
import { streamChat } from '../ai/stream';
import { memoryHash, REMEMBER_RE } from './types';

/** True when the user explicitly asks to remember something. */
export function isExplicitRemember(text: string): boolean {
  const t = text.trim();
  // Questions recall ("do you remember ...?") — they never store.
  if (/\?\s*$/.test(t)) return false;
  if (/^(do|did|can|could|would|will|shall|have|has|had)\s+you\s+remember\b/i.test(t)) return false;
  return REMEMBER_RE.test(t);
}

const FOLDER_HINT_RE = /\b(never|don't|do not|keep out|folder|directory|file|touch|delete|modify)\b/i;
const PREF_HINT_RE = /\b(prefer|likes?|always|reply|answer|language|vietnamese|english|speak|write)\b/i;
const PROC_HINT_RE = /\b(steps?|procedure|cleanup|weekly|backup|routine|process)\b/i;

/** Best-guess kind for an explicit "remember ..." record. */
export function guessKind(text: string): import('../../shared/types').MemoryKind {
  if (FOLDER_HINT_RE.test(text)) return 'folder_rule';
  if (PREF_HINT_RE.test(text)) return 'preference';
  if (PROC_HINT_RE.test(text)) return 'procedure';
  return 'fact';
}

/**
 * Strip an explicit-remember wrapper down to the record text
 * ("remember that I prefer PDFs" -> "I prefer PDFs").
 */
export function rememberRecordText(text: string): string {
  return text
    .trim()
    .replace(/^(please\s+)?(remember|ghi nh[ớo]|hãy nh[ớo])\s+(that|this|to\s+)?/i, '')
    .replace(/\bfrom now on[,:]?\s*/i, '')
    .trim()
    .replace(/^[.,;:!?]+|[.,;:!?]+$/g, '')
    .trim();
}

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
    const t = line.replace(/^[-*\d.)\s]+/, '').trim();
    if (!t || t.length < 12 || t.length > 300) continue;
    if (dismissedSet.has(memoryHash(t))) continue;
    if (/password|secret|token|api[_-]?key|private key/i.test(t)) continue;
    out.push(t.slice(0, 300));
    if (out.length >= 3) break;
  }
  return out;
}
