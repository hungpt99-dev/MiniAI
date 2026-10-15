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
| `askReadEnabled` | `true` | Ask mode may read files and the system (read-only). `false` returns Ask to plain chat with no tools. |
| `askMcpTools` | `[]` | MCP full tool names (`mcp__server__tool`) allowed in Ask. Each also needs a trusted server and a read-only tool; default off. |
| `askReadNoticeDismissed` | `{}` | Per-provider first-use Ask read notice (remote providers only). |
| `memoryEnabled` | `false` | Master switch for long-term memory (Settings > Memory). |
| `memoryKinds` | all `true` | Per-kind opt-ins: preference, fact, folder_rule, procedure, episode. |
| `memorySuggest` | `false` | Suggest memories after runs (user messages only, one cheap call). |
| `memoryOneTap` | `true` | One-tap save rows for identity/preference statements (needs master on to store). |
| `memorySemantic` | `false` | Reserved: retrieval stays FTS keyword search until embeddings are wired. |
| `memoryUseInAsk` | `true` | Retrieve memory in Ask mode (read-only). |
| `memoryMaxItems` | `500` | 10–5000 stored memories; full asks for cleanup, never drops. |
| `memoryEpisodeDays` | `30` | Episode expiry, 1–365 days. |
| `memoryStaleDays` | `180` | Unused non-pinned items marked stale for review, 7–3650 days. |
| `memoryDismissed` | `[]` | Dismissed suggestion hashes (never proposed again). |
| `memoryNoticeDismissed` | `{}` | Per-provider memory privacy notice. |
| `memoryRuleApprovals` | `{}` | Approved `.nexio/rules.md` never-touch lines (path → hash). |
| `incognito` | `false` | No history, no memory reads/writes, minimal run log (`/incognito`). |
| `agentMaxCalls` | `25` | 1–100 tool calls per run. |
| `taskMaxParallel` | `2` | 1–4 running tasks at once (incl. subtasks). |
| `taskMaxQueued` | `20` | 1–100 waiting top-level tasks. |
| `taskAllowSubtasks` | `true` | Agents may create subtasks (Do only, capped). |
| `taskAskBeforeSubtasks` | `true` | One confirmation per run before the first `subtask_create`. |
| `taskConfirmOnSubmit` | `true` | Ask where work goes when submitting while a task runs. |
| `taskSubmitDefault` | `'ask'` | Saved while-busy default: `ask` / `spawn` / `queue` / `replace`. |
| `taskResume` | `'ask'` | Waiting tasks on start: `ask` / `resume` / `discard`. |
| `taskNotifications` | `true` | Approval + finished-family notifications. |
| `taskPruneDays` | `30` | Prune terminal tasks/runs older than N days (1–3650). |
| `sendTemperature` | `true` | Custom provider only: send `temperature`. Off for strict local servers. |
| `compatibleImages` | `auto` | Custom provider only: image support `auto` (probe) / `on` / `off`. Off holds images back with the non-vision notice. |
| `localTextFallback` | `false` | Extract Office/doc text locally when the provider can't read it (chip + sent text labelled "text extracted locally"). Off refuses with an unsupported notice. |
| `suggestions` | 4 builtins | Up to 8 starter-suggestion lines. |
| `onboarded` | `false` | First-run onboarding flag. |

Provider keys live in the OS store (DPAPI/Keychain) through the single
`src/main/secrets/` module, never in settings. `${PROVIDER}_API_KEY` env
fallback is dev-only. A key the OS store can no longer decrypt is reported
for re-entry (Settings notice + friendly run error) instead of failing raw;
see `docs/troubleshooting.md`.

Provider request/response code lives in `src/main/ai/providers/<id>/`
(`adapter.ts`, `capabilities.ts`, `errors.ts`); the Test button uses unsaved
panel values. Learned parameter fixes (30-day cache) clear via Settings →
Reset fixes. See `docs/providers.md`.
