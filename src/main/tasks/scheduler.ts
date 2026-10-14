import type { Task, TaskOrigin, TaskPriority, TaskState } from './taskTypes';
import { TASK_LIMITS, canTransition, isTerminal } from './taskTypes';

export interface TaskRunResult {
  status: 'done' | 'failed' | 'stopped' | 'interrupted';
  summary: string;
}

export interface RunControl {
  task: Task;
  signal: AbortSignal;
  heartbeat: () => void;
  /** Runner reports its loop runId so approvals/stop route to this task. */
  onRunId?: (runId: string) => void;
  /** Write-lock hook wired into the agent loop for this task. */
  locks: {
    acquireWrite: (paths: string[]) => { ok: true } | { ok: false; path: string; byTask: string };
    noteRead: (path: string) => string | null;
    releaseAll: () => void;
  };
  setDetail: (detail: string) => void;
}

export interface SchedulerSettings {
  maxParallel: number;
  maxQueued: number;
  allowSubtasks: boolean;
  askBeforeSubtasks: boolean;
  notifyOn: boolean;
}

export interface SchedulerDeps {
  now?: () => number;
  normalizeForCompare?: (p: string) => string;
  settings?: () => SchedulerSettings;
  persist?: {
    insert: (t: Task) => void;
    update: (id: string, patch: Partial<Task>) => Task | null;
    get: (id: string) => Task | null;
    list: () => Task[];
  };
  /** Execute one task through the Do agent loop. Never throws Parked past the scheduler. */
  runTask?: (task: Task, ctl: RunControl) => Promise<TaskRunResult>;
  /** Sink for scheduler events (IPC pushes, notifications, tests). Never throws. */
  onEvent?: (ev: SchedulerEvent) => void;
}

export type SchedulerEvent =
  | { type: 'task_changed'; task: Task }
  | { type: 'queue_paused'; reason: string; until?: number }
  | { type: 'queue_resumed' }
  | { type: 'approval_needed'; taskId: string; runId: string; tool: string; summary: string }
  | { type: 'notify'; title: string; body: string; taskId?: string }
  | { type: 'resume_prompt'; waiting: number };

export class TaskParked extends Error {
  constructor(public reason: string) { super(`task-parked: ${reason}`); }
}

interface Runtime {
  abort: AbortController;
  lastEventAt: number;
  slotHeld: boolean;
  waitingOnSubtasks: boolean;
}

interface ParkedWait {
  /** First park of the current queued episode (deadlock cap). */
  since: number;
  /** Earliest retry (breaks park→pump→park spins). Cleared to wake. */
  notBefore?: number;
  waitingOn?: { path: string; byTask: string };
}

const SEP = process.platform === 'win32' ? '\\' : '/';

