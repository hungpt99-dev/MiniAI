import type { SlashMatch, SlashSource } from '../../shared/types';

export interface SlashEntry extends SlashMatch {
  action?: string;
}

const BUILTINS: SlashEntry[] = [
  { trigger: '/help', label: 'Help', description: 'Show available commands', source: 'builtin', action: 'help' },
  { trigger: '/new', label: 'New chat', description: 'Start a new conversation', source: 'builtin', action: 'new' },
  { trigger: '/clear', label: 'Clear', description: 'Clear current messages', source: 'builtin', action: 'clear' },
  { trigger: '/model', label: 'Model', description: 'Switch model (usage: /model <name>)', source: 'builtin', action: 'model' },
  { trigger: '/history', label: 'History', description: 'Show conversation history', source: 'builtin', action: 'history' },
];

function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (const ch of target) if (ch === query[i]) i++;
  return i === query.length;
}

export interface RegistrySources {
  prompts?: SlashEntry[];
  workflows?: SlashEntry[];
  user?: SlashEntry[];
}

/** Merge builtin + prompt + workflow + user entries. Later sources do not override builtins. */
export function buildRegistry(sources: RegistrySources = {}): SlashEntry[] {
  const seen = new Set<string>();
  const out: SlashEntry[] = [];
  const push = (e: SlashEntry) => {
    if (seen.has(e.trigger)) return;
    seen.add(e.trigger);
    out.push(e);
  };
  BUILTINS.forEach(push);
  (sources.prompts || []).forEach((e) => push({ ...e, source: 'prompt' as SlashSource }));
  (sources.workflows || []).forEach((e) => push({ ...e, source: 'workflow' as SlashSource }));
  (sources.user || []).forEach((e) => push({ ...e, source: 'user' as SlashSource }));
  return out;
}

export function rankMatches(entries: SlashEntry[], query: string, limit = 8): SlashEntry[] {
  const q = query.toLowerCase().replace(/^\//, '');
  if (!q) return entries.slice(0, limit);
  const scored: Array<{ e: SlashEntry; s: number }> = [];
  for (const e of entries) {
    const t = e.trigger.toLowerCase().replace(/^\//, '');
    if (t === q) scored.push({ e, s: 0 });
    else if (t.startsWith(q)) scored.push({ e, s: 1 });
    else if (t.includes(q)) scored.push({ e, s: 2 });
    else if (isSubsequence(q, t)) scored.push({ e, s: 3 });
  }
  scored.sort((a, b) => a.s - b.s || a.e.trigger.localeCompare(b.e.trigger));
  return scored.slice(0, limit).map((x) => x.e);
}

export function querySlash(entries: SlashEntry[], text: string, limit = 8): SlashEntry[] {
  const m = text.match(/\/([A-Za-z0-9_-]*)$/);
  if (!m) return [];
  return rankMatches(entries, m[1], limit);
}

export interface ResolveResult {
  found?: SlashEntry;
  suggestions: SlashEntry[];
}

/** Exact resolve; unknown trigger returns top-3 fuzzy suggestions. */
export function resolveSlash(entries: SlashEntry[], trigger: string): ResolveResult {
  const found = entries.find((e) => e.trigger === trigger);
  if (found) return { found, suggestions: [] };
  const q = trigger.replace(/^\//, '');
  return { suggestions: rankMatches(entries, q, 3) };
}
