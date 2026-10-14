/** Task model: one prompt running through the Do agent loop.
 * Definitions (exact words everywhere): Task, Spawn (USER starts a separate
 * task now, parallel, no parent), Queue/push to queue (USER waiting list),
 * Subtask (created BY THE AGENT inside a running task, has a parent).
 * "spawn" is reserved for the user action; agent tools are subtask_*.
 */

export type TaskOrigin = 'user_spawn' | 'user_queue' | 'agent_subtask';

export type TaskPriority = 'normal' | 'high';

export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export interface TaskSnapshot {
  workingFolder: string;
  mode: 'do';
  provider: string;
  model: string;
  memorySnapshotIds: string[];
  attachmentIds: string[];
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  origin: TaskOrigin;
  parentId: string | null;
  depth: number;
  priority: TaskPriority;
  state: TaskState;
  /** Human detail for the row second line ("Waiting for <path> …", step text). */
  detail?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  runId?: string;
  undoGroupId?: string;
  locks: string[];
  resultSummary?: string;
  snapshot: TaskSnapshot;
}

/** Exhaustive transition table: every task ends in exactly one terminal state.
 * Retry requeues terminal work (a new lifecycle); resume requeues interrupted. */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'stopped', 'failed'],
  running: ['waiting_approval', 'done', 'failed', 'stopped', 'interrupted', 'queued'],
  waiting_approval: ['running', 'stopped', 'interrupted'],
  done: ['queued'],
  failed: ['queued'],
  stopped: ['queued'],
  interrupted: ['queued'],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'stopped' || state === 'interrupted';
}

/** Scheduler caps (constants, configurable via settings where noted). */
export const TASK_LIMITS = {
  /** Default max running tasks (setting 1..4). */
  defaultMaxParallel: 2,
  maxQueuedTop: 20,
  maxQueuedSubtasks: 10,
  /** Watchdog: fail a task after 60 s with no event. */
  watchdogMs: 60_000,
  /** Deadlock wait cap for a write lock. */
  lockWaitMs: 60_000,
  /** Subtask caps per parent / depth / hourly / dedupe window. */
  maxSubtasksPerParent: 5,
  maxDepth: 2,
  maxAgentTasksPerHour: 50,
  dupeWindowMs: 10 * 60_000,
  /** Fairness: at most 3 high tasks in a row before a normal one runs. */
  highStreakCap: 3,
  /** Prompt caps. */
  titleChars: 60,
  subtaskPromptChars: 4000,
  resultSummaryChars: 2000,
  /** Prune tasks/runs older than 30 days (configurable). */
  pruneDays: 30,
} as const;
