// Agent-event routing: foreground run view vs background buffer (renderer-safe, pure).
// The main process emits every agent event keyed by runId. The renderer maps
// runIds to tasks through the tasks list; a foreground task created for an
// inline run must carry that runId (scheduler linkRun) or its events look
// like background work: buffered forever, run view stuck on "You:" with a
// Stop that never clears. See app.js taskEventForBackground/refreshTasks.

export type AgentEventRoute = 'foreground' | 'background';

/** Where one agent event belongs. Unknown runs assume background; a later
 * tasks refresh either confirms it or replays the buffer into the run view. */
export function routeAgentEvent(
  cachedTaskId: string | undefined,
  foregroundTaskId: string | null,
): AgentEventRoute {
  if (cachedTaskId) return cachedTaskId === foregroundTaskId ? 'foreground' : 'background';
  return 'background';
}

export interface ReplayWaiter {
  /** A live run view exists. */
  present: boolean;
  /** Its runId, or null when still waiting for the invoke response. */
  runId: string | null;
}

/** Buffered events for a run that turned out to be the foreground task may
 * render into an absent run view (adopt it) or a waiting one (same run);
 * never into a view bound to a different run. */
export function shouldReplayBuffered(
  runId: string,
  cachedTaskId: string | undefined,
  foregroundTaskId: string | null,
  waiter: ReplayWaiter | null,
): boolean {
  if (!cachedTaskId || cachedTaskId !== foregroundTaskId) return false;
  if (!waiter || !waiter.present) return true;
  return waiter.runId === null || waiter.runId === runId;
}
