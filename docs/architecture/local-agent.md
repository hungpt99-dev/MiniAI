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

## Tools (`src/main/agent/tools/`)

Read: `fs_search fs_read fs_list apps_list clipboard_read web_search
web_fetch`. Write: `app_open clipboard_write fs_write fs_move fs_copy
fs_trash` (trash only, never delete). Destructive: `shell_run`.
