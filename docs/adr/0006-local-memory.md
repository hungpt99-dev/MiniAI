# ADR 0006: Local long-term memory

- Status: accepted
- Date: 2026-10-14

## Context

Nexio should remember user preferences, facts, folder conventions,
procedures and past-run summaries across conversations, and use them to act
better — without accounts, servers, or sending the user's life anywhere it
doesn't already go (the selected chat provider).

## Decision

- **Same SQLite DB** (`nexio.db`, existing `node:sqlite` layer), new tables
  `memories` / `memory_fts` / `memory_events`. No separate `memory.db`, no
  `better-sqlite3` (zero-dep rule; native modules would break the easy
  Windows/macOS build and the packaged app already can't open SQLite).
- **FTS5 keyword retrieval first** (BM25 over plaintext rows, LIKE/token
  fallback; encrypted-only rows search after decrypt, store capped at 500).
  Embeddings optional and off: no embeddings endpoint is used anywhere yet,
  so "Semantic search" is a reserved setting until a provider/local backend
  is wired.
- **Encrypt text at rest** with the existing safeStorage secret backend
  (DPAPI/Keychain), plaintext-with-notice fallback — same pattern as API
  keys. FTS mirrors plaintext rows only.
- **User-visible and user-written only**: Memory view + Settings section,
  explicit "remember …" saves, suggestion chips (opt-in) from user messages
  only, import/export JSON. Untrusted content (files, web, attachments, MCP)
  can never create/edit/delete: tool calls after any untrusted read force
  the confirmation card; Ask-mode writes stay blocked except via the
  explicit confirmation row/card path.
- **Prohibitions enforced in code**: unambiguous user-approved "never touch
  X" folder rules become `extraProtected` paths in the existing permission
  layer — same roots/traversal/symlink checks, no parallel system.
- Tools join the existing registry with risk levels (`memory_search`
  read/askSafe; save/update/forget write, Ask-blocked); retrieval injects a
  delimited `<user_memory>` block through the existing `systemExtra` path
  (8 items, ~1,200 tokens); lifecycle (dedupe, conflicts, expiry, staleness,
  caps) lives in the store.

## Consequences

- No new dependencies, no new processes, no network beyond the chat
  provider. Retrieval and enforcement reuse permissions, policy, logging and
  approval infrastructure.
- Semantic search, per-project scoping inputs (no project ids exist yet),
  and `.nexio/rules.md` re-approval UX stay minimal until asked for.
