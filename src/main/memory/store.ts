import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryScope, MemorySource } from '../../shared/types';
import { scanSecretsText } from '../../shared/attachments';
import { decryptText, encryptText } from '../store/secrets';
import {
  FORGET_ALL_CONFIRM,
  MEMORY_CONFLICT_JACCARD,
  MEMORY_DUPE_JACCARD,
  MEMORY_EPISODE_CAP,
  MEMORY_TEXT_CAP,
  blockedMemoryText,
  jaccard,
  memoryHash,
  memoryTokens,
  normalizeMemoryText,
  type Memory,
} from './types';

/** Single access layer for long-term memory. No other module touches these tables. */

const ftsOkCache = new WeakMap<DatabaseSync, boolean>();

/** Idempotent tables (+ best-effort FTS5 mirror for plaintext rows). */
export function ensureMemoryTables(db: DatabaseSync): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '{"type":"global"}', source TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL,
      useCount INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1, expiresAt INTEGER, link TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memoryId TEXT, event TEXT NOT NULL, ts INTEGER NOT NULL
    );
  `);
  let fts = ftsOkCache.get(db);
  if (fts === undefined) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);`);
      fts = true;
    } catch {
      fts = false; // plain LIKE/token scan still works
    }
    ftsOkCache.set(db, fts);
  }
  return fts;
}

function audit(db: DatabaseSync, memoryId: string | null, event: string, now: number): void {
  try {
    db.prepare('INSERT INTO memory_events (memoryId, event, ts) VALUES (?, ?, ?)').run(memoryId, event, now);
  } catch { /* audit never breaks saves */ }
}

function scopeKey(scope: MemoryScope): string {
  return JSON.stringify(scope);
}

function parseScope(raw: string): MemoryScope {
  try {
    const o = JSON.parse(raw) as MemoryScope;
    if (o && o.type === 'global') return { type: 'global' };
    if (o && o.type === 'folder' && typeof o.path === 'string') return o;
    if (o && o.type === 'app' && typeof o.name === 'string') return o;
    if (o && o.type === 'project' && typeof o.id === 'string') return o;
  } catch { /* fall through */ }
  return { type: 'global' };
}

interface DbRow {
  id: string; kind: string; text: string; scope: string; source: string;
  createdAt: number; updatedAt: number; lastUsedAt: number; useCount: number;
  pinned: number; confidence: number; expiresAt: number | null; link: string | null;
}

function fromRow(r: DbRow): Memory {
  return {
    id: r.id,
    kind: r.kind as MemoryKind,
    text: decryptText(r.text),
    scope: parseScope(r.scope),
    source: r.source as MemorySource,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
    useCount: r.useCount,
    pinned: r.pinned === 1,
    confidence: r.confidence,
    ...(r.expiresAt != null ? { expiresAt: r.expiresAt } : {}),
    ...(r.link ? { link: r.link } : {}),
  };
}

function allRows(db: DatabaseSync): Memory[] {
  ensureMemoryTables(db);
  const rows = db.prepare('SELECT * FROM memories ORDER BY updatedAt DESC').all() as unknown as DbRow[];
  return rows.map(fromRow);
}

function syncFts(db: DatabaseSync, id: string, storedText: string): void {
  if (!ftsOkCache.get(db)) return;
  try {
    db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
    // Only plaintext rows are mirrored (encrypted text never lands in FTS).
    if (storedText.startsWith('plain:')) {
      db.prepare('INSERT INTO memory_fts (id, text) VALUES (?, ?)').run(id, storedText.slice(6));
    }
  } catch { /* FTS is best-effort */ }
}

function ftsIds(db: DatabaseSync, q: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!ftsOkCache.get(db)) return out;
  try {
    const toks = [...memoryTokens(q)].slice(0, 10);
    if (!toks.length) return out;
    const match = toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const rows = db.prepare('SELECT id, rank FROM memory_fts WHERE text MATCH ? LIMIT 50').all(match) as Array<{ id: string; rank: number }>;
    for (const r of rows) out.set(r.id, r.rank);
  } catch { /* fall back to scan */ }
  return out;
}

