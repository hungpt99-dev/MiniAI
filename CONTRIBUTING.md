# Contributing to Nexio

Windows-first project. Small, focused PRs welcome.

## Setup (Windows x64)

```powershell
npm ci
npm run typecheck
npx vitest run
```

Requires Node >= 22.5 for tests (`node:sqlite` via
`process.getBuiltinModule`). See README Known Limitation for the
Electron 33 / Node 20 packaging caveat.

## Building

```powershell
npm run build:main
npm run build:renderer
npm run dist   # electron-builder --win portable
```

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
