# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Secret handling (how this project stores keys)

- API keys are stored in SQLite via Electron `safeStorage`
  (DPAPI on Windows, Keychain on macOS).
- When `safeStorage` is unavailable, the app falls back to a plain
  XOR-obfuscated local value and logs a `console.warn` (dev only).
  Do not rely on this fallback for real secrets.
- `redact()` masks `sk-…`, `Bearer …`, `api_key=…` before logging.
- Dev-only env fallback: `${PROVIDER}_API_KEY` (e.g. `OPENAI_API_KEY`)
  is read in `ipc.ts`. Never commit `.env` files.
- DB lives at `%APPDATA%/Nexio/nexio.db` (WAL mode),
  `~/Library/Application Support/Nexio` on macOS, or
  `NEXIO_DATA_DIR` override. Back it up carefully — it holds secrets.
- No telemetry found in the codebase; network calls go only to
  configured providers.

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

- File types are sniffed by magic bytes, never the extension; renamed
  executables and unknown binaries are rejected inline (never silent).
- Limits: max 5 files, 20MB per file, 200KB text truncation, 50MB total.
- Images are re-encoded via Electron `nativeImage` (no extra dependency):
  EXIF is stripped, orientation applied, longest edge capped at 2048px.
  Text is decoded with UTF-8/UTF-16 BOM handling.
- Attached paths go through the same realpath + allowed/protected policy as
  agent tools: outside-root files need per-file "Allow once", protected or
  symlink-escaping paths are refused ("Remove"). Attachment reads never grant
  permission; writes still need approval with the exact path.
- Attachment content is untrusted data (delimited, system-prompt rule, and
  "Requested after reading \<name\>" on follow-up approvals). Tray text shows
  "Attachment text may contain secrets — confirm before sharing."
- Temp files live in `<data>/attachments/<runId>` with safe names and are
  deleted on run delete/Clear, plus a 7-day orphan sweep. Run logs keep
  name/type/size/SHA256 only — never bytes. First use shows
  "Attachments stay on this computer … (localhost processing)".

## Reporting a vulnerability

Report via GitHub private security advisory. Do not open a public GitHub Issue.
Do not include keys, tokens, or personal data in reports.
