# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Secret handling (how this project stores keys)

- API keys are stored in SQLite via Electron `safeStorage`
  (DPAPI on Windows).
- When `safeStorage` is unavailable, the app falls back to a plain
  XOR-obfuscated local value and logs a `console.warn` (dev only).
  Do not rely on this fallback for real secrets.
- `redact()` masks `sk-…`, `Bearer …`, `api_key=…` before logging.
- Dev-only env fallback: `${PROVIDER}_API_KEY` (e.g. `OPENAI_API_KEY`)
  is read in `ipc.ts`. Never commit `.env` files.
- DB lives at `%APPDATA%/MiniAI/miniai.db` (WAL mode) or
  `MINIAI_DATA_DIR` override. Back it up carefully — it holds secrets.
- No telemetry found in the codebase; network calls go only to
  configured providers.

## Reporting a vulnerability

Report via GitHub private security advisory. Do not open a public GitHub Issue.
Do not include keys, tokens, or personal data in reports.
