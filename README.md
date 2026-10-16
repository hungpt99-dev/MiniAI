# Nexio — press a hotkey, say what you want, it's done.

<p align="center">
  <img src="assets/banner.svg" width="100%" alt="Nexio — a new way to interact with your computer." />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="docs/platforms.md"><img src="https://img.shields.io/badge/Platform-Windows_10%2F11-lightgrey.svg" alt="Platform: Windows 10/11" /></a>
  <a href="docs/platforms.md"><img src="https://img.shields.io/badge/Platform-macOS_13+-lightgrey.svg" alt="Platform: macOS 13+" /></a>
  <a href="docs/product/implementation-status.md"><img src="https://img.shields.io/badge/Status-v0.1.0_pre--release-orange.svg" alt="Status: v0.1.0 pre-release" /></a>
</p>

Nexio is a popup AI assistant that lives on a global hotkey and acts on your computer.
Press `Alt+Space`, type what you want, dismiss — it finds files, answers questions,
organizes folders, and runs multi-step tasks with your approval.

[See it in action](#see-it-in-action) · [Try it](#try-it) · [Why Nexio](#why-nexio) · [Features](#feature-highlights) · [Trust and safety](#trust-and-safety) · [Shortcuts](#keyboard-shortcuts) · [Slash commands](#slash-commands) · [Install](#install-and-quick-start) · [Status](#honest-status) · [Docs](docs/README.md)

## See it in action

![Nexio demo](docs/media/demo.gif)
*15-second demo: hotkey, Ask a question, Do a file task with an approval card. (TODO: record.)*

| Popup | Slash palette | Approval card |
|---|---|---|
| ![Popup](docs/media/popup.png) | ![Slash palette](docs/media/slash-palette.png) | ![Approval card](docs/media/approval-card.png) |

| Run log with Undo | Parallel tasks | Memory |
|---|---|---|
| ![Run log](docs/media/run-log-undo.png) | ![Parallel tasks](docs/media/parallel-tasks.png) | ![Memory](docs/media/memory.png) |

Screenshots are placeholders until captured — contributions welcome. Capture list (all at 2x, dark OS theme, no keys visible):

- [ ] `docs/media/demo.gif` — Alt+Space, ask a question, then a Do task with one approval (~15 s)
- [ ] `docs/media/popup.png` — empty popup over a file manager (640px width)
- [ ] `docs/media/slash-palette.png` — composer with `/` open, mixed prompt/workflow/skill entries
- [ ] `docs/media/approval-card.png` — a write/shell approval showing the exact action
- [ ] `docs/media/run-log-undo.png` — run log with a completed run and an Undo row
- [ ] `docs/media/parallel-tasks.png` — Tasks view with one running + one queued task
- [ ] `docs/media/memory.png` — Memory view with kinds tabs and one pinned row

Brand art already ships in `assets/` (icon, banner, social preview). GitHub social preview is a manual upload of `assets/social-preview.png` (1280x640).

## Try it

Copy-paste any of these into the popup. Ask reads and answers; Do acts and asks first when it matters.

| Prompt | What happens | Approval |
|---|---|---|
| `Find files I changed today in Documents` | Ask searches and lists matches, no changes | None (reads auto-run in allowed folders) |
| `Organize my Downloads by file type` | Do moves files into type folders | Writes need approval, Undo supported |
| `What's using my disk space?` | Do inspects and reports the biggest folders | Shell commands always need approval, never undoable |
| Attach `report.pdf`, then `Summarize this PDF` | PDF goes to a document-capable provider natively, summary streams back | None for the read; file bytes are sent to the provider |
| `/email-reply paste the thread, polite decline` | Workflow drafts a reply from the pasted text | None (text transform, no file writes) |
| `/spawn rename all screenshots in Pictures with dates` | Runs as a background parallel task | Writes/shell need approval in the task's own card |
| `/remember my project folder is D:\work\acme` | Saves a long-term memory (memory must be on) | Explicit save, with Undo/Edit row |

Provider usage may incur charges. File bytes and message text are sent to the configured provider on each request.

## Why Nexio

- Lives on a hotkey: `Alt+Space` in, answer or action out, `Esc` gone — no browser tab, no window hunt.
- Does things, not just chats: Ask answers read-only, Do moves files, edits, runs shell, and organizes.
- You stay in control: every write and every shell command shows its exact action and waits for you — no skip, no timeout.
- Your keys, your disk: bring-your-own provider keys in the OS keychain, history and memory in a local SQLite file.
- Works with local models: point the Custom provider at Ollama (`http://localhost:11434/v1`) and keep it on this machine.

## Feature highlights

### Ask vs Do, with an auto-router
Ask answers questions read-only (8 tool calls / 60 s cap, no approval cards ever). Do plans and acts with file, clipboard, app, shell, and attachment tools. Undecided? The router picks: heuristics first, one cheap model call when uncertain, footer shows `Doing` / `Answering`. `Tab` or `Alt+M` switches explicitly; attachments skip clarification.

### Approvals and Undo
Write and destructive tools park in `waiting_approval` with the exact action shown — hooks can only block or force approval, never grant it. Reversible ops (`fs_move`, `fs_copy`, new-file `fs_write`, `clipboard_write`) journal per run and undo in reverse order with precondition checks. Deletes use the Recycle Bin (restore manually); shell and MCP tools are never undoable.

### Slash commands and workflows
18 builtins plus prompt templates (`/translate /rewrite /summarize /explain /analyze /reply`), two-step workflows (`/email-reply`, `/requirement-review`), and commands contributed by skills and MCP servers. Palette ranks exact > prefix > substring > fuzzy; unknown triggers suggest the top 3.

### Extensions: skills, MCP, hooks
Agent-Skills-compatible skills (progressive loading, own-folder reads), MCP servers over stdio plus Streamable HTTP/SSE (bridged as `mcp__server__tool`), event hooks (block or force-approval only), and reusable JSON workflows — all installed OFF until reviewed, with tamper re-checks that disable changed extensions.

### Memory and incognito
Off by default. Opt-in kinds (preferences, facts, folder rules, procedures, expiring episodes) in local SQLite FTS5, ≤8 items / ~1,200 tokens per run as a `<user_memory>` block, user-approved never-touch rules enforced as paths. `/memory /remember /forget`, one-tap save rows, Memory view. `/incognito` keeps no history and touches no memory. Untrusted content (files, web, attachments, MCP) can never write memories; secrets never save.

### Parallel tasks and queue
`Enter` while busy spawns a parallel task, `Ctrl/Cmd+Enter` queues ("do this later"), `/spawn /queue /tasks /cancel /clear-queue`, plus a Tasks view with locks, per-task approvals, watchdog, notifications, and family undo. Agents can split work into capped parent-bound `subtask_*` children. Ask never queues.

### Attachments
Paste (`Ctrl/Cmd+V`), drag-drop ("Drop to attach"), or the paperclip picker. Magic-byte typing (renamed executables still rejected), 5 files / 20 MB each / 50 MB total / 200 KB text cap, EXIF-stripped images capped at 2048px. Images and PDFs go to the provider natively; Office types need the opt-in `localTextFallback`. Outside-root files need per-file Allow once. History shows 160px thumbs with a Delete attachments menu.

### Providers, including local Ollama
Four providers: `openai` (default `gpt-4o-mini`), `anthropic`, `gemini`, `compatible` (default `http://localhost:11434/v1`, e.g. Ollama). Per-provider adapters with streaming, one-shot parameter recovery, bounded retries, and normalized errors. Settings Test button probes unsaved values (listModels, tiny completion, tool probe, 15 s cap); model names can be typed freehand.

### Keyboard-first
Every core action has a key: toggle, mode switch, send, queue, stop, pin, palette navigation, approval allow/deny, task reorder. Key caps render per OS (`Alt` vs `⌥`, `Ctrl` vs `⌘`). Full table below.

## Trust and safety

- Reads auto-run only inside your allowed folders; protected system paths stay refused (exact Settings pane named on macOS TCC denials).
- Every write and every shell command needs your approval, shown exactly before it runs — approvals cannot be skipped, timed out, or granted by hooks/extensions.
- Every run is logged (redacted JSONL + run history); secrets are masked before logging.
- Deletes go to the Recycle Bin, never permanent delete; Undo reverses supported ops without overwriting changed files.
- Kill switch `Ctrl+Alt+Esc` (configurable) stops all runs; `Esc` walks back: menu, deny, stop, clear, close.
- Keys live in Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) in a versioned envelope; dev-only `${PROVIDER}_API_KEY` env fallback; unreadable keys ask for re-entry, never crash a run.
- Memory is off by default, encrypted when a backend exists, ids-only in logs; untrusted content can't write it.
- Extensions install OFF, re-disable on capability growth or tamper; MCP secrets move to the OS store.
- No telemetry; network goes only to configured providers. UI in English + Vietnamese, no-restart switch.

