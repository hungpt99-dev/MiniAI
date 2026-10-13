# Configuration

Settings live in the app SQLite DB (`getSettings`/`updateSettings` in
`src/main/store/settings.ts`). Stored `agent`/`chat` mode values keep working.

| Key | Default | Notes |
|---|---|---|
| `hotkey` | `Alt+Space` | Toggle. Electron syntax; shown as `⌥Space` on macOS. |
| `modeHotkey` | `Alt+M` | Cycle Do/Ask. |
| `agentStopHotkey` | `Ctrl+Alt+Esc` | Stop; `⌃⌥Esc` on macOS. |
| `launchAtLogin` | `false` | `app.setLoginItemSettings`, both OSes. Off by default. |
| `agentAllowedRoots` | `[]` | Extra readable roots (home/Desktop/Documents/Downloads implied). |
| `agentAlwaysAllow` | `[]` | Scoped always-allow rules, revocable. |
| `requireApprovalForWrites` | `true` | Cannot disable approval for `shell_run`. |
| `agentMaxCalls` | `25` | 1–100 tool calls per run. |
| `suggestions` | 4 builtins | Up to 8 starter-suggestion lines. |
| `onboarded` | `false` | First-run onboarding flag. |

Provider keys live in the OS store (DPAPI/Keychain) via `safeStorage`, never
in settings. `${PROVIDER}_API_KEY` env fallback is dev-only.
