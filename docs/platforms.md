# Supported platforms

Nexio runs on **Windows 10/11** and **macOS 13+** (Apple Silicon and Intel).
Same features, same design, same safety rules on both. Linux is out of scope:
nothing targets it, but nothing intentionally breaks it either.

## One adapter, two implementations

All OS differences live behind one interface: `src/main/platform/`
(`types.ts`, `win32.ts`, `darwin.ts`, chosen at startup). No other file
checks the OS directly. The adapter owns: shell spawn + process-tree kill,
app listing, open/trash, protected roots, hotkey defaults, key-cap labels,
the secrets backend, login-shell env, path normalization, and data/log dirs.

## Windows 10/11

- Shell: PowerShell (`-NoProfile -NonInteractive`), no admin, tree-kill via
  `taskkill /T /F`. `sudo`/`su`/`doas`/`runas` patterns are refused outright.
- Frameless transparent popup, no taskbar entry, tray icon + tooltip.
- Hotkeys: `Alt+Space` toggle, `Ctrl+Alt+Esc` stop (same Electron syntax as macOS).
- Secrets in DPAPI via Electron `safeStorage`.
- Data: `%APPDATA%\Nexio`; existing installs keep working (see below).

## macOS 13+ (arm64 + x64)

- Menu-bar app: no Dock icon, no Cmd+Tab entry (`LSUIElement`, `app.dock.hide()`).
- Panel window floats over fullscreen apps and every Space; positioned on the
  display with the cursor using the work area (menu bar + notch respected).
- Monochrome Template menu-bar icon + standard app menu (Edit items, `Cmd+,`).
- Shell: your login shell when it is zsh/bash, else `/bin/zsh`, non-interactive.
- Child env comes from the login shell so `node`, `npx`, `uvx`, `brew`, `git`
  resolve from Finder launches. `sudo`/`su`/`doas` are refused outright.
- Hotkeys: `Option+Space` toggle, `Ctrl+Option+Esc` stop. Never `Cmd+Space`
  (Spotlight) or `Cmd+Option+Esc` (Force Quit). `Option+Space` is also used by
  other launchers — conflicts are expected; Settings shows a warning with a
  Change-hotkey button when registration fails.
- Secrets in Keychain via Electron `safeStorage`.
- Data: `~/Library/Application Support/Nexio`; logs: the OS logs dir.

## Permissions (macOS TCC)

Desktop, Documents, Downloads, iCloud Drive and removable volumes trigger
system prompts. Denials surface as normal tool errors with the exact
System Settings pane to open (Settings has an Open Privacy Settings button).
Nexio never asks for Full Disk Access, Accessibility, Screen Recording or
Automation by default. AppleScript-style app control stays an optional,
off-by-default tool. See `SECURITY.md`.

## Existing installs

Stored settings, extensions and data keep working: the app reads an existing
data folder in place and never deletes or recreates directories to rename.
