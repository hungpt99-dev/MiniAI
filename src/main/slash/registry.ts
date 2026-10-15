import type { Mode, SlashMatch, SlashScope, SlashSource } from '../../shared/types';
import { filterByScope as filterScope } from '../../shared/mode-utils';

export interface SlashEntry extends SlashMatch {
  action?: string;
  scope?: SlashScope;
}

const BUILTINS: SlashEntry[] = [
  { trigger: '/help', label: 'Help', description: 'Show available commands', source: 'builtin', action: 'help', scope: 'all' },
  { trigger: '/new', label: 'New chat', description: 'Start a new conversation', source: 'builtin', action: 'new', scope: 'all' },
  { trigger: '/clear', label: 'Clear', description: 'Clear current messages', source: 'builtin', action: 'clear', scope: 'all' },
  { trigger: '/model', label: 'Model', description: 'Switch model (usage: /model <name>)', source: 'builtin', action: 'model', scope: 'chat' },
  { trigger: '/history', label: 'History', description: 'Show conversation history', source: 'builtin', action: 'history', scope: 'all' },
  { trigger: '/settings', label: 'Settings', description: 'Open settings', source: 'builtin', action: 'settings', scope: 'all' },
  { trigger: '/log', label: 'Agent log', description: 'Open the latest agent run log', source: 'builtin', action: 'log', scope: 'all' },
  { trigger: '/extensions', label: 'Extensions', description: 'Manage skills, MCP servers, hooks, workflows', source: 'builtin', action: 'extensions', scope: 'all' },
  { trigger: '/memory', label: 'Memory', description: 'View and edit what Nexio remembers', source: 'builtin', action: 'memory', scope: 'all' },
  { trigger: '/remember', label: 'Remember', description: 'Remember this (usage: /remember <text>)', source: 'builtin', action: 'remember', scope: 'all' },
  { trigger: '/forget', label: 'Forget', description: 'Forget a memory (usage: /forget <text>)', source: 'builtin', action: 'forget', scope: 'all' },
  { trigger: '/incognito', label: 'Incognito', description: 'Toggle incognito chat (no history, no memory)', source: 'builtin', action: 'incognito', scope: 'all' },
  { trigger: '/spawn', label: 'Spawn task', description: 'Run as a separate parallel task (usage: /spawn <text>)', source: 'builtin', action: 'spawn', scope: 'agent' },
  { trigger: '/queue', label: 'Queue task', description: 'Add to the task queue (usage: /queue <text>)', source: 'builtin', action: 'queue', scope: 'agent' },
  { trigger: '/tasks', label: 'Tasks', description: 'Open the Tasks view', source: 'builtin', action: 'tasks', scope: 'all' },
  { trigger: '/pin', label: 'Pin', description: 'Keep the window open (Alt+P)', source: 'builtin', action: 'pin', scope: 'all' },
  { trigger: '/cancel', label: 'Cancel task', description: 'Cancel a task (usage: /cancel <n>)', source: 'builtin', action: 'cancel', scope: 'all' },
  { trigger: '/clear-queue', label: 'Clear queue', description: 'Clear the waiting queue (asks first)', source: 'builtin', action: 'clear-queue', scope: 'all' },
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
  skills?: SlashEntry[];
  mcp?: SlashEntry[];
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
  (sources.skills || []).forEach((e) => push({ ...e, source: 'skill' as SlashSource }));
  (sources.mcp || []).forEach((e) => push({ ...e, source: 'mcp' as SlashSource }));
  return out;
}

export function rankMatches(entries: SlashEntry[], query: string, limit = 50): SlashEntry[] {
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

export function querySlash(entries: SlashEntry[], text: string, limit = 50, mode?: Mode): SlashEntry[] {
  const m = text.match(/\/([A-Za-z0-9_-]*)$/);
  if (!m) return [];
  const scoped = mode ? filterScope(entries, mode) : entries;
  return rankMatches(scoped, m[1], limit);
}

/** Pure scope filter re-export for tests/consumers. */
export function filterByScope(entries: SlashEntry[], mode: Mode): SlashEntry[] {
  return filterScope(entries, mode);
}

export interface ResolveResult {
  found?: SlashEntry;
  suggestions: SlashEntry[];
}

/** Exact resolve; unknown trigger returns top-3 fuzzy suggestions. */
export function resolveSlash(entries: SlashEntry[], trigger: string, mode?: Mode): ResolveResult {
  const found = entries.find((e) => e.trigger === trigger);
  if (found) {
    if (mode && found.scope && found.scope !== 'all' && found.scope !== mode) {
      return { found, suggestions: [] }; // caller reports scope mismatch
    }
    return { found, suggestions: [] };
  }
  const q = trigger.replace(/^\//, '');
  return { suggestions: rankMatches(entries, q, 3) };
}
