import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryScope, MemorySource } from '../../shared/types';
import type { Tool } from '../agent/types';
import { scanSecretsText } from '../../shared/attachments';
import {
  deleteMemory,
  getMemory,
  isMemoryKind,
  saveMemory,
  searchMemories,
  updateMemory,
} from './store';
import { blockedMemoryText, MEMORY_TEXT_CAP } from './types';

const KIND_PROP = { type: 'string', description: 'preference | fact | folder_rule | procedure | episode' };

function cap(s: string): string {
  return s.length > MEMORY_TEXT_CAP ? s.slice(0, MEMORY_TEXT_CAP) : s;
}

function fmtScope(sc: MemoryScope): string {
  if (sc.type === 'global') return 'global';
  if (sc.type === 'folder') return sc.path;
  if (sc.type === 'app') return `app:${sc.name}`;
  return `project:${sc.id}`;
}

function line(id: string, kind: string, text: string, sc: MemoryScope): string {
  return `- ${id} [${kind}] (${fmtScope(sc)}) ${cap(text)}`;
}

/** True for memory writes (provenance gate + forget-many rule apply in the loop). */
export function isMemoryWriteTool(name: string): boolean {
  return name === 'memory_save' || name === 'memory_update' || name === 'memory_forget';
}

/** How many items a forget call would delete (query resolved now, for the approval card). */
export function memoryForgetCount(db: DatabaseSync, input: Record<string, unknown>): number {
  try {
    if (Array.isArray(input.ids)) return (input.ids as unknown[]).filter((x) => typeof x === 'string').length;
    if (typeof input.id === 'string') return input.id ? 1 : 0;
    if (typeof input.query === 'string' && input.query.trim()) {
      return searchMemories(db, input.query, { limit: 50 }).length;
    }
  } catch { /* approval-side: assume one */ }
  return 1;
}

function parseScopeInput(v: unknown): MemoryScope | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    if (!v.trim() || v === 'global') return { type: 'global' };
    return { type: 'folder', path: v.trim() };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'folder' && typeof o.path === 'string') return { type: 'folder', path: o.path };
    if (o.type === 'app' && typeof o.name === 'string') return { type: 'app', name: o.name };
    if (o.type === 'project' && typeof o.id === 'string') return { type: 'project', id: o.id };
  }
  return { type: 'global' };
}

