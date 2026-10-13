# Architecture overview

## Processes

- **main** (`src/main/`): Electron main â€” IPC handlers, SQLite DB,
  chat providers, built-in agent loop, slash registry, secret/settings stores.
- **shared** (`src/shared/`): IPC channel names, types, mode-utils, approval, focus.
  Must stay main+renderer safe (no Node/Electron imports).
- **renderer** (`src/renderer/`): plain JS/CSS Spotlight popup (640 content
  width, auto-height 72â€“560, window==panel (no shadow, no pad), transparent frameless).
  Talks to main only via preload-exposed IPC. Sends `nexio:resize` with
  panel height; main clamps and sizes the window. Bundled fonts only
  (`fonts/`, Geist + JetBrains Mono, OFL) â€” no remote links. Dark only.

## Entry points

- `src/main/main.ts` â€” `startup()`: single-instance lock, `getDb()`,
  `seedBuiltins()`, `registerIpc()`, extension seed/autostart, popup + tray,
  toggle hotkey. Stays in tray on window-all-closed.
- `src/main/popup.ts` â€” frameless popup window, height clamp, blur-hide.
- `src/main/tray.ts` â€” Show/Hide + Quit.
- `src/main/preload.ts` â€” `window.nexio` bridge only; no direct Node access.

## IPC

Renderer â†’ preload â†’ main handlers (`src/main/ipc.ts`), channels in
`src/shared/ipc-channels.ts`. Keys never cross the bridge unmasked;
`redact()` before any logging. Non-Error rejections normalize via `asError()`
so the real cause (`auth: â€¦ â€” open Settings and check your API key`) reaches the UI.
Contract is pinned by `tests/unit/ipc-contract.test.ts` (prefix, uniqueness,
required channels, no runtime channels).

- Chat: `send` (intent-routed), `chat` (direct stream), `chat-cancel`, `chat-stream` (push).
- Providers: `test-connectivity` (unsaved panel values: listModels + tiny
  completion + tool probe), `list-models` (model suggestions),
  `reset-provider-fixes` (clear the 30-day param-fix cache).
- Do mode: `agentStart` â†’ runId + `agentEvent` push, `agentApprove`, `agentStop`,
  `agentLog`, `agentRun` (explicit agent send). All Do runs execute the built-in
  loop; the run log records builtin/workflow runs only.
- Data: settings, api-key, conversations/messages, templates, workflows,
  slash, ext, runs/undo/reveal, platform/hotkey, route-status/run-summary/popup-shown.

## Agent loop (built-in computer use)

`src/main/agent/loop.ts` `runAgent()` runs fully in main: system prompt, then
`requestToolTurn` (`src/main/ai/tools-chat.ts`, neutral messages + tools shaped
per provider by `src/main/ai/providers/<id>/` adapters), then `executeToolCall()` per call
â†’ repeat until text answer, limit, abort, or timeout. Every run appends
redacted JSONL (`log.ts`). Renderer only renders `AgentEvent`s and resolves
approvals over IPC; it never gets shell access.

`Do` sends call `loop.ts` directly via `runBuiltInAgent()` in `ipc.ts`
(approvals, ext tools, history/finishRun shared with `agentStart`).

## Router (no-fallback rule)

`src/main/agent/router.ts` freezes mode, session, and requestId at
dispatch. `chat` â†’ provider stream; `agent` is never routed here â€” Do
sends run the built-in loop in `ipc.ts` (`runBuiltInAgent` â†’ `loop.ts`)
directly, so there is no external runtime to fall back to and no spawned
agent binary. Failures surface as thrown errors (`agent-direct`, `auth`, â€¦).

## Tools

`src/main/agent/tools/registry.ts` (`ALL_TOOLS`, `TOOL_MAP`): `fs_list`,
`fs_read`, `fs_write`, `fs_copy`, `fs_move`, `fs_trash`, `fs_search`,
`app_open`, `apps_list`, `clipboard`, `clipboard_read`, `clipboard_write`,
`shell_run`, `web_search`, `web_fetch`. MCP tools join the same registry as
`mcp__server__tool`; `skill_load` surfaces enabled skills.

## Permissions

`src/main/agent/permissions.ts` + `src/main/platform/` (`win32.ts`/`darwin.ts`):
`validateInput` (schema) â†’ hooks (`PreToolUse`: block or force-approval only,
never auto-approve) â†’ path normalization (`normalizeAndResolve`) â†’ `decidePolicy`
(auto / approval-required / denied) â†’ approval wait (excluded from run budget)
â†’ run with tool timeout â†’ truncate. Reads auto-run inside allowed folders;
writes need approval; `shell_run` needs approval every time; deletes are
trash-only. `shell_run` and MCP tools are never undoable.

## Extensions

`src/main/extensions/`: skills (progressive `skill_load`, `/<skill>` arms context),
MCP (official SDK, stdio + Streamable HTTP/SSE, trust-gated), hooks
(`PreToolUse`/`ApprovalRequested`/`PostToolUse`/`UserPromptSubmit`/`RunStopped`/`RunDone`,
can only make permissions stricter), workflows (ext + legacy). One typed
dispatch channel (`nexio:ext`). Everything installs OFF until reviewed.

## Settings / storage

SQLite `%APPDATA%/Nexio/nexio.db` (WAL), override `NEXIO_DATA_DIR`
(`src/main/db/db.ts`). Legacy MiniAI paths (`.MiniAI` db files) are read
in place, never moved. Tables: conversations, messages, templates, workflows,
runs, secrets (safeStorage DPAPI/Keychain, XOR fallback warns only), settings
(key/value JSON, `validateSettings` + `updateSettings`). Removed external-runtime
keys (`agentRuntime`, `agentBackend`, `engine`, `opencodeBaseUrl`, `claudeBin`,
`codexBin`) fall back to built-in and are purged on read. Dev-only env fallback
`${PROVIDER}_API_KEY`. MiniAIâ†’Nexio migration is DB-path only.

## Platform

All OS differences live behind one interface (`src/main/platform/`:
`win32.ts` + `darwin.ts`, chosen at startup). Shell execution, app listing,
open/trash, protected roots, hotkeys, key-cap labels, secrets backend, login
env, path rules and data dirs come from the adapter â€” nowhere else checks
the OS. See `docs/platforms.md`.

## Intent routing (Do / Ask launcher)

Non-explicit sends are classified in main before execution: a cheap
heuristic first (`src/main/agent/intent.ts`), else one small model call.
`act` â†’ built-in agent/tool loop, `answer`/`clarify` â†’ plain streamed
response. An explicit pill pick wins over routing. The footer shows
`Doing` / `Answering` for the actual path taken.

## Undo journal + run log

Reversible tool ops are journaled per run (`undo/<runId>.json`,
`src/main/agent/undo.ts`) and reversed in reverse order through the same
permission layer. Run outcomes land in `runs.jsonl` (`src/main/agent/runs.ts`)
for the History â†’ Run Log view.

## Popup views (single-view)

`src/shared/view.ts` owns the view state (`idle|palette|run|settings|extensions|history` + `returnTo`); `src/renderer/app.js showView()` mounts exactly one node in `.view` (dev asserts) with the run unit (`#messages/#agent-steps/#answer-meta/#actions/chips`) wrapped in `#run`. View-only slashes (`/extensions /settings /history /log`) and the footer buttons never submit/route/start runs; background runs surface a single `Running/Done / View` footer chip. Planning rows exist only while active; failures expand steps; approvals block view switches so cards are never buried.
