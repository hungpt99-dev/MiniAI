import type { DatabaseSync } from 'node:sqlite';
import type { Task, TaskOrigin, TaskPriority, TaskState } from './taskTypes';
import { isTerminal } from './taskTypes';

/** Versioned persistence through the storage layer (own table, additive). */

interface TaskRow {
  id: string; title: string; prompt: string; origin: TaskOrigin;
  parentId: string | null; depth: number; priority: TaskPriority;
  state: TaskState; detail: string | null;
  createdAt: number; startedAt: number | null; endedAt: number | null;
  runId: string | null; undoGroupId: string | null;
  locks: string; resultSummary: string | null; snapshot: string;
  incognito: number;
}

export function ensureTaskTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
      origin TEXT NOT NULL, parentId TEXT, depth INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal', state TEXT NOT NULL DEFAULT 'queued',
      detail TEXT, createdAt INTEGER NOT NULL,
      startedAt INTEGER, endedAt INTEGER, runId TEXT, undoGroupId TEXT,
      locks TEXT NOT NULL DEFAULT '[]', resultSummary TEXT, snapshot TEXT NOT NULL DEFAULT '{}',
      incognito INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentId);
  `);
  for (const col of ['detail TEXT', 'undoGroupId TEXT', 'locks TEXT NOT NULL DEFAULT \'[]\'', 'resultSummary TEXT', 'incognito INTEGER NOT NULL DEFAULT 0']) {
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already there */ }
  }
}

function toTask(r: TaskRow): Task {
  const locks = (() => { try { const v = JSON.parse(r.locks || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })();
  const snapshot = (() => { try { return JSON.parse(r.snapshot || '{}'); } catch { return {}; } })();
  return {
    id: r.id, title: r.title, prompt: r.prompt, origin: r.origin,
    parentId: r.parentId, depth: r.depth, priority: r.priority,
    state: r.state, ...(r.detail ? { detail: r.detail } : {}),
    createdAt: r.createdAt,
    ...(r.startedAt != null ? { startedAt: r.startedAt } : {}),
    ...(r.endedAt != null ? { endedAt: r.endedAt } : {}),
    ...(r.runId ? { runId: r.runId } : {}),
    ...(r.undoGroupId ? { undoGroupId: r.undoGroupId } : {}),
    locks,
    ...(r.resultSummary ? { resultSummary: r.resultSummary } : {}),
    snapshot: {
      workingFolder: String(snapshot.workingFolder || ''),
      mode: 'do' as const,
      provider: String(snapshot.provider || ''),
      model: String(snapshot.model || ''),
      memorySnapshotIds: Array.isArray(snapshot.memorySnapshotIds) ? snapshot.memorySnapshotIds.map(String) : [],
      attachmentIds: Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.map(String) : [],
    },
  };
}

export function insertTask(db: DatabaseSync, t: Task, incognito = false): void {
  ensureTaskTables(db);
  db.prepare(`INSERT INTO tasks (id, title, prompt, origin, parentId, depth, priority, state, detail,
    createdAt, startedAt, endedAt, runId, undoGroupId, locks, resultSummary, snapshot, incognito)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    t.id, t.title, t.prompt, t.origin, t.parentId, t.depth, t.priority, t.state,
    t.detail || null, t.createdAt, t.startedAt ?? null, t.endedAt ?? null,
    t.runId ?? null, t.undoGroupId ?? null, JSON.stringify(t.locks || []),
    t.resultSummary ?? null, JSON.stringify(t.snapshot || {}), incognito ? 1 : 0,
  );
}

export function getTask(db: DatabaseSync, id: string): Task | null {
  ensureTaskTables(db);
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return r ? toTask(r) : null;
}

export function listTasks(db: DatabaseSync, opts: { includeIncognito?: boolean } = {}): Task[] {
  ensureTaskTables(db);
  const rows = (opts.includeIncognito
    ? db.prepare('SELECT * FROM tasks ORDER BY createdAt ASC').all()
    : db.prepare('SELECT * FROM tasks WHERE incognito = 0 ORDER BY createdAt ASC').all()) as unknown as TaskRow[];
  return rows.map(toTask);
}

