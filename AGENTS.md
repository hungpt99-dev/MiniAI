# AGENTS.md — MiniAI

Popup AI assistant (BYOK), Electron. Status: v0.1.0, Windows-only,
pre-remote. Packaged app cannot open SQLite — see README Known Limitation.

## Stack

Electron 33.4.11 (Node 20.18.x, ABI 130), TypeScript 5.6, vitest 2.1.
Zero runtime deps. `node:sqlite` via `process.getBuiltinModule`
(requires Node 22.5+).

## Dir map

- `src/main/` — Electron main: IPC, DB, providers, agent, slash, store
- `src/shared/` — IPC channels, types, mode-utils (main+renderer safe)
- `src/renderer/` — plain JS/CSS popup UI (no framework)
- `scripts/` — copy-renderer build step
- `tests/unit/` — vitest suites
- `docs/` — product, architecture, development, agents docs

## Commands (Windows, PowerShell)

`npm ci` · `npm run typecheck` · `npx vitest run`
`npm run build:main` · `npm run build:renderer` · `npm run dist`

## Style

2-space TS/JS, CRLF, UTF-8, final newline, trim space.
Smallest diff; reuse existing helper/pattern; no new deps w/o reason.

## Security

Keys in `safeStorage`/DPAPI, `redact()` before log, XOR fallback
warns only. Env `${PROVIDER}_API_KEY` dev-only. Never commit secrets.

## Testing / docs rules

Typecheck + vitest before PR. Update `docs/` on behavior change.
Additive README edits only.

## Agent principles

1. Scope first: list callers, tests, fixtures, config, exports.
2. Smallest complete change; deletion beats addition.
3. Reuse codebase helper before stdlib before dep.
4. Fix root cause once in shared code.
5. Keep error handling and validation on move/merge.
6. No abstraction, option, or "for later" code.
7. One-line `why` comment only when code can't show it.
8. Verify by running, not by reading.
9. Report what was actually verified + gaps.
10. Never expose secrets; ask before destructive ops.

## Done = typecheck + vitest green, no stray files, docs updated.
