# Architecture overview

## Processes

- **main** (`src/main/`): Electron main — IPC handlers, SQLite DB,
  chat providers, agent runtimes, slash registry, secret/settings stores.
- **shared** (`src/shared/`): IPC channel names, types, mode-utils.
  Must stay main+renderer safe (no Node/Electron imports).
- **renderer** (`src/renderer/`): plain JS/CSS Spotlight popup (640 content
  width, auto-height 72–560, window==panel (no shadow, no pad), transparent frameless).
  Talks to main only via preload-exposed IPC. Sends `nexio:resize` with
  panel height; main clamps and sizes the window. Bundled fonts only
  (`fonts/`, Geist + JetBrains Mono, OFL) — no remote links. Dark only.

## IPC

Renderer → preload → main handlers (`src/main/ipc.ts`), channels in
`src/shared/ipc-channels.ts`. Keys never cross the bridge unmasked;
`redact()` before any logging.

## Router (no-fallback rule)

Router freezes mode, runtime, session, and requestId at dispatch.
No silent fallback between providers or runtimes — failures surface
with `{ok|failed|aborted}` instead of retrying elsewhere.

## Platform adapter

All OS differences live behind one interface (`src/main/platform/`:
`win32.ts` + `darwin.ts`, chosen at startup). Shell execution, app listing,
open/trash, protected roots, hotkeys, key-cap labels, secrets backend, login
env, path rules and data dirs come from the adapter — nowhere else checks
the OS. See `docs/platforms.md`.

## Intent routing (Do / Ask launcher)

Non-explicit sends are classified in main before execution: a cheap
heuristic first (`src/main/agent/intent.ts`), else one small model call.
`act` → built-in agent/tool loop, `answer`/`clarify` → plain streamed
response. An explicit pill pick wins over routing. The footer shows
`Doing` / `Answering` for the actual path taken.

## Undo journal + run log

Reversible tool ops are journaled per run (`undo/<runId>.json`,
`src/main/agent/undo.ts`) and reversed in reverse order through the same
permission layer. Run outcomes land in `runs.jsonl` (`src/main/agent/runs.ts`)
for the History → Run Log view.
