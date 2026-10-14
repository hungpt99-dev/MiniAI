# Long-term memory

Nexio can remember useful things about you across conversations:
preferences, facts, folder rules, procedures, and short summaries of past
runs (episodes). Memory is **local-first** (same SQLite DB as everything
else), **visible** (Settings > Memory and the `/memory` view), **editable**,
and **opt-in per category**. It never stores secrets, and untrusted content
(file text, web pages, attachments, MCP output) can never write it.

## Kinds and scope

One memory = one small human-readable record (300 chars; episodes 500):

| Kind | Example |
|---|---|
| `preference` | Reply in Vietnamese unless I write in English |
| `fact` | My accountant is Linh; invoices go to Documents/Finance |
| `folder_rule` | In `D:\project\cv` never touch the `/final` folder |
| `procedure` | Weekly cleanup = trash `.tmp` files in Downloads older than 30 days |
| `episode` | Short summary of a past run (auto-expires, default 30 days) |

Scope: `global`, one folder, one app, or one project. Folder rules whose
text is an unambiguous prohibition ("never touch X") are **enforced in code**
as additional protected paths — the permission layer refuses, not just the
model. Enforced rules carry an "Enforced" badge in the Memory view.

Never stored: passwords, API keys, tokens, private keys, card numbers,
government IDs, health or financial account details, full file contents, or
anything the secrets/PII scanner flags. Blocked saves explain why
("Not saved: looks like a secret").

## How memories are created

Only **your own messages** can create memories — never files, attachments,
web pages, tool results or MCP output.

- **Explicit**: say "remember that …" / "from now on …" / "ghi nhớ …".
  Saved immediately as `user_said`; the answer carries a small
  "Remembered: … [Undo] [Edit]" row. Undo deletes it.
- **One-tap** (needs the master switch for storage): first-person
  statements like "my name is …", "tôi tên là …", "I prefer …" show a
  quiet "Remember: …? [Save] [Not now]" row — at most one per run, never
  auto-saved, never repeated after "Not now". With memory off, Save offers
  "Memory is off. Turn it on?" inline instead of switching views. Names
  are stored pinned; changing your name later asks "Replace the old name?".
- **Suggested** (off by default): after a run with 2+ user turns, one cheap
  model call over **your messages only** proposes up to 3 candidates as quiet
  "Remember: …? [Save] [Dismiss]" chips. Never auto-saved. Dismissed items
  are hashed so they are never proposed again. At most one suggestion pass
  per run.
- **Manual**: Settings > Memory > Add memory (text + kind + scope + pin).
- **Import/Export**: JSON (no embeddings) with preview counts, validation
  and dedupe; imports get source `import`.

## Honesty rule

The model must never say it will remember, has noted, or will keep
something unless a `memory_save` call succeeded in that turn. The system
prompt carries the rule plus the live memory status (off / on / already
saved this turn). When memory is off, answers say plainly that Nexio only
knows the conversation and offer "Turn on memory in Settings to keep
this." The run view only ever shows true-state rows (Remembered on save,
Remember…? on proposal, Used N on retrieval) — a bare claim in model
text with no save behind it is a bug; report it.

Injection rule: a `memory_save`/`update`/`forget` tool call that follows any
file, web, attachment, image or MCP read **always shows the confirmation
card** ("Requested after reading \<source\>"), even for explicit requests.
In Ask mode these tools stay blocked; saving happens only through the
explicit confirmation row/card path.

## How memories reach the model

Each run retrieves at most **8 items** and **~1,200 tokens**, filtered by
scope (global + matching folder/app/project), ranked pinned-first then by
relevance, recency and use count. Identity questions ("what is my name?",
"who am i") get boosted queries so a stored name is found even with no
shared words. They arrive as a delimited
`<user_memory>` block labeled background context, never instructions; on
conflict the current message wins. The run view shows "Used N memories"
(collapsed) whenever retrieval fired. Memories never enter web search/fetch
queries or MCP calls unless you asked.

Episodes expire (default 30 days, configurable). Unused non-pinned items go
stale after 180 days and appear in a Review list — never silently deleted.
Pinned items never expire. Cap: 500 memories (configurable); when full,
Nexio asks you to clean up. "Forget everything" (typed confirmation) wipes
memories, vectors and audit rows.

## Storage and encryption

Tables `memories`, `memory_fts` (FTS5 BM25 over plaintext rows, best-effort)
and `memory_events` (audit: ids only) live in the app SQLite DB; one access
layer (`src/main/memory/store.ts`). Text is encrypted at rest with a
safeStorage-backed key when available, plaintext otherwise (Settings >
Memory says which). Retrieval defaults to keyword search; "Semantic search"
is reserved for a future embeddings backend (the toggle exists, retrieval
stays FTS and says so). Memory is per OS user (app data path), never shared.
Run logs record memory ids and kinds only, never text.

## Switching it off

- Master switch: Settings > Memory ("Remember things across
  conversations", default off) or answer "No" in onboarding.
- Per-kind toggles, "Use memory in Ask mode" (default on), incognito
  (`/incognito` or Settings): no history, no memory reads or writes,
  minimal run log, with a footer badge.
- Optional per-folder file `.nexio/rules.md`: read-only agent context for
  that folder. Its text is untrusted except "never touch" lines you approved
  once (hash stored; re-asked if the file changes).
