# Tasks

Do mode runs **tasks** in the background: spawn parallel work, queue work for
later, and let the agent split large jobs into subtasks.

## Definitions

| Word | Meaning |
|---|---|
| Task | One prompt running through the Do agent loop. Top-level (user) or subtask (agent). |
| Spawn | The USER starts a separate task now. Parallel, no parent, no shared context. |
| Queue / push to queue | The USER adds a task to a waiting list. Starts when a slot is free. Top-level, independent. |
| Subtask | A task created BY THE AGENT inside a running task. Has a parent; the parent may wait. |

"Spawn" is reserved for the user action. Agent tools are named `subtask_*`.

## Creating work

- Enter with nothing running runs as the foreground task (run view, as before).
- Enter while a task runs: an inline choice — [Run separately] [Add to queue]
  [Replace current] (default Run separately; "Don't ask again" saves the default).
- Ctrl/Cmd+Enter always pushes to the queue, even with a free slot. Shift+Enter is a newline.
- Slashes (before the router): `/spawn <text>`, `/queue <text>`, `/tasks`,
  `/cancel <n>` (n-th live row), `/clear-queue` (asks first).
- Under an answer: "Run as separate task" and "Add to queue" re-send the prompt.
- Footer hints depend on state: idle `[Tab] switch mode [Enter] run [Esc] close`;
  typing `[Enter] run [Ctrl+Enter] queue [Esc] clear`; task running `Stop + [Esc]`
  (the global stop hotkey is in the Stop tooltip); waiting approval
  `[Enter] allow once [Esc] deny`. The footer Tasks entry is an icon button
  (badge = running+queued, dot = approval needed).

A task snapshots its context at creation — working folder, mode, provider/model,
relevant memory ids, attachments (copied to the task's own temp folder) — and
never inherits another task's messages.

## States

`queued → running → (waiting_approval ↔ running) → done | failed | stopped | interrupted`.
A parent waiting for subtasks stays `running` with "Waiting for subtasks" and
releases its slot so children can run. Every task ends in exactly one terminal
state; Retry requeues terminal work. The watchdog fails a task after 60 s with
no event (approvals never time out).

## Scheduler (`src/main/tasks/`, main process only)

- Concurrency: max 2 running by default (Settings 1–4), counting ALL running
  tasks including subtasks. Full → new spawns queue with "Queued: N tasks ahead".
- Ordering: FIFO within a priority; `high` first (Shift+click / Tasks view);
  user tasks outrank agent subtasks at the same priority; at most 3 high in a
  row before a normal one runs (fairness).
- Caps: 20 queued top-level + 10 queued subtasks; the user is told when hit.
- Provider 429/Retry-After pauses the queue instead of failing tasks.
- Quit with running tasks asks first and marks them `interrupted`; queued work
  persists. Restart never auto-runs: "N tasks were waiting. Resume? [Resume]
  [Discard]". Sleep does the same with Retry. Terminal tasks older than 30 days
  (configurable) prune with their attachments. Incognito tasks stay in memory.

## Resource locks

Write tools acquire locks on normalized absolute paths; a folder lock covers
children. Two tasks never write the same file or overlapping folders at once —
the later stays queued with "Waiting for \<path\> (used by \<task\>)" and
starts on release. Reads never block but note locked paths on the tool result.
60 s wait cap fails the waiter with a clear message. Comparison follows OS
rules (macOS NFC, Windows case-insensitive) via the platform adapter.

## Agent subtasks (`subtask_*`, Do only, risk write, never in Ask)

- `subtask_create {title?, prompt, priority?, wait?}` → `{taskId}`; `wait=true`
  pauses the parent until the subtask ends, then returns its summary (≤2000 chars).
- `subtask_list {state?}` (own subtasks only), `subtask_result {taskId}`,
  `subtask_cancel {taskId}`. Forged cross-parent calls are rejected.
- First create per run shows ONE confirmation with the exact prompts
  (Allow once / Deny); further creates within limits don't prompt. Deny returns
  "User denied" to the model.
- Caps: 5 per parent, depth 2, 50/hour, identical prompts deduped 10 min; a
  burst pauses the queue (circuit breaker) until reviewed.
- Isolation: sanitized prompt only (≤4000 chars) + the user's attachments;
  never the parent conversation; roots/rules inherited, never more;
  provenance `agent_subtask`. File/web/attachment text must arrive as data in
  the delimited block, never as instructions; creates after untrusted reads
  show "Requested after reading \<source\>".
- Agents can ONLY create subtasks — never spawn/queue user tasks, reorder, or
  touch others' tasks (dispatcher rejects forged calls; Ask rejects with
  `MODE_READ_ONLY`).

## Approvals

Nothing auto-approves, ever. A risky call parks the task in `waiting_approval`
(no timeout); cards render only in that task's own view (inline for the
foreground task), the footer chip shows "N needs approval" with a warn dot,
and a notification names the tool + exact action (never file contents).
"Review all" walks pending cards one by one; no approve-all for shell or
destructive actions. Task-scoped "always" expires with the task. Hidden-window
tasks pause + notify identically.

## UI

Tasks view (`/tasks`, footer list icon with running+queued badge): title,
"2 running, 3 queued", sections Needs approval → Running → Queued → Done (last
10 + Show more). Rows (56px+): status icon, 14px title, 12px muted second line
(state detail / step / outcome), elapsed (`Intl`), overflow menu (Open, Stop,
Move up, Retry, Undo, Remove). Subtasks indent 16px with connector + `agent`
tag. Detail: "Started by you" / "Created by Nexio", prompt, outcome, chips
(Open folder, Undo, family undo), collapsed steps, pending cards, Stop. Queued
rows drag + Alt+Up/Down (announced in the live region). Failed rows expand with
Retry. Footer chip priority: approval > running > done. Settings > Agent >
Tasks holds the limits + subtask + resume + notification + prune switches.

## History, log, undo

Per-task run logs carry taskId/parentId/depth/origin/priority, lock waits
(paths only), approvals, terminal state; the log view nests subtasks under
parents. Undo is per task (`undoGroupId` = run id); parents offer family undo
(subtasks reverse, then parent) with conflict warnings that skip newer work
instead of overwriting. One notification per top-level family, none per subtask,
no file contents.

## Limits

Per run as today: 25 tool calls, 5 minutes, 30 s per tool, 8,000-char output
cap. Approval waits never count against time.

## Shortcuts

`Enter` run · `Ctrl/Cmd+Enter` queue · `Shift+Enter` newline · `Alt+Up/Down`
reorder queued rows in the Tasks view.

## Run-view routing + silence watchdog

Every agent event is keyed by runId. The renderer's tasks cache maps runIds to
tasks; a foreground inline run links its agent runId onto the task record at
creation (`scheduler.linkRun`, before the first event can arrive), so live
events render in the run view instead of buffering as background work. Events
that arrive before the tasks refresh replays from the buffer once the mapping
is known (`src/shared/task-routing.ts` holds the rule; both sides mirror it).

A run is never silent: the run view shows "Planning…" from submit, "Still
working… [Stop]" after 10 s with no event, and a "No response. Retry?"
error with [Retry] + [Copy details] after 60 s. The run stays alive under the
watchdog — Stop still aborts it, Retry stops it and starts over.
