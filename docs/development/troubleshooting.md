# Troubleshooting

- Hotkey taken: change `hotkey` in settings.
- Window hides on blur by design; click tray to reshow.
- 401 → wrong key; 429 → rate limit; 60 s timeout; model error → name.
- No icon: `assets/icon.svg` is a placeholder, replace with PNG.

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

## SQLite / Electron blocker (known limitation)

`src/main/db/sqlite.ts` loads `node:sqlite` via
`process.getBuiltinModule`, which requires Node 22.5+.
Electron 33.4.11 bundles Node 20.18.x, so the **packaged app fails
to open SQLite**. Dev and tests on Node >= 22.5 work. Documented;
not fixed — upgrading Electron is a separate decision.
