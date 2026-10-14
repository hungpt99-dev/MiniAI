import { describe, it, expect } from 'vitest';
import { openTestDb } from '../../src/main/db/db';
import type { DatabaseSync } from 'node:sqlite';
import {
  ensureTaskTables, insertTask, getTask, listTasks, updateTask, deleteTask, pruneTasks,
  saveTaskCtx, getTaskCtx, deleteTaskCtx,
} from '../../src/main/tasks/taskStore';
import type { Task } from '../../src/main/tasks/taskTypes';

const SNAP = {
  workingFolder: '/tmp', mode: 'do' as const, provider: 'openai', model: 'm',
  memorySnapshotIds: [], attachmentIds: [],
};

function task(id: string, state: Task['state'] = 'queued'): Task {
  return {
    id, title: id, prompt: id, origin: 'user_spawn', parentId: null, depth: 0,
    priority: 'normal', state, createdAt: 1000, locks: [], snapshot: SNAP,
  };
}

describe('taskStore: versioned persistence through the storage layer', () => {
  it('inserts, gets, lists, updates, deletes', () => {
    const db = openTestDb() as unknown as DatabaseSync;
    ensureTaskTables(db);
    insertTask(db, task('a'));
    expect(getTask(db, 'a')?.title).toBe('a');
    expect(listTasks(db).map((t) => t.id)).toEqual(['a']);
    updateTask(db, 'a', { state: 'running', detail: 'Step 1' });
    expect(getTask(db, 'a')?.state).toBe('running');
    expect(getTask(db, 'a')?.detail).toBe('Step 1');
    expect(deleteTask(db, 'a')).toBe(true);
    expect(getTask(db, 'a')).toBeNull();
    db.close();
  });
  it('round-trips snapshot, locks, run linkage and language-free text', () => {
    const db = openTestDb() as unknown as DatabaseSync;
    insertTask(db, {
      ...task('b', 'running'),
      origin: 'agent_subtask', parentId: 'p', depth: 1, priority: 'high',
      runId: 'r1', undoGroupId: 'r1', locks: ['/x'],
      resultSummary: 'done stuff', snapshot: { ...SNAP, memorySnapshotIds: ['m1'] },
    });
    const got = getTask(db, 'b')!;
    expect(got.origin).toBe('agent_subtask');
    expect(got.parentId).toBe('p');
    expect(got.runId).toBe('r1');
    expect(got.snapshot.memorySnapshotIds).toEqual(['m1']);
    db.close();
  });
  it('policy ctx never exceeds what was saved at creation', () => {
    const db = openTestDb() as unknown as DatabaseSync;
    expect(getTaskCtx(db, 'nope')).toBeNull();
    saveTaskCtx(db, 't1', { allowedRoots: ['/a'], alwaysAllow: [] });
    expect(getTaskCtx(db, 't1')?.allowedRoots).toEqual(['/a']);
    deleteTaskCtx(db, 't1');
    expect(getTaskCtx(db, 't1')).toBeNull();
    db.close();
  });
  it('prunes terminal tasks older than N days, keeps live ones', () => {
    const db = openTestDb() as unknown as DatabaseSync;
    const day = 86400_000;
    insertTask(db, { ...task('old'), state: 'done', endedAt: 0 });
    insertTask(db, { ...task('fresh'), state: 'done', endedAt: 40 * day });
    insertTask(db, { ...task('live'), state: 'queued', createdAt: 0 });
    expect(pruneTasks(db, 30 * day, 40 * day)).toBe(1);
    expect(getTask(db, 'old')).toBeNull();
    expect(getTask(db, 'fresh')?.state).toBe('done');
    expect(getTask(db, 'live')?.state).toBe('queued');
    db.close();
  });
});
