# Testing

```powershell
npm run typecheck   # tsc -p tsconfig.main.json --noEmit
npx vitest run      # unit suites in tests/unit/
```

Suites: slash, providers (fake SSE, no network), workflow, settings,
db, secrets-redaction, router (builtin-only, no-spawn), tab, slash-scope.
Provider tests never hit network. Run both commands before every PR.

Provider conformance (`tests/unit/providers-conformance.test.ts`) runs the
same mocked-HTTP scenarios against every adapter, plus a literal-contract
test that fails when request/response literals (`max_tokens`,
`anthropic-version`, `tool_choice`, …) appear outside
`src/main/ai/providers/<id>/` (`retry.ts` exempt as generic recovery).

Optional live smoke (real keys, never in CI): set `NEXIO_LIVE_SMOKE=1` with
`<PROVIDER>_API_KEY` in env and run the Test button manually from Settings;
do not commit keys or transcripts.

## E2E (`node e2e/suite.js`, `node e2e/trash-verify.js`)

Drives the real popup via CDP. Needs the app running with the debugger
open first: `npx electron . --remote-debugging-port=9222`, then run the
suite from the repo root. OS helpers are picked automatically: pywinauto
(`python`) on Windows, Quartz + `screencapture` (`python3`, no extra deps)
in `e2e/mac/` on macOS. Fail-path tests force failure against a closed
local port and restore your provider settings afterwards; the trash test
does the same with a fake local tool server. Screenshots land in
`artifacts-e2e/`.