Read [SECURITY.md](SECURITY.md) before connecting providers or enabling extensions.

## Keyboard shortcuts

Configurable: `hotkey` (default `Alt+Space`), `agentStopHotkey` (default `Ctrl+Alt+Esc`). macOS uses `⌥Space` and `⌃⌥Esc` — never `Cmd+Space` (Spotlight) or `Cmd+Option+Esc` (Force Quit).

| Action | Windows | macOS |
|---|---|---|
| Toggle Nexio | `Alt+Space` | `⌥Space` |
| Stop all runs | `Ctrl+Alt+Esc` | `⌃⌥Esc` |
| Switch Ask / Do | `Tab`, `Alt+M`, `Alt+1` / `Alt+2` | same |
| Send | `Enter` | `Enter` |
| Queue task | `Ctrl+Enter` | `Cmd+Enter` |
| New line | `Shift+Enter` | `Shift+Enter` |
| Pin window | `Alt+P` | `Alt+P` |
| Approval: allow once / deny | `Enter` / `Esc` | `Enter` / `Esc` |
| Reorder queued task (Tasks view) | `Alt+Up` / `Alt+Down` | same |
| Stop / close (chain) | `Esc` | `Esc` |
| Settings | footer button | `Cmd+,` |
| Quit | tray menu | `Cmd+Q` |

