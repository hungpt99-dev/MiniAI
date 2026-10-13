# Implementation status (v0.1.0)

Verified from source; packaged-SQLite caveat in main README.

## Implemented

| Area | Detail |
|---|---|
| Chat providers | openai / anthropic / gemini / compatible, SSE + fallback, 60 s timeout |
| Secrets | safeStorage DPAPI + XOR fallback (dev `console.warn`), `redact()` |
| Env fallback | `${PROVIDER}_API_KEY` in `ipc.ts` |
| DB | `%APPDATA%/Nexio/nexio.db` or `NEXIO_DATA_DIR`, WAL mode |
| Router | Freezes mode/runtime/session/requestId, no silent fallback |
| Tab toggle | Palette/IME/focus guards + Alt+M |
| Slash | Scope chat/agent/both with suggestions |
| Workflows | prompt → transform → conditional → user-input → output |

## Experimental

| Area | Detail |
|---|---|
| Agent adapters | opencode HTTP SSE, claude/codex CLI JSONL (see agents docs) |

## Planned / known gaps

| Area | Detail |
|---|---|
| Packaged SQLite | Electron 33 bundles Node 20; `node:sqlite` needs 22.5+ — packaged app fails to open DB. Documented, not fixed. |
| Tray icon | `assets/icon.svg` placeholder, needs PNG. |