export function defaultNormalize(p: string): string {
  let s = String(p || '');
  try { s = s.normalize('NFC'); } catch { /* keep */ }
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

let taskSeq = 0;

export function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${(++taskSeq).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function taskTitle(prompt: string, cap = TASK_LIMITS.titleChars): string {
  const oneLine = String(prompt || '').replace(/\s+/g, ' ').trim() || 'Untitled task';
  return oneLine.length > cap ? oneLine.slice(0, cap - 1) + '…' : oneLine;
}

export class Scheduler {
  private tasks = new Map<string, Task>();
  private order: string[] = [];
  private runtimes = new Map<string, Runtime>();
  private locks = new Map<string, string>(); // normalized path -> taskId
  private lockOwners = new Map<string, Set<string>>(); // taskId -> normalized paths
  private highStreak = 0;
  private pausedUntil = 0;
  private pauseReason = '';
  private circuitPaused = false;
  private subtaskCreatedAt: number[] = [];
  private promptSeen = new Map<string, number>(); // normalized prompt -> timestamp
  private running = new Set<string>(); // taskIds currently executing (pump guard)
  private terminalWaiters = new Map<string, Array<(t: Task) => void>>();
  private externalWaiting = new Set<string>(); // foreground runs parked on subtasks
  private parked = new Map<string, ParkedWait>(); // queued lock waiters
  private now: () => number;
  private normalize: (p: string) => string;
  private readSettings: () => SchedulerSettings;
  private persist: SchedulerDeps['persist'];
  private runTaskFn: SchedulerDeps['runTask'];
  private emit: (ev: SchedulerEvent) => void;

  constructor(deps: SchedulerDeps = {}) {
    this.now = deps.now || Date.now;
    this.normalize = deps.normalizeForCompare || defaultNormalize;
    this.readSettings = deps.settings || (() => ({ maxParallel: 2, maxQueued: 20, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: true }));
    this.persist = deps.persist;
    this.runTaskFn = deps.runTask;
    const onEvent = deps.onEvent;
    this.emit = (ev) => { try { onEvent?.(ev); } catch { /* never breaks scheduling */ } };
  }

  /** Load persisted tasks (queued stay queued; running -> interrupted). Returns waiting count. */
  hydrate(persisted: Task[]): number {
    let waiting = 0;
    for (const t of persisted) {
      if (isTerminal(t.state)) { this.put(t); continue; }
      if (t.state === 'queued') { this.put(t); waiting++; continue; }
      const marked: Task = { ...t, state: 'interrupted', endedAt: this.now(), detail: 'Interrupted', locks: [] };
      this.put(marked);
      this.persist?.update(marked.id, { state: 'interrupted', endedAt: marked.endedAt, detail: 'Interrupted', locks: [] });
      waiting++;
    }
    if (waiting > 0) this.emit({ type: 'resume_prompt', waiting });
    return waiting;
  }

  private put(t: Task): void {
    this.tasks.set(t.id, t);
    if (!this.order.includes(t.id)) this.order.push(t.id);
  }

  get(id: string): Task | null {
    return this.tasks.get(id) || this.persist?.get(id) || null;
  }

  list(): Task[] {
    const live = [...this.tasks.values()];
    if (!live.length && this.persist) return this.persist.list();
    return live.sort((a, b) => a.createdAt - b.createdAt);
  }

  counts(): { running: number; queued: number; approval: number } {
    let running = 0, queued = 0, approval = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'running') running++;
      else if (t.state === 'waiting_approval') { running++; approval++; }
      else if (t.state === 'queued') queued++;
    }
    return { running, queued, approval };
  }

  private setState(t: Task, to: TaskState, extra: Partial<Task> = {}): Task {
    if (!canTransition(t.state, to)) throw new Error(`task-transition: ${t.state} -> ${to} not allowed`);
    const next: Task = { ...t, ...extra, state: to };
    this.tasks.set(t.id, next);
    this.persist?.update(t.id, { state: to, ...extra } as Partial<Task>);
    this.emit({ type: 'task_changed', task: next });
    if (isTerminal(to)) {
      const waiters = this.terminalWaiters.get(t.id);
      if (waiters) {
        this.terminalWaiters.delete(t.id);
        for (const w of waiters) {
          try { w(next); } catch { /* never breaks scheduling */ }
        }
      }
    }
    return next;
  }

  /** Resolve when the task reaches exactly one terminal state (wait=true parents). */
  waitForTask(id: string, signal?: AbortSignal): Promise<Task> {
    const cur = this.tasks.get(id);
    if (cur && isTerminal(cur.state)) return Promise.resolve(cur);
    return new Promise<Task>((resolve, reject) => {
      const list = this.terminalWaiters.get(id) || [];
      const done = (t: Task) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(t);
      };
      const onAbort = () => {
        const l = this.terminalWaiters.get(id);
        if (l) {
          const i = l.indexOf(done);
          if (i >= 0) l.splice(i, 1);
        }
        reject(new Error('aborted'));
      };
      list.push(done);
      this.terminalWaiters.set(id, list);
      // Recheck: may have finished between the first check and subscribe.
      const re = this.tasks.get(id);
      if (re && isTerminal(re.state)) {
        const l = this.terminalWaiters.get(id) || [];
        const i = l.indexOf(done);
        if (i >= 0) l.splice(i, 1);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(re);
      } else if (signal?.aborted) {
        onAbort();
      } else if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Create a task (spawn, queue push, or subtask). Enforces caps. */
  create(input: {
    prompt: string; origin: TaskOrigin; parentId?: string | null;
    priority?: TaskPriority; snapshot: Task['snapshot'];
    title?: string; id?: string;
    /** Hold for an external (foreground inline) run: pump skips it. */
    hold?: boolean;
  }): { task: Task } | { error: string } {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) return { error: 'empty prompt' };
    const depth = input.parentId ? ((this.tasks.get(input.parentId)?.depth ?? 0) + 1) : 0;
    if (input.parentId && depth > TASK_LIMITS.maxDepth) return { error: `subtask depth over ${TASK_LIMITS.maxDepth}` };
    const s = this.readSettings();
    const queuedTop = this.list().filter((t) => t.state === 'queued' && !t.parentId).length;
    const queuedSub = this.list().filter((t) => t.state === 'queued' && t.parentId).length;
    if (!input.parentId && queuedTop >= Math.min(s.maxQueued, TASK_LIMITS.maxQueuedTop)) {
      return { error: `queue full (${TASK_LIMITS.maxQueuedTop} waiting tasks)` };
    }
    if (input.parentId && queuedSub >= TASK_LIMITS.maxQueuedSubtasks) {
      return { error: `subtask queue full (${TASK_LIMITS.maxQueuedSubtasks} waiting)` };
    }
    if (input.parentId) {
      const sibs = this.list().filter((t) => t.parentId === input.parentId && !isTerminal(t.state)).length;
      if (sibs >= TASK_LIMITS.maxSubtasksPerParent) return { error: `at most ${TASK_LIMITS.maxSubtasksPerParent} subtasks per parent` };
      const norm = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
      const seen = this.promptSeen.get(norm);
      if (seen && this.now() - seen < TASK_LIMITS.dupeWindowMs) return { error: 'identical task already created recently' };
      this.promptSeen.set(norm, this.now());
      const hourAgo = this.now() - 3600_000;
      this.subtaskCreatedAt = this.subtaskCreatedAt.filter((ts) => ts > hourAgo);
      if (this.subtaskCreatedAt.length >= TASK_LIMITS.maxAgentTasksPerHour) return { error: 'hourly agent-task cap reached' };
      this.subtaskCreatedAt.push(this.now());
      // Circuit breaker: burst of agent tasks pauses the whole queue.
      const recent = this.subtaskCreatedAt.filter((ts) => ts > this.now() - 60_000).length;
      if (recent > 10 && !this.circuitPaused) {
        this.circuitPaused = true;
        this.emit({ type: 'queue_paused', reason: 'subtask burst — review in Tasks' });
      }
    }
    const task: Task = {
      id: input.id || newTaskId(),
      title: (input.title || taskTitle(prompt)).slice(0, TASK_LIMITS.titleChars),
      prompt, origin: input.origin, parentId: input.parentId || null, depth,
      priority: input.priority || 'normal', state: 'queued',
      createdAt: this.now(), locks: [], snapshot: input.snapshot,
    };
    this.put(task);
    try { this.persist?.insert(task); } catch { /* incognito or test without persist */ }
    if (input.hold) this.running.add(task.id);
    this.emit({ type: 'task_changed', task });
    void this.pump();
    return { task };
  }

  /** Slots currently held (running holders minus parents waiting on subtasks). */
  private slotsUsed(): number {
    let n = 0;
    for (const [id, rt] of this.runtimes) {
      const t = this.tasks.get(id);
      if (t && (t.state === 'running' || t.state === 'waiting_approval') && rt.slotHeld) n++;
    }
    return n + this.externalHeld();
  }

  private pickNext(): Task | null {
    const now = this.now();
    const q = this.list().filter((t) => {
      if (t.state !== 'queued' || this.running.has(t.id)) return false;
      const p = this.parked.get(t.id);
      if (p && (p.notBefore ?? 0) > now) return false; // cooling down after a park
      return true;
    });
    if (!q.length) return null;
    const highs = q.filter((t) => t.priority === 'high');
    const normals = q.filter((t) => t.priority !== 'high');
    const rank = (t: Task) => (t.parentId ? 1 : 0) * 1e15 + t.createdAt;
    highs.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
    normals.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
    // Fairness: at most 3 high in a row before a normal one runs.
    if (highs.length && (this.highStreak < TASK_LIMITS.highStreakCap || !normals.length)) return highs[0];
    if (normals.length) return normals[0];
    return highs[0] || null;
  }

  /** Try to start queued tasks while slots and locks allow. */
  pump(): void {
    if (this.paused() || this.circuitPaused) return;
    const s = this.readSettings();
    const max = Math.min(Math.max(1, s.maxParallel || 2), 4);
    for (;;) {
      if (this.slotsUsed() >= max) return;
      const next = this.pickNext();
      if (!next) return;
      if (next.priority === 'high') this.highStreak++;
      else this.highStreak = 0;
      void this.start(next);
    }
  }

  private paused(): boolean {
    return this.now() < this.pausedUntil;
  }

  pauseQueue(reason: string, ms: number): void {
    this.pausedUntil = this.now() + ms;
    this.pauseReason = reason;
    this.emit({ type: 'queue_paused', reason, until: this.pausedUntil });
  }

  resumeQueue(): void {
    this.pausedUntil = 0;
    this.circuitPaused = false;
    this.emit({ type: 'queue_resumed' });
    void this.pump();
  }

  private async start(task: Task): Promise<void> {
    if (!this.runTaskFn) return; // headless/test without a runner: stays queued
    if (this.running.has(task.id)) return;
    this.running.add(task.id);
    const abort = new AbortController();
    const rt: Runtime = { abort, lastEventAt: this.now(), slotHeld: true, waitingOnSubtasks: false };
    this.runtimes.set(task.id, rt);
    let cur = this.setState(task, 'running', { startedAt: this.now(), detail: undefined });
    // Fresh attempt: a previous queued episode's park markers no longer apply.
    this.parked.delete(cur.id);
    const ctlLocks = {
      acquireWrite: (paths: string[]) => this.acquireWrite(cur.id, paths),
      noteRead: (path: string) => this.noteRead(cur.id, path),
      releaseAll: () => this.releaseTaskLocks(cur.id),
    };
    const ctl: RunControl = {
      task: cur,
      signal: abort.signal,
      heartbeat: () => { const r = this.runtimes.get(cur.id); if (r) r.lastEventAt = this.now(); },
      onRunId: (runId) => {
        const t = this.tasks.get(cur.id);
        if (t && !isTerminal(t.state)) {
          const nx = { ...t, runId, undoGroupId: runId };
          this.tasks.set(cur.id, nx);
          this.persist?.update(cur.id, { runId, undoGroupId: runId });
          this.emit({ type: 'task_changed', task: nx });
        }
      },
      locks: ctlLocks,
      setDetail: (detail) => {
        const t = this.tasks.get(cur.id);
        if (t && !isTerminal(t.state)) {
          const nx = { ...t, detail };
          this.tasks.set(t.id, nx);
          this.persist?.update(t.id, { detail });
          this.emit({ type: 'task_changed', task: nx });
        }
      },
    };
    try {
      const res = await this.runTaskFn(cur, ctl);
      cur = this.tasks.get(cur.id) || cur;
      this.finishTask(cur, res.status, res.summary);
    } catch (e) {
      cur = this.tasks.get(cur.id) || cur;
      if (e instanceof TaskParked) {
        // Parked: back to queued with the reason; slot + locks released.
        // Cooldown (notBefore) breaks park→pump→park spins; lock releases
        // wake waiters (see releaseTaskLocks). `since` is kept for the
        // current queued episode so the deadlock cap can fire.
        this.releaseTaskLocks(cur.id);
        const prev = this.parked.get(cur.id);
        const m = /Waiting for (.+) \(used by (.+)\)/.exec(e.reason);
        this.parked.set(cur.id, {
          since: prev?.since ?? this.now(),
          notBefore: this.now() + 1000,
          ...(m ? { waitingOn: { path: m[1], byTask: m[2] } } : {}),
        });
        try {
          const nx = this.setState(cur, 'queued', { detail: e.reason });
          cur = nx;
        } catch { /* already terminal via stop */ }
      } else if ((e as { code?: string })?.code === 'rate-limit' || /429|rate.?limit|retry-after/i.test((e as Error)?.message || '')) {
        this.releaseTaskLocks(cur.id);
        const ms = parseRetryAfter((e as Error)?.message || '') || 30_000;
        this.pauseQueue('provider rate limit', ms);
        try { cur = this.setState(cur, 'queued', { detail: 'Provider rate-limited — retrying' }); } catch { /* terminal */ }
      } else if (abort.signal.aborted) {
        this.finishTask(cur, 'stopped', 'Stopped');
      } else {
        this.finishTask(cur, 'failed', String((e as Error)?.message || e).slice(0, 500));
      }
    } finally {
      this.running.delete(task.id);
      this.runtimes.delete(task.id);
      this.releaseTaskLocks(task.id);
      void this.pump();
    }
  }

  private finishTask(task: Task, status: 'done' | 'failed' | 'stopped' | 'interrupted', summary: string): void {
    const cur = this.tasks.get(task.id) || task;
    if (isTerminal(cur.state)) return; // exactly one terminal state
    try {
      this.setState(cur, status, {
        endedAt: this.now(),
        ...(summary ? { resultSummary: summary.slice(0, TASK_LIMITS.resultSummaryChars) } : {}),
        detail: undefined, locks: [],
      });
    } catch { /* transition raced with stop; terminal already recorded */ }
    const topId = this.topAncestor(cur);
    if (!cur.parentId && this.readSettings().notifyOn) {
      this.emit({ type: 'notify', title: `Task ${status}`, body: cur.title, taskId: cur.id });
    }
    void topId;
  }

  private topAncestor(t: Task): string {
    let cur = t;
    for (;;) {
      if (!cur.parentId) return cur.id;
      const p = this.tasks.get(cur.parentId);
      if (!p) return cur.id;
      cur = p;
    }
  }

  /** Stop a task (and its subtasks). Queued -> stopped; running -> abort. */
  stop(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || isTerminal(t.state)) return false;
    for (const sub of this.list().filter((x) => x.parentId === id && !isTerminal(x.state))) {
      this.stop(sub.id);
    }
    this.parked.delete(id);
    const rt = this.runtimes.get(id);
    if (rt) {
      this.releaseTaskLocks(id);
      try { this.setState(t, 'stopped', { endedAt: this.now(), detail: undefined, locks: [] }); } catch { /* raced */ }
      try { rt.abort.abort(); } catch { /* noop */ }
      this.running.delete(id);
      this.runtimes.delete(id);
    } else if (t.state === 'queued' || t.state === 'waiting_approval') {
      try { this.setState(t, 'stopped', { endedAt: this.now(), detail: undefined }); } catch { /* raced */ }
    }
    void this.pump();
    return true;
  }

  /** Retry a terminal task (or family): back to queued. */
  retry(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || !isTerminal(t.state)) return false;
    this.running.delete(id);
    this.runtimes.delete(id);
    this.parked.delete(id);
    this.setState(t, 'queued', { startedAt: undefined, endedAt: undefined, resultSummary: undefined, detail: undefined, locks: [] });
    void this.pump();
    return true;
  }

  /** Foreground inline runs execute outside pump: hold a slot, skip auto-start. */
  beginExternal(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.state !== 'queued') return false;
    this.running.add(id);
    try {
      this.setState(t, 'running', { startedAt: this.now(), detail: undefined });
    } catch {
      this.running.delete(id);
      return false;
    }
    return true;
  }
  /** Finish a foreground inline run (exactly one terminal state). */
  finishExternal(id: string, status: 'done' | 'failed' | 'stopped' | 'interrupted', summary: string): void {
    try {
      this.finishTask(this.tasks.get(id) || ({ id } as Task), status, summary);
    } finally {
      this.running.delete(id);
      this.runtimes.delete(id);
      this.externalWaiting.delete(id);
      this.releaseTaskLocks(id);
      void this.pump();
    }
  }

  /** Externally held slots count against concurrency (foreground inline runs). */
  externalHeld(): number {
    let n = 0;
    for (const id of this.running) {
      if (this.externalWaiting.has(id)) continue;
      if (!this.runtimes.has(id) && this.tasks.get(id)?.state === 'running') n++;
    }
    return n;
  }

  /** Move a queued task up/down (Alt+Up/Down, drag). Announces via task_changed. */
  move(id: string, dir: -1 | 1): boolean {
    const t = this.tasks.get(id);
    if (!t || t.state !== 'queued') return false;
    const idx = this.order.indexOf(id);
    const swapWith = (i: number): boolean => {
      const other = this.tasks.get(this.order[i]);
      if (!other || other.state !== 'queued') return false;
      // FIFO/priority order is by createdAt; reorder swaps the timestamps.
      const a = this.tasks.get(id)!;
      const b = other;
      const na = { ...a, createdAt: b.createdAt };
      const nb = { ...b, createdAt: a.createdAt };
      this.tasks.set(id, na);
      this.tasks.set(b.id, nb);
      this.persist?.update(id, { createdAt: na.createdAt } as Partial<Task>);
      this.persist?.update(b.id, { createdAt: nb.createdAt } as Partial<Task>);
      this.emit({ type: 'task_changed', task: na });
      this.emit({ type: 'task_changed', task: nb });
      return true;
    };
    if (dir < 0 && idx > 0) return swapWith(idx - 1);
    if (dir > 0 && idx < this.order.length - 1) return swapWith(idx + 1);
    return false;
  }

  /** Parent waits on subtasks: release the slot so children can run (no deadlock). */
  releaseSlotForWait(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.slotHeld = false;
      rt.waitingOnSubtasks = true;
    } else if (this.running.has(id)) {
      this.externalWaiting.add(id);
    }
    const t = this.tasks.get(id);
    if (t && t.state === 'running') {
      const nx = { ...t, detail: 'Waiting for subtasks' };
      this.tasks.set(id, nx);
      this.persist?.update(id, { detail: nx.detail });
      this.emit({ type: 'task_changed', task: nx });
    }
    void this.pump();
  }

  reclaimSlot(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt) { rt.slotHeld = true; rt.waitingOnSubtasks = false; }
    this.externalWaiting.delete(id);
  }

  approvalWait(id: string, runId: string, tool: string, summary: string): void {
    const t = this.tasks.get(id);
    if (t && t.state === 'running') {
      try { this.setState(t, 'waiting_approval', {}); } catch { /* raced */ }
    }
    this.emit({ type: 'approval_needed', taskId: id, runId, tool, summary });
  }

  approvalResolved(id: string): void {
    const t = this.tasks.get(id);
    if (t && t.state === 'waiting_approval') {
      try { this.setState(t, 'running', {}); } catch { /* raced */ }
    }
    const rt = this.runtimes.get(id);
    if (rt) rt.lastEventAt = this.now();
    void this.pump();
  }

  eventBeat(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt) rt.lastEventAt = this.now();
  }

  /** Watchdog tick: 60 s with no event fails the task; parked lock waits cap at 60 s. */
  tick(): void {
    const now = this.now();
    // Deadlock cap first: a parked task is waiting by design, not stuck —
    // report the lock, not a generic watchdog failure.
    for (const [id, p] of [...this.parked]) {
      const t = this.tasks.get(id);
      if (t && t.state === 'queued' && now - p.since > TASK_LIMITS.lockWaitMs) {
        this.finishTask({ ...t, state: 'queued' } as Task, 'failed', `Deadlock cap: still waiting for ${p.waitingOn?.path || 'a locked path'}`);
        this.parked.delete(id);
        this.runtimes.delete(id);
      } else if (!t || t.state !== 'queued') {
        this.parked.delete(id);
      }
    }
    for (const [id, rt] of [...this.runtimes]) {
      const t = this.tasks.get(id);
      if (!t || isTerminal(t.state)) continue;
      if (t.state === 'waiting_approval') continue; // paused, no timeout
      if (t.state === 'queued') continue; // parked waiters are covered by the deadlock cap
      if (rt.waitingOnSubtasks) continue; // waiting for children, not stuck
      if (now - rt.lastEventAt > TASK_LIMITS.watchdogMs) {
        try { rt.abort.abort(); } catch { /* noop */ }
        this.finishTask(t, 'failed', 'Watchdog: no progress for 60 s');
      }
    }
    // Backstop: cooldowns may have expired with no other event since.
    void this.pump();
  }

  // ---- resource locks (file safety, all origins) ----

  private norm(p: string): string {
    return this.normalize(p);
  }

  /** Absolute-path test (posix + win32 drive). */
  private isAbs(p: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
  }

  /** Folder lock covers children; equality or prefix-with-separator. */
  private covers(a: string, b: string): boolean {
    if (a === b) return true;
    return b.startsWith(a.endsWith(SEP) ? a : a + SEP);
  }

  acquireWrite(taskId: string, paths: string[]): { ok: true } | { ok: false; path: string; byTask: string } {
    const abs = paths.map((p) => String(p || '').trim()).filter((p) => p && this.isAbs(p));
    for (const p of abs) {
      const n = this.norm(p);
      for (const [held, owner] of this.locks) {
        if (owner === taskId) continue;
        if (this.covers(held, n) || this.covers(n, held)) {
          const by = this.tasks.get(owner);
          return { ok: false, path: p, byTask: by?.title || owner };
        }
      }
    }
    let set = this.lockOwners.get(taskId);
    if (!set) { set = new Set(); this.lockOwners.set(taskId, set); }
    for (const p of abs) {
      const n = this.norm(p);
      if (!this.locks.has(n)) {
        this.locks.set(n, taskId);
        set.add(n);
      }
    }
    const t = this.tasks.get(taskId);
    if (t) {
      const nx = { ...t, locks: [...(this.lockOwners.get(taskId) || [])] };
      void nx;
    }
    return { ok: true };
  }

  noteRead(taskId: string, path: string): string | null {
    const n = this.norm(String(path || ''));
    for (const [held, owner] of this.locks) {
      if (owner === taskId) continue;
      if (this.covers(held, n) || this.covers(n, held)) {
        const by = this.tasks.get(owner);
        return `Note: ${path} is write-locked by "${by?.title || owner}" — contents may change.`;
      }
    }
    return null;
  }

  releaseTaskLocks(taskId: string): void {
    const set = this.lockOwners.get(taskId);
    if (set) {
      for (const n of set) if (this.locks.get(n) === taskId) this.locks.delete(n);
      this.lockOwners.delete(taskId);
    }
    const t = this.tasks.get(taskId);
    if (t && t.locks.length) {
      const nx = { ...t, locks: [] as string[] };
      this.tasks.set(taskId, nx);
      this.persist?.update(taskId, { locks: [] });
    }
    // Wake parked waiters (other tasks): a release may free their paths.
    // The caller's own cooldown is left alone; pump skips cooling tasks,
    // so this never spins.
    let woke = false;
    for (const [id, p] of this.parked) {
      if (id === taskId) continue;
      if (p.notBefore) { delete p.notBefore; woke = true; }
    }
    if (woke) void this.pump();
  }

  /** Subtask bookkeeping for caps (used by subtask_* tools). */
  subtaskCount(parentId: string): number {
    return this.list().filter((t) => t.parentId === parentId && !isTerminal(t.state)).length;
  }

  unfinishedSubtasks(parentId: string): Task[] {
    return this.list().filter((t) => t.parentId === parentId && !isTerminal(t.state));
  }

  finishedSubtask(parentId: string, id: string): Task | null {
    const t = this.tasks.get(id);
    if (!t || t.parentId !== parentId || !isTerminal(t.state)) return null;
    return t;
  }

  /** Mark all running as interrupted (app quit / sleep). Queued stay queued. */
  interruptAll(reason: string): Task[] {
    const out: Task[] = [];
    for (const t of this.list()) {
      if (t.state === 'running' || t.state === 'waiting_approval') {
        const rt = this.runtimes.get(t.id);
        try { rt?.abort.abort(); } catch { /* noop */ }
        this.releaseTaskLocks(t.id);
        try {
          out.push(this.setState(t, 'interrupted', { endedAt: this.now(), detail: reason, locks: [] }));
        } catch { /* already terminal */ }
      }
    }
    this.runtimes.clear();
    this.running.clear();
    return out;
  }
}

function parseRetryAfter(msg: string): number | null {
  const m = /retry(?:-after)?[^\d]*(\d+)\s*s/i.exec(msg);
  if (m) return Math.min(Number(m[1]) * 1000, 300_000);
  return null;
}