Details: [docs/shortcuts.md](docs/shortcuts.md).

## Slash commands

Scope follows the active mode: `all` works everywhere, `chat` is Ask-only, `agent` is Do-only. Generated from `src/main/slash/registry.ts` + `src/main/db/templates.ts`.

| Command | Scope | What it does |
|---|---|---|
| `/help` | all | Show available commands |
| `/new` | all | Start a new conversation |
| `/clear` | all | Clear current messages |
| `/model <name>` | Ask | Switch model, or show current |
| `/history` | all | Show conversation history |
| `/settings` | all | Open settings |
| `/log` | all | Open the latest agent run log |
| `/extensions` | all | Manage skills, MCP servers, hooks, workflows |
| `/memory` | all | View and edit what Nexio remembers |
| `/remember <text>` | all | Remember this (memory must be on) |
| `/forget <text>` | all | Forget a memory |
| `/incognito` | all | Toggle incognito (no history, no memory) |
| `/spawn <text>` | Do | Run as a separate parallel task |
| `/queue <text>` | Do | Add to the task queue |
| `/tasks` | all | Open the Tasks view |
| `/pin` | all | Keep the window open (`Alt+P`) |
| `/cancel <n>` | all | Cancel a task |
| `/clear-queue` | all | Clear the waiting queue (asks first) |
| `/translate /rewrite /summarize /explain /analyze /reply` | all | Prompt templates rendering `{{text}}` before sending |
| `/email-reply` | Do | Workflow: paste text → `/reply` draft → output |
| `/requirement-review` | Do | Workflow: paste text → `/analyze` review → output |
| `/<skill-name>`, `/mcp-<server>-<prompt>` | varies | Commands contributed by enabled skills / MCP servers |

