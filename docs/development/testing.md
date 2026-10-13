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