function newId(): string {
  return `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function countMemories(db: DatabaseSync): number {
  ensureMemoryTables(db);
  const r = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  return r.n;
}

/** Approx store size in bytes (lengths only). */
export function memoryStoreBytes(db: DatabaseSync): number {
  ensureMemoryTables(db);
  try {
    const r = db.prepare('SELECT SUM(LENGTH(text) + LENGTH(scope)) AS n FROM memories').get() as { n: number | null };
    return r.n || 0;
  } catch {
    return 0;
  }
}

export function getMemory(db: DatabaseSync, id: string): Memory | null {
  ensureMemoryTables(db);
  const r = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as DbRow | undefined;
  return r ? fromRow(r) : null;
}

export interface SaveInput {
  kind: MemoryKind;
  text: string;
  scope?: MemoryScope;
  source: MemorySource;
  pinned?: boolean;
  confidence?: number;
  expiresAt?: number;
  link?: string;
}

export type SaveResult =
  | { status: 'saved'; memory: Memory }
  | { status: 'updated'; memory: Memory }
  | { status: 'conflict'; conflicts: Memory[] }
  | { status: 'blocked'; reason: string }
  | { status: 'full' };

export function isMemoryKind(k: unknown): k is MemoryKind {
  return k === 'preference' || k === 'fact' || k === 'folder_rule' || k === 'procedure' || k === 'episode';
}

/**
 * Save with validation, secrets block, cap, dedupe and conflict detection.
 * Never writes when the text trips the secrets/PII scanner.
 */
export function saveMemory(
  db: DatabaseSync,
  input: SaveInput,
  opts: { now?: number; maxItems?: number; episodeDays?: number } = {},
): SaveResult {
  ensureMemoryTables(db);
  const now = opts.now ?? Date.now();
  const maxItems = opts.maxItems ?? 500;
  if (!isMemoryKind(input.kind)) return { status: 'blocked', reason: 'unknown kind' };
  let text = String(input.text || '').trim();
  if (!text) return { status: 'blocked', reason: 'empty' };
  const cap = input.kind === 'episode' ? MEMORY_EPISODE_CAP : MEMORY_TEXT_CAP;
  if (text.length > cap) text = text.slice(0, cap);
  const blocked = blockedMemoryText(text, scanSecretsText);
  if (blocked) return { status: 'blocked', reason: blocked };
  const scope = input.scope || { type: 'global' };
  const key = scopeKey(scope);
  const norm = normalizeMemoryText(text);
  const toks = memoryTokens(text);
  const rows = allRows(db).filter((m) => m.kind === input.kind);
  for (const m of rows) {
    if (normalizeMemoryText(m.text) === norm && scopeKey(m.scope) === key) {
      touch(db, m.id, now, Math.max(m.confidence, input.confidence ?? 1));
      audit(db, m.id, 'updated', now);
      const got = getMemory(db, m.id);
      return { status: 'updated', memory: got as Memory };
    }
  }
  if (countMemories(db) >= maxItems) return { status: 'full' };
  for (const m of rows) {
    if (scopeKey(m.scope) === key && jaccard(toks, memoryTokens(m.text)) >= MEMORY_DUPE_JACCARD) {
      updateMemoryText(db, m.id, text, now);
      const got = getMemory(db, m.id);
      return { status: 'updated', memory: got as Memory };
    }
  }
  // Same-kind + same-scope overlap with different text: ask to replace.
  if (input.kind === 'preference' || input.kind === 'fact') {
    const conflicts = rows.filter(
      (m) => scopeKey(m.scope) === key && jaccard(toks, memoryTokens(m.text)) >= MEMORY_CONFLICT_JACCARD,
    );
    if (conflicts.length) return { status: 'conflict', conflicts };
  }
  const id = newId();
  const { cipher } = encryptText(text);
  const expiresAt = input.expiresAt ?? (input.kind === 'episode' ? now + (opts.episodeDays ?? 30) * 86400_000 : undefined);
  db.prepare(
    `INSERT INTO memories (id, kind, text, scope, source, createdAt, updatedAt, lastUsedAt, useCount, pinned, confidence, expiresAt, link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(id, input.kind, cipher, key, input.source, now, now, now, input.pinned ? 1 : 0,
    input.confidence ?? 1, expiresAt ?? null, input.link ?? null);
  syncFts(db, id, cipher);
  audit(db, id, 'created', now);
  return { status: 'saved', memory: getMemory(db, id) as Memory };
}

function touch(db: DatabaseSync, id: string, now: number, confidence?: number): void {
  if (confidence === undefined) db.prepare('UPDATE memories SET updatedAt = ? WHERE id = ?').run(now, id);
  else db.prepare('UPDATE memories SET updatedAt = ?, confidence = ? WHERE id = ?').run(now, confidence, id);
}

function updateMemoryText(db: DatabaseSync, id: string, text: string, now: number): void {
  const { cipher } = encryptText(text);
  db.prepare('UPDATE memories SET text = ?, updatedAt = ? WHERE id = ?').run(cipher, now, id);
  syncFts(db, id, cipher);
  audit(db, id, 'updated', now);
}

/** Edit text (blocked on secrets, same as save). */
export function updateMemory(db: DatabaseSync, id: string, text: string, now = Date.now()): Memory | { blocked: string } | null {
  ensureMemoryTables(db);
  const cur = getMemory(db, id);
  if (!cur) return null;
  let t = String(text || '').trim();
  if (!t) return { blocked: 'empty' };
  const cap = cur.kind === 'episode' ? MEMORY_EPISODE_CAP : MEMORY_TEXT_CAP;
  if (t.length > cap) t = t.slice(0, cap);
  const blocked = blockedMemoryText(t, scanSecretsText);
  if (blocked) return { blocked };
  updateMemoryText(db, id, t, now);
  return getMemory(db, id);
}

export function setMemoryPin(db: DatabaseSync, id: string, pinned: boolean, now = Date.now()): Memory | null {
  ensureMemoryTables(db);
  db.prepare('UPDATE memories SET pinned = ?, updatedAt = ? WHERE id = ?').run(pinned ? 1 : 0, now, id);
  audit(db, id, pinned ? 'pinned' : 'unpinned', now);
  return getMemory(db, id);
}

export function setMemoryScope(db: DatabaseSync, id: string, scope: MemoryScope, now = Date.now()): Memory | null {
  ensureMemoryTables(db);
  db.prepare('UPDATE memories SET scope = ?, updatedAt = ? WHERE id = ?').run(scopeKey(scope), now, id);
  audit(db, id, 'edited', now);
  return getMemory(db, id);
}

export function deleteMemory(db: DatabaseSync, id: string, now = Date.now()): boolean {
  ensureMemoryTables(db);
  const cur = getMemory(db, id);
  if (!cur) return false;
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id); } catch { /* best-effort */ }
  audit(db, id, 'deleted', now);
  return true;
}

