# Built-in local agent (computer-use)

Agent mode runs a tool-calling loop in the **main process** on top of the
configured chat provider (OpenAI / Anthropic / Gemini / OpenAI-compatible).
No external agent CLI is wrapped. Chat mode is untouched.

## Flow

1. Renderer sends `nexio:agent-start` (conversationId, text, working folder)
   and gets a `runId`. `AgentEvent`s stream back on `nexio:agent-event`.
2. `src/main/agent/loop.ts` sends system prompt + history + tool definitions
   via `src/main/ai/tools-chat.ts` (one interface over `PROVIDER_DEFS`
   endpoints/headers — no second set of clients).
3. Each model tool call is schema-validated, path-normalized
   (`permissions.ts`), policy-checked, optionally approved
   (`nexio:agent-approve`: `allow-once` / `deny` / `always`), run with
   timeouts, truncated to 8,000 chars, and appended as delimited untrusted
   data. Deny returns `{ok:false, "User denied"}` so the model adapts.
4. Limits: 25 tool calls/run (settings `agentMaxCalls`), 5 min/run
   (approval waiting excluded), 30 s/tool. One `AbortController` per run;
   Stop / Esc / global stop hotkey (`agentStopHotkey`, default
   `Ctrl+Alt+Esc`) aborts the request and kills the child process tree.

## Safety

- `permissions.ts`: read auto-runs inside allowed roots only; write needs
  approval unless a scoped always-rule covers the folder; `shell_run` needs
  approval every time except an exact saved command. System dirs, `.ssh`
  and browser profiles are blocked unless the user explicitly adds that
  folder. `shell_run` rejects admin-looking commands and never elevates.
- `log.ts`: per-run JSONL in `<data>/agent-logs`, secrets redacted.
  `/log` opens the latest log.
- Injection: tool output is wrapped as untrusted data; write/destructive
  calls right after untrusted reads show "Requested after reading
  \<source\>" on the approval card.
- Attachments in Do mode: `attachment_list` / `attachment_read` (read-only)
  expose the run's staged files as context paths; their output is untrusted
  and never grants permission. The router only sees attachment metadata
  (name/type/size), never bytes.

## Tools (`src/main/agent/tools/`)

Read: `fs_search fs_read fs_list apps_list clipboard_read web_search
web_fetch attachment_list attachment_read`. Write: `app_open clipboard_write fs_write fs_move fs_copy
fs_trash` (trash only, never delete). Destructive: `shell_run`.

Every tool carries an explicit `askSafe` flag (default `false`; new tools are
blocked in Ask until opted in). `askSafe: true` only for the read tools above
plus `skill_load` (instructions only); `web_search`/`web_fetch` only run in Ask
when configured. Writes, `app_open` and `shell_run` are `askSafe: false`.

| Tool | Risk | askSafe | Notes |
|---|---|---|---|
| `memory_search` | read | true | ids + capped text |
| `memory_save` | write | false | Ask-blocked as a tool; Ask saves only via the confirmation row/card path |
| `memory_update` | write | false | same rules as save |
| `memory_forget` | write | false | multi-delete lists items on the card |
| `subtask_create` | write | false | Do only, parent-bound; one confirmation per run, then capped silent creates |
| `subtask_list` | write | false | own subtasks only; forged ids rejected |
| `subtask_result` | write | false | finished-subtask status + summary, own subtasks only |
| `subtask_cancel` | write | false | own subtasks only |

## Ask mode (read-only)

Ask (`chat`) runs the same loop with the Ask tool set and a read-only system
prompt (`src/main/agent/prompts/ask.ts`). Policy lives in
`src/main/agent/mode-policy.ts` (`allowedInAsk`: `risk === 'read'` and
`askSafe`). Three layers: (a) the model only sees askSafe tools, (b) the
dispatcher guard blocks anything else with `MODE_READ_ONLY` (covers forged or
injected names), (c) read implementations cannot write (no shell, no write
syscalls). Limits: 8 calls, 60s total, 30s per tool. No approval cards in Ask:
reads inside allowed roots auto-run; reads outside return "Outside the allowed
folders…"; web calls right after a file read wait for explicit user
confirmation. Skills load instructions only (scripts never run in Ask); MCP
tools only when the server is trusted, the tool is read-only, and the user
opted that tool into Ask (default off); hooks and workflows never run in Ask
(`/workflow` in Ask shows "Workflows run in Do mode" + switch chip). File text
read in Ask goes to the selected provider (one-time remote-provider notice);
secrets are redacted before the model ("Secrets hidden") and never logged.