export function updateTask(db: DatabaseSync, id: string, patch: Partial<Pick<Task, 'state' | 'detail' | 'startedAt' | 'endedAt' | 'runId' | 'undoGroupId' | 'locks' | 'resultSummary' | 'priority' | 'title'>> & { createdAt?: number }): Task | null {
  ensureTaskTables(db);
  const cur = getTask(db, id);
  if (!cur) return null;
  const next: Task = {
    ...cur,
    ...(patch.createdAt !== undefined ? { createdAt: patch.createdAt } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.undoGroupId !== undefined ? { undoGroupId: patch.undoGroupId } : {}),
    ...(patch.locks !== undefined ? { locks: patch.locks } : {}),
    ...(patch.resultSummary !== undefined ? { resultSummary: patch.resultSummary } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
  };
  db.prepare(`UPDATE tasks SET state = ?, detail = ?, startedAt = ?, endedAt = ?,
    runId = ?, undoGroupId = ?, locks = ?, resultSummary = ?, priority = ?, title = ?, createdAt = ? WHERE id = ?`).run(
    next.state, next.detail || null, next.startedAt ?? null, next.endedAt ?? null,
    next.runId ?? null, next.undoGroupId ?? null, JSON.stringify(next.locks || []),
    next.resultSummary ?? null, next.priority, next.title, patch.createdAt ?? cur.createdAt, id,
  );
  return getTask(db, id);
}

export function deleteTask(db: DatabaseSync, id: string): boolean {
  ensureTaskTables(db);
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(id) as unknown as { changes: number };
  try { return (r.changes as number) > 0; } catch { return true; }
}

/** Policy snapshot per task (roots + rules at creation; subtasks never exceed it). */
export interface TaskPolicySnapshot {
  allowedRoots: string[];
  alwaysAllow: unknown[];
}

export function ensureTaskCtxTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_ctx (
    taskId TEXT PRIMARY KEY, allowedRoots TEXT NOT NULL DEFAULT '[]', alwaysAllow TEXT NOT NULL DEFAULT '[]'
  );`);
}

export function saveTaskCtx(db: DatabaseSync, taskId: string, ctx: TaskPolicySnapshot): void {
  ensureTaskCtxTable(db);
  db.prepare('INSERT INTO task_ctx (taskId, allowedRoots, alwaysAllow) VALUES (?, ?, ?) ON CONFLICT(taskId) DO UPDATE SET allowedRoots=excluded.allowedRoots, alwaysAllow=excluded.alwaysAllow')
    .run(taskId, JSON.stringify(ctx.allowedRoots || []), JSON.stringify(ctx.alwaysAllow || []));
}

export function getTaskCtx(db: DatabaseSync, taskId: string): TaskPolicySnapshot | null {
  try {
    ensureTaskCtxTable(db);
    const r = db.prepare('SELECT allowedRoots, alwaysAllow FROM task_ctx WHERE taskId = ?').get(taskId) as { allowedRoots: string; alwaysAllow: string } | undefined;
    if (!r) return null;
    const allowedRoots = JSON.parse(r.allowedRoots || '[]') as unknown;
    const alwaysAllow = JSON.parse(r.alwaysAllow || '[]') as unknown;
    if (!Array.isArray(allowedRoots) || !Array.isArray(alwaysAllow)) return null;
    return { allowedRoots: allowedRoots.map(String), alwaysAllow };
  } catch {
    return null;
  }
}

export function deleteTaskCtx(db: DatabaseSync, taskId: string): void {
  try {
    ensureTaskCtxTable(db);
    db.prepare('DELETE FROM task_ctx WHERE taskId = ?').run(taskId);
  } catch { /* best-effort */ }
}

/** Prune terminal tasks older than N days (with their attachments by taskId). */
export function pruneTasks(db: DatabaseSync, olderThanMs: number, now = Date.now()): number {
  ensureTaskTables(db);
  const rows = db.prepare('SELECT id, state, endedAt, createdAt FROM tasks').all() as Array<{ id: string; state: TaskState; endedAt: number | null; createdAt: number }>;
  let n = 0;
  for (const r of rows) {
    if (!isTerminal(r.state)) continue;
    const ts = r.endedAt ?? r.createdAt;
    if (now - ts > olderThanMs) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(r.id);
      n++;
    }
  }
  return n;
}