Workflows run in Do mode (Ask shows a switch chip). Details: [docs/agents/README.md](docs/agents/README.md), [docs/agents/workflows.md](docs/agents/workflows.md).

## Install and Quick start

No releases yet — run from source. Windows 10/11 x64 or macOS 13+ (Apple Silicon or Intel), Node >= 22.5.

```powershell
git clone https://github.com/hungpt99-dev/Nexio.git
cd Nexio
npm ci
npm run dev
```

1. Press `Alt+Space` (`⌥Space` on macOS; change `hotkey` in Settings if taken).
2. Open Settings, pick a provider, paste your key (stored in the OS keychain), Test, Save.
3. Try: `Find files I changed today in Documents` — or `/summarize paste text here`.

Local model: provider Custom (`compatible`), base `http://localhost:11434/v1`, Test, then chat. If the popup hides on blur, that is by design — reopen from the tray, or pin with `Alt+P`. See [docs/development/troubleshooting.md](docs/development/troubleshooting.md).

Packaging: `npm run dist` builds the Windows installer + `Nexio-portable.exe` and (on a Mac) universal dmg+zip; builds are unsigned without owner credentials (see [docs/release.md](docs/release.md)). The Windows portable build was verified locally; there are no downloadable releases yet.

## Honest status

v0.1.0 pre-release / experimental. What works today: popup / hotkey / tray / pin, Ask + streaming + cancel, auto-router, slash + templates, workflows, local history, `Tab` switching, built-in Do loop with approvals + run log + Undo, Recycle Bin deletes, kill switch, attachments pipeline, long-term memory + incognito, parallel tasks + subtasks, skills / MCP / hooks (install OFF), onboarding, EN + VI UI with 15-locale intent packs.

Experimental or partial: semantic memory search (setting exists, retrieval stays FTS until an embeddings backend is wired); project memory scopes (type exists, no project ids flow yet); Office-doc understanding without `localTextFallback` (provider-native images/PDFs only); Anthropic model listing (no list endpoint — type the model name).

Known issues: full `vitest` suite is red on `master` (stale CSS assertions plus `node:sqlite` needing Node >= 22.5 outside the packaged app); macOS `icon.icns` only builds on macOS (`npm run assets` needs `iconutil`); Linux is not supported (Windows + macOS only); unsigned builds show OS warnings.

Details: [docs/product/implementation-status.md](docs/product/implementation-status.md).

## Documentation

| Goal | Start here |
|---|---|
| Install and set up dev | [Setup](docs/development/setup.md) · [Testing](docs/development/testing.md) |
| Configure providers and keys | [Providers](docs/providers.md) · [Configuration](docs/configuration.md) |
| Slash commands and workflows | [Agents](docs/agents/README.md) · [Workflows](docs/agents/workflows.md) |
| Do loop, tools, approvals | [Local agent](docs/architecture/local-agent.md) |
| Tasks (spawn/queue/subtasks) | [Tasks](docs/tasks.md) |
| Skills, MCP, hooks | [Extensions](docs/architecture/extensions.md) |
| Popup, hotkey, platforms | [Shortcuts](docs/shortcuts.md) · [Design](docs/design.md) · [Platforms](docs/platforms.md) |
| Languages and localization | [i18n](docs/i18n.md) |
| Troubleshoot or check status | [Troubleshooting](docs/development/troubleshooting.md) · [Status](docs/product/implementation-status.md) |
| Architecture overview | [Overview](docs/architecture/overview.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md), and [ACCESSIBILITY.md](ACCESSIBILITY.md). Start with [docs/](docs/README.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
