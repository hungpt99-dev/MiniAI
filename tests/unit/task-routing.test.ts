import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../src/main/tasks/scheduler';
import { routeAgentEvent, shouldReplayBuffered } from '../../src/shared/task-routing';
import type { Task as TaskRow } from '../../src/main/tasks/taskTypes';

function memPersist() {
  const m = new Map<string, TaskRow>();
  return {
    insert: (t: TaskRow) => { m.set(t.id, { ...t }); },
    update: (id: string, patch: Partial<TaskRow>) => {
      const cur = m.get(id);
      if (!cur) return null;
      const nx = { ...cur, ...patch };
      m.set(id, nx);
      return nx;
    },
    get: (id: string) => m.get(id) || null,
    list: () => [...m.values()],
  };
}

const SNAP = {
  workingFolder: '/tmp', mode: 'do' as const, provider: 'openai', model: 'm',
  memorySnapshotIds: [], attachmentIds: [],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('agent-event routing rule (shared/task-routing)', () => {
  it('cached runs route by foreground match, unknown runs assume background', () => {
    expect(routeAgentEvent('t-1', 't-1')).toBe('foreground');
    expect(routeAgentEvent('t-2', 't-1')).toBe('background');
    expect(routeAgentEvent(undefined, 't-1')).toBe('background');
    expect(routeAgentEvent(undefined, null)).toBe('background');
  });
  it('replay adopts an absent view or a view waiting for the same run only', () => {
    expect(shouldReplayBuffered('r1', 't-1', 't-1', null)).toBe(true);
    expect(shouldReplayBuffered('r1', 't-1', 't-1', { present: false, runId: null })).toBe(true);
    expect(shouldReplayBuffered('r1', 't-1', 't-1', { present: true, runId: null })).toBe(true);
    expect(shouldReplayBuffered('r1', 't-1', 't-1', { present: true, runId: 'r1' })).toBe(true);
    expect(shouldReplayBuffered('r1', 't-1', 't-1', { present: true, runId: 'r2' })).toBe(false);
    expect(shouldReplayBuffered('r1', 't-9', 't-1', null)).toBe(false);
    expect(shouldReplayBuffered('r1', undefined, 't-1', null)).toBe(false);
  });
});

describe('scheduler linkRun: foreground inline runs carry their agent runId', () => {
  function foreground() {
    const events: unknown[] = [];
    const sch = new Scheduler({
      now: () => 1000,
      settings: () => ({ maxParallel: 2, maxQueued: 20, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false }),
      persist: memPersist(),
      runTask: async () => ({ status: 'done', summary: 'ok' }),
      onEvent: (ev) => { events.push(ev); },
    });
    const r = sch.create({ prompt: 'hello', origin: 'user_spawn', snapshot: SNAP, hold: true });
    if ('error' in r) throw new Error(r.error);
    if (!sch.beginExternal(r.task.id)) throw new Error('beginExternal failed');
    return { sch, events, taskId: r.task.id };
  }
  it('links without a state transition and announces task_changed', () => {
    const { sch, events, taskId } = foreground();
    expect(sch.linkRun(taskId, 'agent-1')).toBe(true);
    const t = sch.get(taskId);
    expect(t?.state).toBe('running'); // still running: no transition taken
    expect(t?.runId).toBe('agent-1');
    const changed = events.filter((e) => (e as { type: string }).type === 'task_changed');
    expect(changed.length).toBeGreaterThan(0);
    expect((changed[changed.length - 1] as { task: TaskRow }).task.runId).toBe('agent-1');
  });
  it('refuses unknown or terminal tasks', () => {
    const { sch, taskId } = foreground();
    expect(sch.linkRun('nope', 'agent-1')).toBe(false);
    sch.finishExternal(taskId, 'done', 'ok');
    expect(sch.get(taskId)?.state).toBe('done');
    expect(sch.linkRun(taskId, 'agent-2')).toBe(false);
  });
  it('regression: linked runId routes foreground after a tasks refresh (the stuck-hello hop)', async () => {
    const { sch, taskId } = foreground();
    // Before the link the renderer cache cannot map the run: background.
    expect(routeAgentEvent(undefined, taskId)).toBe('background');
    expect(sch.linkRun(taskId, 'agent-xyz')).toBe(true);
    await flush();
    // A tasks/list refresh now maps runId -> foreground task id.
    const cache = new Map<string, string>();
    for (const t of sch.list()) if (t.runId) cache.set(t.runId, t.id);
    expect(cache.get('agent-xyz')).toBe(taskId);
    expect(routeAgentEvent(cache.get('agent-xyz'), taskId)).toBe('foreground');
    expect(shouldReplayBuffered('agent-xyz', cache.get('agent-xyz'), taskId, { present: true, runId: null })).toBe(true);
  });
  it('finishExternal still ends in exactly one terminal state after a link', () => {
    const { sch, taskId } = foreground();
    expect(sch.linkRun(taskId, 'agent-1')).toBe(true);
    sch.finishExternal(taskId, 'done', 'ok');
    expect(sch.get(taskId)?.state).toBe('done');
    sch.finishExternal(taskId, 'failed', 'late');
    expect(sch.get(taskId)?.state).toBe('done'); // second terminal ignored
  });
});