/** Memory tools. Writes always need approval; the loop forces it after untrusted reads. */
export function makeMemoryTools(db: DatabaseSync, opts: { maxItems?: number } = {}): Tool[] {
  const search: Tool = {
    name: 'memory_search',
    description: 'Search what Nexio remembers about the user (id + text, capped). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        kinds: { type: 'string', description: 'Comma-separated kinds to include (default all)' },
        limit: { type: 'number', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
    risk: 'read',
    askSafe: true,
    describe: (input) => `Search memory: ${String(input.query || '')}`,
    run: async (input) => {
      const q = String(input.query || '').trim();
      if (!q) return { ok: false, output: 'query is required' };
      const kinds = typeof input.kinds === 'string' && input.kinds.trim()
        ? input.kinds.split(',').map((k) => k.trim()).filter(isMemoryKind)
        : undefined;
      const limit = Math.min(Number(input.limit) || 8, 20);
      try {
        const found = searchMemories(db, q, { kinds, limit });
        if (!found.length) return { ok: true, output: 'No matching memories.' };
        return { ok: true, output: found.map((m) => line(m.id, m.kind, m.text, m.scope)).join('\n') };
      } catch (e) {
        return { ok: false, output: `memory search failed: ${(e as Error).message}` };
      }
    },
  };

  const save: Tool = {
    name: 'memory_save',
    description: 'Remember one thing about the user (preference, fact, folder rule, procedure). Runs the secrets check; blocked text is refused. Changes only Nexio\'s own memory store, never user files.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: KIND_PROP,
        text: { type: 'string', description: 'One short record (cap 300 chars)' },
        scope: { type: 'string', description: 'global or an absolute folder path (default global)' },
        pinned: { type: 'boolean', description: 'Pin so it never expires' },
      },
      required: ['kind', 'text'],
    },
    risk: 'write',
    askSafe: false,
    describe: (input) => `Remember [${String(input.kind || '')}]: ${cap(String(input.text || ''))}`,
    run: async (input) => {
      const kind = input.kind as MemoryKind;
      if (!isMemoryKind(kind)) return { ok: false, output: 'unknown kind' };
      try {
        const r = saveMemory(db, {
          kind,
          text: String(input.text || ''),
          scope: parseScopeInput(input.scope),
          source: 'user_approved', // tool runs only after the approval card
          ...(input.pinned === true ? { pinned: true } : {}),
        }, { maxItems: opts.maxItems ?? 500 });
        if (r.status === 'saved') return { ok: true, output: `Remembered: ${cap(r.memory.text)}` };
        if (r.status === 'updated') return { ok: true, output: `Updated existing memory: ${cap(r.memory.text)}` };
        if (r.status === 'conflict') {
          return { ok: false, output: `Conflicts with: ${r.conflicts.map((c) => cap(c.text)).join(' | ')}. Ask the user whether to replace it.` };
        }
        if (r.status === 'full') return { ok: false, output: 'Memory is full (500). Ask the user to clean up.' };
        return { ok: false, output: `Not saved: ${r.reason}` };
      } catch (e) {
        return { ok: false, output: `memory save failed: ${(e as Error).message}` };
      }
    },
  };

  const update: Tool = {
    name: 'memory_update',
    description: 'Edit the text of one remembered item by id. Secrets check applies.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id' },
        text: { type: 'string', description: 'New text (cap 300 chars)' },
      },
      required: ['id', 'text'],
    },
    risk: 'write',
    askSafe: false,
    describe: (input) => `Edit memory ${String(input.id || '')}: ${cap(String(input.text || ''))}`,
    run: async (input) => {
      try {
        const r = updateMemory(db, String(input.id || ''), String(input.text || ''));
        if (r === null) return { ok: false, output: 'unknown memory id' };
        if ('blocked' in r) return { ok: false, output: `Not saved: ${r.blocked}` };
        return { ok: true, output: `Updated: ${cap(r.text)}` };
      } catch (e) {
        return { ok: false, output: `memory update failed: ${(e as Error).message}` };
      }
    },
  };

  const forget: Tool = {
    name: 'memory_forget',
    description: 'Forget remembered items by id or query. Deleting several items shows a confirmation listing them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id' },
        query: { type: 'string', description: 'Forget all matches (confirmed with a list first)' },
      },
    },
    risk: 'write',
    askSafe: false,
    describe: (input) => {
      try {
        if (typeof input.query === 'string' && input.query.trim()) {
          const found = searchMemories(db, input.query, { limit: 50 });
          if (!found.length) return `Forget matching "${input.query}": nothing found`;
          return `Forget ${found.length} memories matching "${input.query}":\n${found.slice(0, 10).map((m) => line(m.id, m.kind, m.text, m.scope)).join('\n')}`;
        }
      } catch { /* describe never throws */ }
      return `Forget memory ${String(input.id || '')}`;
    },
    run: async (input) => {
      try {
        if (typeof input.query === 'string' && input.query.trim()) {
          const found = searchMemories(db, input.query, { limit: 50 });
          for (const m of found) deleteMemory(db, m.id);
          return { ok: true, output: found.length ? `Forgot ${found.length} memories.` : 'Nothing matched.' };
        }
        const id = String(input.id || '');
        const cur = getMemory(db, id);
        if (!cur) return { ok: false, output: 'unknown memory id' };
        deleteMemory(db, id);
        return { ok: true, output: `Forgot: ${cap(cur.text)}` };
      } catch (e) {
        return { ok: false, output: `memory forget failed: ${(e as Error).message}` };
      }
    },
  };

  return [search, save, update, forget];
}

/** Direct (non-tool) save used by the confirmation row/card path. */
export function directSaveMemory(
  db: DatabaseSync,
  input: { kind: MemoryKind; text: string; scope?: MemoryScope; pinned?: boolean; source: MemorySource; link?: string },
  opts: { maxItems?: number; episodeDays?: number } = {},
) {
  const pre = blockedMemoryText(String(input.text || ''), scanSecretsText);
  if (pre) return { status: 'blocked' as const, reason: pre };
  return saveMemory(db, input, opts);
}
