# Troubleshooting

- Hotkey taken: change `hotkey` in settings.
- Window hides on blur by design; click tray to reshow.
- 401 → wrong key; 429 → rate limit; 60 s timeout; model error → name.
- Missing icons: run `npm run assets`, then `npm run assets:check`.

## Rejected file

A rejection names the exact reason plus a **Details** toggle
(`detected <kind> (<evidence>), rule <rule>`):

| Message | Meaning | Action |
|---|---|---|
| `Not attached: X is an executable (…)` | PE/ELF/Mach-O, installer, shortcut or code package, by content | rename check won't help — the bytes are the verdict |
| `Not attached: X is empty.` | 0 bytes | attach a non-empty file |
| `Attachment refused: …` | path policy (outside roots, protected, symlink escape) | Allow once / add the folder / Remove |
| `Attachment too large …` | over 20MB/file or 50MB total | compress or split |

Valid Office files (docx/xlsx/pptx/…) are accepted: text is extracted
when possible, otherwise the chip reads "Reference only". A corrupt file
is kept as reference, never crashes. Password-protected files say
"Encrypted. Contents not readable." Details: `docs/attachments.md`.

## Providers

Settings → Test reports the normalized kind + action. Common cases:

| Message kind | Meaning | Action |
|---|---|---|
| `auth` | key rejected | re-enter the API key |
| `model_not_found` | bad model name | pick from the model suggestions (`listModels`) |
| `unsupported_parameter` | server rejected a param | auto-fix retried once; still failing → Reset fixes |
| `context_too_long` | conversation exceeds the model | new chat or shorten |
| `rate_limited` / `quota_exceeded` / `overloaded` | throttled or billing | wait, then retry |
| `network` | unreachable base URL (Custom) | check server running + base URL |

Full kind table, recovery rules, and per-provider notes: `docs/providers.md`.

## macOS

- Hotkey conflict: `Option+Space` is also used by other launchers/AI apps.
  If Nexio reports the hotkey is taken, enter another one in Settings.
- "Nexio can't access Documents" (or Desktop/Downloads): allow Nexio in
  System Settings > Privacy & Security > Files and Folders (Settings has an
  Open Privacy Settings button). A "Don't Allow" stays until you change it there.
- Unsigned app warning: Gatekeeper blocks unsigned dev builds on first
  launch; right-click → Open, or sign + notarize (see `docs/release.md`).
- MCP servers missing tools (`node`, `npx`, `brew` not found): Nexio builds
  child env from your login shell, but only zsh/bash login shells are read.
  Launching from a terminal once also refreshes the cached env.

## SQLite runtime requirement (resolved)

`src/main/db/sqlite.ts` loads `node:sqlite` via
`process.getBuiltinModule`, which requires Node 22.5+.
Electron 37 bundles Node 22.21.x, so the **packaged app opens SQLite
fine** (verified: Windows portable launches, exit 0, no DB errors).
Dev and tests on Node >= 22.5 work. The old Electron 33 / Node 20
blocker is gone with the Electron 37 upgrade.
