# Implementation status (v0.1.0)

Verified from source; packaged-SQLite caveat in main README.

## Implemented

| Area | Detail |
|---|---|
| Chat providers | openai / anthropic / gemini / compatible, SSE + fallback, 60 s timeout |
| Secrets | safeStorage DPAPI + XOR fallback (dev `console.warn`), `redact()` |
| Env fallback | `${PROVIDER}_API_KEY` in `ipc.ts` |
| DB | `%APPDATA%/Nexio/nexio.db` or `NEXIO_DATA_DIR`, WAL mode |
| Router | Freezes mode/session/requestId, no silent fallback; agent → built-in loop only |
| Tab toggle | Palette/IME/focus guards + Alt+M |
| Slash | Scope chat/agent/both with suggestions |
| Workflows | prompt → transform → conditional → user-input → output |

| Do loop | Built-in tool loop in main, approvals, redacted JSONL + runs.jsonl |
| Ask loop | Same loop, read-only: askSafe tools only, MODE_READ_ONLY guard, 8 calls / 60 s, no approvals, secrets redacted |

## Planned / known gaps

| Area | Detail |
|---|---|
| Packaged SQLite | Electron 33 bundles Node 20; `node:sqlite` needs 22.5+ — packaged app fails to open DB. Documented, not fixed. |
| Tray icon | `assets/icon.png` + `assets/tray/` sizes; macOS `Nexio-Template` pair. |
