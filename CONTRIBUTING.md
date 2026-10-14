# Contributing to Nexio

Windows + macOS project. Small, focused PRs welcome.

## Setup

Windows x64 or macOS 13+ (Apple Silicon or Intel):

```powershell
npm ci
npm run typecheck
npx vitest run
```

Requires Node >= 22.5 for tests (`node:sqlite` via
`process.getBuiltinModule`). The packaged app (Electron 37 / Node 22)
opens SQLite fine. macOS note: `npm run assets` needs Xcode command-line
tools (`iconutil`) to build `icon.icns`; other platforms use the
checked-in fallback and `assets:check` still passes.

## Building

```powershell
npm run build:main
npm run build:renderer
npm run dist   # win: nsis + portable. macOS (on a Mac): dmg + zip universal
```

`dmg`/`zip` must be built on macOS; CI builds + tests all three targets
(`windows-latest`, `macos-latest`, `macos-13`), and `release.yml` ships
installers on `v*` tags. Unsigned builds work; signing/notarization needs
owner credentials (see `docs/release.md`).

## PR guidelines

- Keep PRs focused: one change, minimal diff.
- Do not touch `src/`, `tests/`, `scripts/`, `package.json`,
  `electron-builder.yml` unless the issue asks for it.
- Run `npm run typecheck` and `npx vitest run` before pushing.
- No lint/format tooling — match surrounding 2-space style, CRLF.
- No secrets in code, logs, fixtures, or screenshots.
  API keys live in OS keychain / env only, never committed.
- Live provider smoke is manual and opt-in (`NEXIO_LIVE_SMOKE=1`,
  see `docs/development/testing.md`); never commit keys or transcripts.
- Update docs (`docs/`) when behavior changes.

## Long-term memory rules

- Single access layer: `src/main/memory/store.ts` owns the `memories`,
  `memory_fts` and `memory_events` tables. No other module touches them.
- New tools need an explicit `askSafe` flag (`memory_search` is read/askSafe;
  save/update/forget are write and Ask-blocked). New kinds need a Settings
  opt-in key plus a Memory view tab.
- Never store secrets: every save path (tool, channel, import, extractor)
  goes through the secrets/PII scanner. Never log memory text — run logs
  carry ids/kinds only (see `logEvent` in `src/main/agent/loop.ts`).
- Untrusted content (files, web, attachments, MCP) must never write
  memories. Keep the `lastUntrusted` provenance gate in `executeToolCall`
  and the Ask dispatcher block; add a regression test for any new write
  path (`tests/unit/memory*.test.ts`).
- Retrieval budgets (8 items, ~1,200 tokens) and text caps (300/500 chars)
  are constants in `src/main/memory/types.ts`. Raise them only with a test.
- Self-verify end to end: drive new memory flows through the real `send`
  handler with a scripted provider (`tests/unit/memory-e2e.test.ts`
  pattern), not just the store.
