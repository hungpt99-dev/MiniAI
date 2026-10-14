import { describe, it, expect } from 'vitest';
import { Scheduler, TaskParked, taskTitle, type RunControl } from '../../src/main/tasks/scheduler';
import { TASK_LIMITS, canTransition, isTerminal } from '../../src/main/tasks/taskTypes';
import type { Task } from '../../src/main/tasks/taskTypes';

function memPersist() {
  const m = new Map<string, Task>();
  return {
    insert: (t: Task) => { m.set(t.id, { ...t }); },
    update: (id: string, patch: Partial<Task>) => {
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

function setup(opts: { maxParallel?: number; maxQueued?: number; run?: (task: Task, ctl: RunControl) => Promise<{ status: 'done' | 'failed' | 'stopped' | 'interrupted'; summary: string }> } = {}) {
  let now = 1000;
  const events: unknown[] = [];
  const sch = new Scheduler({
    now: () => now,
    settings: () => ({
      maxParallel: opts.maxParallel ?? 2, maxQueued: opts.maxQueued ?? 20,
      allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false,
    }),
    persist: memPersist(),
    runTask: opts.run || (async () => ({ status: 'done', summary: 'ok' })),
    onEvent: (ev) => { events.push(ev); },
  });
  return { sch, events, advance: (ms: number) => { now += ms; }, now: () => now };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('task state machine', () => {
  it('allows the documented lifecycle and exactly one terminal state', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'waiting_approval')).toBe(true);
    expect(canTransition('waiting_approval', 'running')).toBe(true);
    expect(canTransition('running', 'queued')).toBe(true); // parked
    for (const s of ['done', 'failed', 'stopped', 'interrupted'] as const) {
      expect(isTerminal(s)).toBe(true);
      // Retry requeues terminal work (a new lifecycle).
      expect(canTransition(s, 'queued')).toBe(true);
      expect(canTransition(s, 'running')).toBe(false);
    }
    expect(canTransition('queued', 'done')).toBe(false);
    expect(canTransition('done', 'done')).toBe(false);
  });
  it('titles cap at 60 chars without secrets logic', () => {
    expect(taskTitle('x'.repeat(100)).length).toBeLessThanOrEqual(60);
    expect(taskTitle('  do stuff  ')).toBe('do stuff');
  });
});

function deferred<T = { status: 'done'; summary: string }>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('scheduler: spawn, queue, priority, fairness, caps', () => {
  it('starts up to maxParallel in parallel; overflow queues', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let calls = 0;
    const { sch } = setup({
      maxParallel: 2,
      run: () => gates[calls++].promise as Promise<{ status: 'done'; summary: string }>,
    });
    sch.create({ prompt: 'A', origin: 'user_spawn', snapshot: SNAP });
    sch.create({ prompt: 'B', origin: 'user_spawn', snapshot: SNAP });
    sch.create({ prompt: 'C', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    const states = new Map(sch.list().map((t) => [t.prompt, t.state]));
    expect(states.get('A')).toBe('running');
    expect(states.get('B')).toBe('running');
    expect(states.get('C')).toBe('queued');
    expect(sch.counts()).toMatchObject({ running: 2, queued: 1 });
    gates[0].resolve({ status: 'done', summary: 'a' });
    gates[1].resolve({ status: 'done', summary: 'b' });
    await flush();
    // C started after a slot freed; finish it too (no dangling run).
    expect(sch.get(sch.list().find((t) => t.prompt === 'C')!.id)?.state).toBe('running');
    gates[2].resolve({ status: 'done', summary: 'c' });
    await flush();
    expect(sch.list().every((t) => t.state === 'done')).toBe(true);
  });
  it('user tasks outrank agent subtasks of the same priority; FIFO within rank', async () => {
    const order: string[] = [];
    const gate = deferred();
    let first = true;
    const { sch } = setup({
      maxParallel: 1,
      run: (t) => {
        order.push(t.prompt);
        if (first) { first = false; return gate.promise; }
        return Promise.resolve({ status: 'done' as const, summary: 'x' });
      },
    });
    sch.create({ prompt: 'blocker', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    const parent = sch.create({ prompt: 'parent', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (parent as object))) throw new Error('no parent');
    sch.create({ prompt: 'sub', origin: 'agent_subtask', parentId: (parent as { task: Task }).task.id, snapshot: SNAP });
    sch.create({ prompt: 'user2', origin: 'user_queue', snapshot: SNAP });
    gate.resolve({ status: 'done', summary: 'x' });
    for (let i = 0; i < 20 && order.length < 4; i++) await flush();
    expect(order[0]).toBe('blocker');
    // user2 (top-level) runs before sub (agent subtask).
    expect(order.indexOf('user2')).toBeLessThan(order.indexOf('sub'));
  });
  it('fairness: at most 3 high in a row before a normal one runs', async () => {
    const order: string[] = [];
    const { sch } = setup({ maxParallel: 1, run: async (t) => { order.push(t.prompt); return { status: 'done', summary: 'x' }; } });
    sch.create({ prompt: 'n0', origin: 'user_spawn', snapshot: SNAP });
    for (const h of ['h1', 'h2', 'h3', 'h4']) sch.create({ prompt: h, origin: 'user_queue', priority: 'high', snapshot: SNAP });
    sch.create({ prompt: 'n1', origin: 'user_queue', snapshot: SNAP });
    for (let i = 0; i < 20 && order.length < 6; i++) await flush();
    expect(order.slice(0, 4)).toEqual(['n0', 'h1', 'h2', 'h3']);
    expect(order[4]).toBe('n1'); // fairness preempts h4
  });
  it('queue caps tell the user instead of dropping', async () => {
    const stuck = [deferred(), deferred()];
    let n = 0;
    const { sch } = setup({
      maxParallel: 2,
      maxQueued: 1,
      run: () => stuck[n++].promise as Promise<{ status: 'done'; summary: string }>,
    });
    sch.create({ prompt: 'run', origin: 'user_spawn', snapshot: SNAP });
    sch.create({ prompt: 'run2', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    expect(sch.counts().running).toBe(2);
    expect('task' in (sch.create({ prompt: 'q1', origin: 'user_queue', snapshot: SNAP }) as object)).toBe(true);
    const over = sch.create({ prompt: 'q2', origin: 'user_queue', snapshot: SNAP });
    expect('error' in (over as object)).toBe(true);
    expect((over as { error: string }).error).toMatch(/queue full/);
    stuck[0].resolve({ status: 'done', summary: 'x' });
    stuck[1].resolve({ status: 'done', summary: 'x' });
    await flush();
  });
  it('origins correct; user tasks never have a parent', async () => {
    const { sch } = setup({ run: async () => ({ status: 'done', summary: 'x' }) });
    const a = sch.create({ prompt: 'A', origin: 'user_spawn', snapshot: SNAP });
    const b = sch.create({ prompt: 'B', origin: 'user_queue', snapshot: SNAP });
    await flush();
    for (const r of [a, b]) {
      if (!('task' in (r as object))) throw new Error('create failed');
    }
    for (const t of sch.list()) {
      expect(t.parentId).toBeNull();
      expect(t.depth).toBe(0);
      expect(t.origin === 'user_spawn' || t.origin === 'user_queue').toBe(true);
    }
  });
  it('a parent waiting on subtasks releases its slot (no deadlock at max 1)', async () => {
    const { sch } = setup({
      maxParallel: 1,
      run: async (t, ctl) => {
        if (t.origin !== 'agent_subtask') {
          const sub = sch.create({ prompt: 'child', origin: 'agent_subtask', parentId: t.id, snapshot: SNAP });
          if (!('task' in (sub as object))) return { status: 'failed', summary: 'no sub' };
          sch.releaseSlotForWait(t.id);
          const done = await sch.waitForTask((sub as { task: Task }).task.id, ctl.signal);
          sch.reclaimSlot(t.id);
          return { status: 'done', summary: `child:${done.state}` };
        }
        return { status: 'done', summary: 'child ok' };
      },
    });
    sch.create({ prompt: 'parent', origin: 'user_spawn', snapshot: SNAP });
    for (let i = 0; i < 20; i++) await flush();
    const parent = sch.list().find((t) => t.prompt === 'parent');
    expect(parent?.state).toBe('done');
    expect(parent?.resultSummary).toMatch(/child:done/);
  });
  it('watchdog fails a silent task after 60 s; approvals do not time out', async () => {
    const { sch, advance } = setup({ run: async () => new Promise(() => {}) as Promise<{ status: 'done'; summary: string }> });
    const a = sch.create({ prompt: 'silent', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (a as object))) throw new Error('no task');
    const id = (a as { task: Task }).task.id;
    advance(61_000);
    sch.tick();
    expect(sch.get(id)?.state).toBe('failed');
    const b = sch.create({ prompt: 'appr', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (b as object))) throw new Error('no task');
    const bid = (b as { task: Task }).task.id;
    sch.approvalWait(bid, 'r1', 'shell_run', 'rm x');
    advance(3600_000);
    sch.tick();
    expect(sch.get(bid)?.state).toBe('waiting_approval');
  });
  it('stop halts queued work; retry requeues terminal work exactly once', async () => {
    const gate = deferred();
    let first = true;
    const { sch } = setup({
      maxParallel: 1,
      run: () => {
        if (first) { first = false; return gate.promise; }
        return Promise.resolve({ status: 'done' as const, summary: 'x' });
      },
    });
    sch.create({ prompt: 'blocker', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    const q = sch.create({ prompt: 'q', origin: 'user_queue', snapshot: SNAP });
    await flush();
    if (!('task' in (q as object))) throw new Error('no task');
    const id = (q as { task: Task }).task.id;
    expect(sch.get(id)?.state).toBe('queued');
    expect(sch.stop(id)).toBe(true);
    expect(sch.get(id)?.state).toBe('stopped');
    expect(sch.retry(id)).toBe(true);
    expect(sch.get(id)?.state).toBe('queued');
    gate.resolve({ status: 'done', summary: 'x' });
    for (let i = 0; i < 10; i++) await flush();
    // q ran after the blocker; exactly one terminal state each.
    expect(sch.get(id)?.state).toBe('done');
  });
});

describe('scheduler: locks serialize writers across origins', () => {
  it('two writers to the same file never run together; reads do not block', async () => {
    const log: string[] = [];
    const { sch } = setup({
      maxParallel: 2,
      run: (t, ctl) => {
        if (t.prompt.startsWith('read')) {
          const note = ctl.locks.noteRead('/proj/a.txt');
          log.push(`${t.prompt}:${note ? 'noted' : 'clean'}`);
          return Promise.resolve({ status: 'done' as const, summary: 'x' });
        }
        const acq = ctl.locks.acquireWrite(['/proj/a.txt']);
        if (!acq.ok) {
          log.push(`${t.prompt}:blocked`);
          throw new TaskParked(`Waiting for ${(acq as { path: string }).path}`);
        }
        log.push(`${t.prompt}:start`);
        return new Promise<{ status: 'done'; summary: string }>((resolve) => setTimeout(() => {
          log.push(`${t.prompt}:end`);
          ctl.locks.releaseAll();
          resolve({ status: 'done', summary: 'x' });
        }, 5));
      },
    });
    sch.create({ prompt: 'write A', origin: 'user_spawn', snapshot: SNAP });
    sch.create({ prompt: 'write B', origin: 'user_spawn', snapshot: SNAP });
    for (let i = 0; i < 60; i++) await flush();
    // Serialized: no interleaving of the two critical sections.
    const aStart = log.indexOf('write A:start');
    const aEnd = log.indexOf('write A:end');
    const bStart = log.indexOf('write B:start');
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeGreaterThan(aStart);
    expect(bStart < aStart || bStart > aEnd).toBe(true);
    expect(sch.list().every((t) => t.state === 'done')).toBe(true);
  });
  it('folder locks cover children; release on done lets the waiter start', async () => {
    const { sch } = setup({
      maxParallel: 2,
      run: (t, ctl) => {
        const target = t.prompt === 'folder' ? '/proj/docs' : '/proj/docs/a.txt';
        const acq = ctl.locks.acquireWrite([target]);
        if (!acq.ok) throw new TaskParked(`Waiting for ${(acq as { path: string }).path}`);
        return new Promise<{ status: 'done'; summary: string }>((resolve) => setTimeout(() => {
          ctl.locks.releaseAll();
          resolve({ status: 'done', summary: 'x' });
        }, 5));
      },
    });
    sch.create({ prompt: 'folder', origin: 'user_spawn', snapshot: SNAP });
    sch.create({ prompt: 'child', origin: 'user_queue', snapshot: SNAP });
    for (let i = 0; i < 60; i++) await flush();
    expect(sch.list().map((t) => t.state).every((s) => s === 'done')).toBe(true);
  });
  it('deadlock wait cap fails the later task with a clear message', async () => {
    const { sch, advance } = setup({
      maxParallel: 2,
      run: (t, ctl) => {
        // A holds forever; B parks on the same path.
        if (t.prompt === 'A') {
          const acq = ctl.locks.acquireWrite(['/proj/x.txt']);
          if (!acq.ok) throw new TaskParked('unexpected');
          return new Promise<{ status: 'done'; summary: string }>(() => {});
        }
        const acq = ctl.locks.acquireWrite(['/proj/x.txt']);
        if (!acq.ok) throw new TaskParked(`Waiting for ${(acq as { path: string }).path} (used by holder)`);
        return Promise.resolve({ status: 'done' as const, summary: 'x' });
      },
    });
    const a = sch.create({ prompt: 'A', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (a as object))) throw new Error('no task');
    const b = sch.create({ prompt: 'B', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (b as object))) throw new Error('no task');
    const bid = (b as { task: Task }).task.id;
    // B parked; push its park clock past the cap.
    advance(TASK_LIMITS.lockWaitMs + 1000);
    sch.tick();
    expect(sch.get(bid)?.state).toBe('failed');
    expect(sch.get(bid)?.resultSummary).toMatch(/Deadlock cap/);
  });
});

describe('scheduler: subtask caps, dedupe, circuit breaker', () => {
  it('5 live subtasks per parent, depth 2, identical prompts rejected for 10 minutes', async () => {
    const gate = deferred();
    const { sch } = setup({ run: () => gate.promise });
    const p = sch.create({ prompt: 'parent', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (p as object))) throw new Error('no parent');
    const pid = (p as { task: Task }).task.id;
    for (let i = 0; i < 5; i++) {
      const r = sch.create({ prompt: `child ${i}`, origin: 'agent_subtask', parentId: pid, snapshot: SNAP });
      expect('task' in (r as object)).toBe(true);
    }
    await flush();
    expect((sch.create({ prompt: 'child 5', origin: 'agent_subtask', parentId: pid, snapshot: SNAP }) as { error: string }).error).toMatch(/at most 5/);
    expect((sch.create({ prompt: 'child 0', origin: 'agent_subtask', parentId: pid, snapshot: SNAP }) as { error: string }).error).toBeTruthy();
    gate.resolve({ status: 'done', summary: 'x' });
    await flush();
  });
  it('depth 2 allowed, depth 3 refused', async () => {
    const { sch } = setup({});
    const p = sch.create({ prompt: 'daddy', origin: 'user_spawn', snapshot: SNAP });
    await flush();
    if (!('task' in (p as object))) throw new Error('no parent');
    const c = sch.create({ prompt: 'dchild', origin: 'agent_subtask', parentId: (p as { task: Task }).task.id, snapshot: SNAP });
    await flush();
    if (!('task' in (c as object))) throw new Error('no child');
    const g = sch.create({ prompt: 'dgrand', origin: 'agent_subtask', parentId: (c as { task: Task }).task.id, snapshot: SNAP });
    expect('task' in (g as object)).toBe(true);
    await flush();
    expect((sch.create({ prompt: 'dtoo deep', origin: 'agent_subtask', parentId: (g as { task: Task }).task.id, snapshot: SNAP }) as { error: string }).error).toMatch(/depth/);
  });
  it('50 agent tasks per hour; burst pauses the queue', async () => {
    const events: unknown[] = [];
    const sch = new Scheduler({
      settings: () => ({ maxParallel: 4, maxQueued: 100, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false }),
      persist: memPersist(),
      runTask: async () => ({ status: 'done', summary: 'x' }),
      onEvent: (ev) => { events.push(ev); },
    });
    const pids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const p = sch.create({ prompt: `parent ${i}`, origin: 'user_spawn', snapshot: SNAP });
      if ('task' in (p as object)) pids.push((p as { task: Task }).task.id);
    }
    await flush();
    for (let i = 0; i < 11; i++) {
      sch.create({ prompt: `burst ${i}`, origin: 'agent_subtask', parentId: pids[i], snapshot: SNAP });
    }
    expect(events.some((e) => (e as { type?: string }).type === 'queue_paused')).toBe(true);
    sch.resumeQueue();
    // Hourly cap: the 51st agent task within the hour is refused.
    // (resumeQueue simulates the user reviewing each burst pause; creates
    // are never blocked by a pause, only starts are.)
    let last: unknown = null;
    for (let i = 11; i < 75; i++) {
      sch.resumeQueue();
      const p = sch.create({ prompt: `hp ${i}`, origin: 'user_spawn', snapshot: SNAP });
      if (!('task' in (p as object))) break;
      last = sch.create({ prompt: `hs ${i}`, origin: 'agent_subtask', parentId: (p as { task: Task }).task.id, snapshot: SNAP });
      if (last && 'error' in (last as object)) break;
      await flush(); // drain so the subtask-queue cap (10) never masks the hourly cap
    }
    expect(last && 'error' in (last as object) && /hourly/.test((last as { error: string }).error)).toBe(true);
  });
});

describe('scheduler: persistence, restart, pruning', () => {
  it('running becomes interrupted, queued stays queued, resume requeues', async () => {
    const store = memPersist();
    const gate = deferred();
    let first = true;
    const mk = (persist: typeof store) => new Scheduler({
      settings: () => ({ maxParallel: 1, maxQueued: 20, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false }),
      persist,
      runTask: () => {
        if (first) { first = false; return gate.promise; }
        return Promise.resolve({ status: 'done' as const, summary: 'x' });
      },
      onEvent: () => {},
    });
    const s1 = mk(store);
    const r = s1.create({ prompt: 'run', origin: 'user_spawn', snapshot: SNAP });
    s1.create({ prompt: 'q', origin: 'user_queue', snapshot: SNAP });
    await flush();
    if (!('task' in (r as object))) throw new Error('no task');
    expect(s1.get((r as { task: Task }).task.id)?.state).toBe('running');
    const s2 = mk(store);
    const waiting = s2.hydrate(store.list());
    expect(waiting).toBe(2);
    const states = new Map(s2.list().map((t) => [t.prompt, t.state]));
    expect(states.get('run')).toBe('interrupted');
    expect(states.get('q')).toBe('queued');
    expect(s2.retry(s2.list().find((t) => t.prompt === 'run')!.id)).toBe(true);
    gate.resolve({ status: 'done', summary: 'x' });
    await flush();
  });
});
