# Shortcuts

Key caps render per OS from one helper (`keyLabel` in `src/main/platform/`;
footer hints use the same mapping).

| Action | Windows | macOS |
|---|---|---|
| Toggle Nexio | `Alt+Space` | `⌥Space` (Option+Space) |
| Stop run | `Ctrl+Alt+Esc` | `⌃⌥Esc` (Ctrl+Option+Esc) |
| Switch Do/Ask | `Tab` | `Tab` |
| Send | `Enter` | `Enter` |
| New line | `Shift+Enter` | `Shift+Enter` |
| Stop / close | `Esc` | `Esc` |
| Settings | (footer button) | `Cmd+,` |
| Quit | (tray menu) | `Cmd+Q` |
| Copy / Paste / Select all | `Ctrl+C` / `Ctrl+V` / `Ctrl+A` | `Cmd+C` / `Cmd+V` / `Cmd+A` |

Notes:

- Do NOT use `Cmd+Space` (Spotlight) or `Cmd+Option+Esc` (Force Quit) on macOS.
- `Option+Space` is also claimed by other launchers/AI apps; if Nexio reports
  a conflict, pick another hotkey in Settings.
- Typing respects IME composition (`isComposing`) identically on both OSes.