export function markUsed(db: DatabaseSync, ids: string[], now = Date.now()): void {
  ensureMemoryTables(db);
  const stmt = db.prepare('UPDATE memories SET useCount = useCount + 1, lastUsedAt = ? WHERE id = ?');
  for (const id of ids) {
    try {
      stmt.run(now, id);
      audit(db, id, 'used', now);
    } catch { /* never breaks runs */ }
  }
}

/** Token-overlap search over decrypted rows + FTS rank boost when available. */
export function searchMemories(
  db: DatabaseSync,
  q: string,
  opts: { kinds?: MemoryKind[]; limit?: number; includeExpired?: boolean; now?: number } = {},
): Memory[] {
  ensureMemoryTables(db);
  const now = opts.now ?? Date.now();
  const kinds = opts.kinds;
  const qtoks = memoryTokens(q);
  if (!qtoks.size) return [];
  const rows = allRows(db).filter(
    (m) => (!kinds || kinds.includes(m.kind)) && (opts.includeExpired || !m.expiresAt || m.expiresAt > now),
  );
  const fts = ftsIds(db, q);
  const scored: Array<{ m: Memory; s: number }> = [];
  for (const m of rows) {
    const mt = memoryTokens(m.text);
    let overlap = 0;
    for (const t of qtoks) if (mt.has(t)) overlap++;
    if (!overlap && !fts.has(m.id)) continue;
    // FTS rank is negative (better = more negative); overlap dominates.
    const s = overlap * 10 - (fts.get(m.id) ?? 0) / 100 + Math.min(m.useCount, 20) / 20;
    scored.push({ m, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, opts.limit ?? 20).map((x) => x.m);
}

export function listMemories(db: DatabaseSync, opts: { kind?: MemoryKind; q?: string; now?: number } = {}): Memory[] {
  ensureMemoryTables(db);
  const now = opts.now ?? Date.now();
  let rows = allRows(db).filter((m) => !m.expiresAt || m.expiresAt > now);
  if (opts.kind) rows = rows.filter((m) => m.kind === opts.kind);
  if (opts.q && opts.q.trim()) {
    const ids = new Set(searchMemories(db, opts.q, { now }).map((m) => m.id));
    rows = rows.filter((m) => ids.has(m.id));
  }
  return rows;
}

/** Non-pinned, non-episode items unused for staleDays: review list, never auto-deleted. */
export function staleMemories(db: DatabaseSync, staleDays: number, now = Date.now()): Memory[] {
  return allRows(db).filter(
    (m) => !m.pinned && m.kind !== 'episode' && (!m.expiresAt || m.expiresAt > now) &&
      now - m.lastUsedAt > staleDays * 86400_000,
  );
}

/** Delete expired, non-pinned rows. Returns the count removed. */
export function purgeExpired(db: DatabaseSync, now = Date.now()): number {
  ensureMemoryTables(db);
  const rows = db.prepare('SELECT id FROM memories WHERE pinned = 0 AND expiresAt IS NOT NULL AND expiresAt <= ?').all(now) as Array<{ id: string }>;
  for (const r of rows) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(r.id);
    try { db.prepare('DELETE FROM memory_fts WHERE id = ?').run(r.id); } catch { /* best-effort */ }
    audit(db, r.id, 'expired', now);
  }
  return rows.length;
}

export function exportMemories(db: DatabaseSync): string {
  const rows = allRows(db).map((m) => ({
    kind: m.kind, text: m.text, scope: m.scope, source: 'import' as const,
    pinned: m.pinned, confidence: m.confidence, ...(m.link ? { link: m.link } : {}),
  }));
  return JSON.stringify({ version: 1, memories: rows });
}

function validScope(o: unknown): o is MemoryScope {
  if (!o || typeof o !== 'object') return false;
  const s = o as Record<string, unknown>;
  return (s.type === 'global') ||
    (s.type === 'folder' && typeof s.path === 'string') ||
    (s.type === 'app' && typeof s.name === 'string') ||
    (s.type === 'project' && typeof s.id === 'string');
}

export interface ImportResult {
  imported: number; updated: number; skipped: number; errors: string[];
}

/** Validate + dedupe import. dryRun previews counts without writing. */
export function importMemories(db: DatabaseSync, json: string, opts: { now?: number; maxItems?: number; dry?: boolean } = {}): ImportResult {
  ensureMemoryTables(db);
  const out: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...out, errors: ['invalid JSON'] };
  }
  const list = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(list)) return { ...out, errors: ['missing memories array'] };
  if (list.length > 5000) return { ...out, errors: ['import too large (cap 5000)'] };
  list.forEach((item, i) => {
    const o = item as Record<string, unknown>;
    if (!isMemoryKind(o.kind) || typeof o.text !== 'string' || !o.text.trim() || (o.scope !== undefined && !validScope(o.scope))) {
      out.skipped++;
      out.errors.push(`row ${i}: invalid`);
      return;
    }
    if (opts.dry) {
      const norm = normalizeMemoryText(o.text);
      const dupe = allRows(db).some((m) => normalizeMemoryText(m.text) === norm);
      if (dupe) out.updated++;
      else out.imported++;
      return;
    }
    const r = saveMemory(db, {
      kind: o.kind, text: o.text, scope: (o.scope as MemoryScope) || { type: 'global' },
      source: 'import', pinned: o.pinned === true,
      ...(typeof o.confidence === 'number' ? { confidence: o.confidence } : {}),
      ...(typeof o.link === 'string' ? { link: o.link } : {}),
    }, opts);
    if (r.status === 'saved') out.imported++;
    else if (r.status === 'updated') out.updated++;
    else if (r.status === 'conflict') { out.skipped++; out.errors.push(`row ${i}: conflicts with an existing memory`); }
    else if (r.status === 'full') { out.skipped++; out.errors.push('store full'); }
    else { out.skipped++; out.errors.push(`row ${i}: ${r.reason}`); }
  });
  try {
    db.prepare('INSERT INTO memory_events (memoryId, event, ts) VALUES (?, ?, ?)').run(null, opts.dry ? 'import-preview' : 'import', opts.now ?? Date.now());
  } catch { /* audit never breaks */ }
  return out;
}

/** Delete everything (memories, FTS mirror, audit). Needs the exact typed confirmation. */
export function forgetAll(db: DatabaseSync, confirm: string): { deleted: boolean } {
  ensureMemoryTables(db);
  if (confirm !== FORGET_ALL_CONFIRM) return { deleted: false };
  db.prepare('DELETE FROM memories').run();
  try { db.prepare('DELETE FROM memory_fts').run(); } catch { /* best-effort */ }
  db.prepare('DELETE FROM memory_events').run();
  return { deleted: true };
}

/** Hash helper re-export for dismissed-suggestion tracking. */
export { memoryHash };
