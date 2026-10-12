# Testing

```powershell
npm run typecheck   # tsc -p tsconfig.main.json --noEmit
npx vitest run      # unit suites in tests/unit/
```

Suites: slash, providers (fake SSE, no network), workflow, settings,
db, secrets-redaction, adapters, router, tab, slash-scope.
Provider tests never hit network. Run both commands before every PR.
