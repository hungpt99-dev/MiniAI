# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Secret handling (how this project stores keys)

- API keys are stored in SQLite through the single `src/main/secrets/`
  module over Electron `safeStorage` (DPAPI on Windows, Keychain on macOS).
  Nothing else touches `safeStorage` (grep-tested).
- New secrets use a versioned v2 envelope (base64 ciphertext + backend/app
  id); old raw-buffer rows still read, the legacy insecure `plain:`+xor rows
  read for compatibility but are NEVER written anymore. Writes without a
  backend refuse loudly instead of persisting plaintext silently; the user can
  keep the key for the session only (in memory, never persisted).
- Reads never throw: missing / undecryptable / unavailable / corrupt come
  back as reason codes. An unreadable provider key marks that service for
  re-entry (Settings notice + run error "Nexio could not unlock your saved
  API key. Enter it again in Settings." with Open Settings) instead of
  crashing the run with a raw decrypt string.
- Renames change the OS key, so the app name and userData path are pinned in
  one place (`main.ts` + `db.ts`): the DB always lives under the Nexio folder
  and there is no legacy migration. A blob the current OS key cannot decrypt
  waits for re-entry (Settings notice + run error "Nexio could not unlock
  your saved API key. Enter it again in Settings." with Open Settings)
  instead of crashing the run with a raw decrypt string.
- `redact()` masks `sk-…`, `Bearer …`, `api_key=…` before logging, and
  technical error detail additionally redacts filesystem paths. Logs carry
  secret ids and reason codes only — never values or ciphertext.
- Dev-only env fallback: `${PROVIDER}_API_KEY` (e.g. `OPENAI_API_KEY`)
  is read in `ipc.ts`. Never commit `.env` files.
- DB lives at `%APPDATA%/Nexio/nexio.db` (WAL mode),
  `~/Library/Application Support/Nexio` on macOS, or
  `NEXIO_DATA_DIR` override. Back it up carefully — it holds secrets.
- No telemetry found in the codebase; network calls go only to
  configured providers.

## Long-term memory (injection rule + Ask exception)

- Memory text is encrypted at rest when `safeStorage` is available.
  Saving with no backend refuses loudly instead of writing plaintext;
  Settings > Memory says which backend is active. Run logs record
  memory ids and kinds only, never text.
- Untrusted content (files, web pages, attachments, images, MCP output) can
  NEVER create, edit or delete memories: only the user's own messages feed
  the explicit-remember path, the one-tap detector and the extractor. A
  `memory_save`/`update`/`forget` tool call following any untrusted read
  forces the confirmation card
  ("Requested after reading \<source\>"), and every candidate passes the
  secrets/PII scanner ("Not saved: looks like a secret").
- `memory_save`/`update`/`forget` are `askSafe: false` like all writes, with
  one documented exception: in Ask mode they stay blocked as tools — saving
  happens only through the explicit user confirmation row/card path, which
  writes via direct IPC to Nexio's own store (never user files) and never
  executes a model tool call.
- Retrieved memories are sent to the model only as a scoped `<user_memory>`
  block (≤8 items, ~1,200 tokens), never the whole store, and never into
  web search/fetch queries or MCP calls unless the user asked. Stored
  memories are user-written data treated as background context, not
  instructions — the prompt says so, and the current message wins conflicts.
- Memory is per OS user (app data path), never shared across accounts.
  Incognito mode performs no memory reads or writes and keeps no history.
  "Forget everything" (typed confirmation) wipes memories and audit rows.

## macOS permissions (TCC)

- Reading Desktop, Documents, Downloads, iCloud Drive and removable volumes
  triggers system prompts. Denials (EPERM/EACCES) surface as normal,
  non-fatal tool errors naming the exact System Settings pane; Settings has
  an Open Privacy Settings button. Onboarding explains this before folders
  are chosen.
- Never requested by default: Full Disk Access, Accessibility,
  Screen Recording, Automation. Each is asked for only when a feature needs
  it, with an explanation first, then the exact pane.
- Always refused unless the user explicitly adds the folder in Settings:
  `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/private`, `/etc`,
  `~/Library/Keychains`, `~/Library/Mail`, `~/Library/Messages`,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, browser profiles under
  `~/Library/Application Support` and `~/Library/Safari`.
  `/Applications` is write-protected (reads allowed).
- Same rule on Windows: `C:\Windows`, Program Files, Program Files (x86),
  ProgramData, `.ssh`, browser profiles. UNC/device paths stay rejected.

## Attachments

- File types are detected by magic bytes + structure, never the extension:
  ZIP containers are opened (OOXML/ODF/EPUB/JAR classified by central
  directory), OLE2 by stream markers. Renamed executables reject even when
  the extension claims otherwise. Details: `docs/attachments.md`.
- Rejected inline (never silent), with a specific reason: executables,
  installers, shortcuts and code packages (`exe elf macho msi lnk url scf
  appx jar apk` by content), empty files. Macros and encrypted files are
  accepted as reference-only with a visible warning — never opened or run.
  Types the active provider cannot read natively are refused with
  "<provider> can't read .docx directly" (remove the file or switch model).
- Limits: max 5 files, 20MB per file, 200KB text truncation, 50MB total,
  plus each provider's own request-size cap (base64 adds ~33%).
- Images are re-encoded via Electron `nativeImage` (no extra dependency):
  EXIF is stripped, orientation applied, longest edge capped at 2048px.
  Outside Electron (fallback) the original bytes are kept with JPEG EXIF
  stripped only — PNG/WebP/GIF metadata is retained and no resize applies.
  Text is decoded with UTF-8/UTF-16 BOM handling.
- Images and PDFs are sent to the active provider NATIVELY as its own
  image/document input (original bytes — no OCR, no local text
  extraction). File bytes therefore leave the machine: first use per
  provider shows the tray notice "Sent to <provider> when you press
  Enter" (dismissible per provider). An opt-in Settings fallback
  (`localTextFallback`, default off) re-enables local text extraction for
  provider-unsupported types only, labelled "text extracted locally".
- Attached paths go through the same realpath + allowed/protected policy as
  agent tools: outside-root files need per-file "Allow once", protected or
  symlink-escaping paths are refused ("Remove"). Attachment reads never grant
  permission; writes still need approval with the exact path.
- Attachment content is untrusted data (delimited, system-prompt rule, and
  "Requested after reading \<name\>" on follow-up approvals). Native
  document bytes count too; macros are never run and encrypted files are
  never opened. Tray text shows
  "Attachment text may contain secrets — confirm before sharing."
- Temp files live in `<data>/attachments/<conversationId>` with safe names and are
  deleted on conversation delete/Clear, plus a 7-day orphan sweep. Run logs keep
  name/type/size/SHA256 only — never bytes, never base64. Attachments send on
  the first turn only; a temp file deleted before sending becomes an
  "attachment no longer available" note while the rest sends normally.

## Ask-mode read-only guarantee

- Ask runs the same agent loop with only `askSafe` read tools; the model never
  sees write tools. A dispatcher guard blocks any other call with
  `MODE_READ_ONLY` (covers hallucinated or injected names) and logs it.
- Read implementations cannot write: no shell, no write syscalls, no
  temp-file side effects outside the app cache. No approval card ever appears
  in Ask; reads inside allowed roots auto-run under the same roots /
  protected-path / symlink / traversal / size-cap rules as Do.
- Main exfiltration shape ("read, then send elsewhere") is gated: web calls
  right after a file read wait for the user's explicit confirmation, and file
  contents never enter search queries or fetch URLs unless explicitly asked.
  File text read in Ask goes to the selected provider (one-time notice on
  remote providers); secrets are redacted before the model and never logged.
  Run logs record mode, tool name/path/size (no contents), blocks and
  redactions. Ask never enters the undo journal.

## Tasks (no unattended risky actions)

- Nothing auto-approves: every risky call parks its task in `waiting_approval`
  (no timeout) and waits for the user's card in that task's own view, a footer
  chip, and a notification naming the tool + exact action (never file contents).
  Hidden-window tasks follow the same rules.
- Agents can only create subtasks via parent-bound `subtask_*` tools (Do only,
  risk write, never visible in Ask). Forged cross-parent or user-level calls
  are rejected; subtasks inherit roots/rules, never more; prompts are
  sanitized, capped, and secrets-scanned; untrusted content arrives as data,
  never instructions.
- Write locks serialize same-path writers across all tasks; approvals,
  lock waits (paths only), and terminal states land in per-task run logs.
  Notifications carry titles, never contents. See `docs/tasks.md`.

## Reporting a vulnerability

Report via GitHub private security advisory. Do not open a public GitHub Issue.
Do not include keys, tokens, or personal data in reports.
