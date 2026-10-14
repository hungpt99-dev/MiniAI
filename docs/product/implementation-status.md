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
| Memory | Local SQLite (memories/FTS/events), retrieval ≤8 items/~1200 tokens, enforced prohibitions, incognito; embeddings reserved |
| Attachments | Content detection (ZIP/OLE structure) + policy table; docx/xlsx/pptx/odt/rtf text extraction; PDF reference-only (extraction Planned) |

## Planned / known gaps

| Area | Detail |
|---|---|
| Semantic search | Setting exists; retrieval stays FTS until a provider/local embeddings backend is wired. |
| Project scopes | Memory scope type exists; no project ids flow from the app yet. |

## Planned / known gaps

| Area | Detail |
|---|---|
| Packaged SQLite | Resolved by the Electron 37 upgrade (bundled Node 22.21 ≥ 22.5): Windows portable launches with working `node:sqlite`. |
| Tray icon | `assets/icon.png` + `assets/tray/` sizes; macOS `Nexio-Template` pair. |
