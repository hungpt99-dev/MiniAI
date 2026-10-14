# ADR 0007: Task queue with scheduler-owned runs

## Status

Accepted.

## Context

Do mode ran one task at a time (renderer singleton + `stopAllAgentRuns`).
Users want parallel spawns, a waiting queue, and agent-created subtasks
without weakening approvals, provenance, undo, or Ask read-only mode.

## Decision

- A main-process scheduler (`src/main/tasks/scheduler.ts`) owns task records
  and slots; the agent loop stays unchanged and runs tasks via injection
  (`taskLock` hooks, `subtaskAskFirst`, `TaskParkedError`).
- Foreground runs execute inline through the existing send/agentStart paths
  with a mirrored task record (same loop, tools, policy, approvals, limits,
  log, undo); background runs execute through `runScheduledTask` with the
  same composition.
- Renderer keeps one active view; per-run state is keyed by runId with
  foreground-only adoption into the run view.
- Words are fixed: spawn/queue are user actions; the agent only has
  `subtask_*` tools bound to its own parent run.

## Consequences

- Write locks serialize same-path writers across all origins; parked tasks
  requeue with reasons instead of failing.
- Approvals are per task/runId; unattended tasks pause + notify.
- Queue caps, fairness rules, subtask caps, and the circuit breaker bound
  agent-driven multiplication.
