# Architecture overview

## Processes

- **main** (`src/main/`): Electron main — IPC handlers, SQLite DB,
  chat providers, agent runtimes, slash registry, secret/settings stores.
- **shared** (`src/shared/`): IPC channel names, types, mode-utils.
  Must stay main+renderer safe (no Node/Electron imports).
- **renderer** (`src/renderer/`): plain JS/CSS popup (480×640, frameless).
  Talks to main only via preload-exposed IPC.

## IPC

Renderer → preload → main handlers (`src/main/ipc.ts`), channels in
`src/shared/ipc-channels.ts`. Keys never cross the bridge unmasked;
`redact()` before any logging.

## Router (no-fallback rule)

Router freezes mode, runtime, session, and requestId at dispatch.
No silent fallback between providers or runtimes — failures surface
with `{ok|failed|aborted}` instead of retrying elsewhere.
