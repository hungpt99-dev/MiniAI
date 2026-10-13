# Nexio

A new way to interact with your computer.

Nexio is the smart layer between you and your computer. Press a hotkey, say what
you want, and AI finds, opens, organizes and does it. Risky actions need your approval.

Say what you want. Nexio does it on your computer.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows x64](https://img.shields.io/badge/Platform-Windows_x64-lightgrey.svg)](docs/development/setup.md)
[![Platform: macOS 13+](https://img.shields.io/badge/Platform-macOS_13+-lightgrey.svg)](docs/platforms.md)
[![Status: v0.1.0 pre-release experimental](https://img.shields.io/badge/Status-v0.1.0_pre--release_experimental-orange.svg)](docs/product/implementation-status.md)

[Why Nexio](#why-nexio) · [Features](#features) · [When to use it](#when-to-use-it) · [Quick Start](#quick-start) · [Build / Dev](#build--dev) · [Status](#status) · [Contributing](#contributing) · [License](#license) · [Docs](docs/README.md)

## Why Nexio

Most AI tools live in a browser tab. Nexio lives on a hotkey.

Press `Alt+Space`, say what you want done, dismiss. Nexio finds files, opens apps,
and organizes things for you. Risky actions pause for your approval, every action is
shown exactly before it runs, every run is written to a log, and deletes go to the
Recycle Bin so they can be undone. Bring your own keys, keep history in a local SQLite file.

## Features

**Instant access**

- Global `Alt+Space` (default, configurable) toggles a frameless `480x640` popup.
- Popup hides on blur (launcher behavior). Tray has Show / Hide + Quit.
- Single-instance app. Mode toggle with `Tab` in the composer or `Alt+M`.
- Opens in Do mode by default. Do acts on your computer (find, open, organize, run);
  Ask answers plain questions. When you have not picked a mode, Nexio routes
  automatically (heuristic first, one cheap model call when uncertain) and shows
  `Doing` / `Answering` in the footer. An explicit mode pick always wins.

**Ask mode (BYOK answers)**

- Providers: `openai` (default model `gpt-4o-mini`), `anthropic`, `gemini`, `compatible` (default `http://localhost:11434/v1`, e.g. Ollama).
- Keys are entered in the settings panel and stored via `safeStorage` / DPAPI in the SQLite `secrets` table. Fallback XOR obfuscation warns only (dev).
- `redact()` masks `sk-` / `Bearer` / `api_key` before logging. Dev-only env fallback: `OPENAI_API_KEY`, etc.
- Answers stream with cancel. Provider usage may incur charges.
- Attachments: paste (`Ctrl+V`/`Cmd+V`), drag-drop ("Drop to attach"), or the
  paperclip button stages images/files in a tray under the composer.
  `Enter` with attachments alone sends "Describe the attached file(s)."
  Types are sniffed by magic bytes (max 5, 20MB/file, 50MB total); images are
  EXIF-stripped and capped at 2048px via Electron `nativeImage`, text is
  BOM-decoded and truncated at 200KB. Temp files live under
  `<data>/attachments/<run>` and are deleted on run delete/Clear or swept
  after 7 days. Non-vision models get a notice with a one-click
  "Switch model" (image bytes are never sent); logs keep name/type/size/SHA256
  only. Details: `docs/providers.md` (vision), `docs/configuration.md`
  (`compatibleImages`), `SECURITY.md`.

**Slash commands and prompt templates**

- Builtins: `/help` `/new` `/clear` `/model` (Ask-only) `/history` `/settings` `/log` `/extensions`.
- Templates: `/translate` `/rewrite` `/summarize` `/explain` `/analyze` `/reply`.
- Workflows: `/email-reply` `/requirement-review`.
- Palette: type `/`, ranked exact > prefix > substring > fuzzy. Arrows + `Enter` + `Esc` + click. Unknown commands show top-3 suggestions.
- Scopes (`Ask` / `Do` / `all`) follow the active mode.

See [docs/agents/README.md](docs/agents/README.md).

**Small multi-step workflows**

- 5 step kinds: `prompt` / `transform` / `conditional` / `user-input` / `output`.
- Transforms: `append` / `prepend` / `replace` / `uppercase` / `lowercase`.
- Limits: max 20 steps, conditional depth <= 2, last step must be `output`.
- Per-step history; cancel via cancel action (Esc closes popup, may strand run).

See [docs/agents/workflows.md](docs/agents/workflows.md).

**Local history**

- Stored in `%APPDATA%\Nexio\nexio.db` (WAL mode). Override with `NEXIO_DATA_DIR`.
- Note: message text is sent to the configured provider on each request.
- History has two tabs: Run Log (prompt, one-line outcome, timestamp, status, Undo
  where supported) and Ask (existing chat transcripts; nothing is discarded).

**Undo journal**

- Reversible operations (`fs_move`, `fs_copy`, new-file `fs_write`, `clipboard_write`)
  are journaled per run; `fs_trash` notes manual Recycle Bin restore.
- Undo reverses in reverse order, verifies preconditions, never overwrites changed
  files, goes through the normal approval flow, and cannot run twice on the same
  operations. `shell_run` and MCP tools are never presented as undoable.

**First-run onboarding**

- New installs get a skippable 3-step flow: AI provider + key, allowed folders
  (Desktop, Documents, Downloads suggested), then example prompts. Existing
  installations skip it automatically.

**Do mode (built-in computer-use)**

- Do mode runs a built-in tool-calling loop in the main process on top of your configured chat provider — no external agent CLI. The model plans, calls file/clipboard/app/shell tools, you approve risky actions, everything is logged and stoppable (`Ctrl+Alt+Esc`).
- Approval policy: reads auto-run inside allowed folders, writes need approval, shell commands need approval every time. Trash-only deletes, secrets redacted, `/log` opens the latest run log.

See [docs/architecture/local-agent.md](docs/architecture/local-agent.md).

**Extensions (skills, MCP, hooks, workflows)**

- Install and manage Agent-Skills-compatible skills, MCP servers (official SDK, stdio + Streamable HTTP/SSE), event hooks, and reusable workflows from `/extensions` or the 🧩 footer button. Everything installs OFF until reviewed; skills load progressively, MCP tools join the same registry as `mcp__server__tool`, hooks can only make permissions stricter, and workflows run through the same approval layer. Ships with 2 example skills + 2 example workflows (disabled).

See [docs/architecture/extensions.md](docs/architecture/extensions.md).

**Do mode (built-in only, no external runtimes)**

- Do mode runs only the built-in tool-calling loop in the main process — no
  external agent CLI, no runtime picker. Old `agentRuntime` / `agentBackend` /
  `engine` settings fall back to built-in and are purged on read.

## When to use it

- Quick AI answers without leaving the current window (`Alt+Space`, ask, dismiss).
- Repeated rewrites: summarize, translate, or explain with one slash command.
- Repeatable two-path tasks via `/email-reply` or `/requirement-review`.
- Local-first draft history with your own provider keys and models.

## Quick Start

No releases exist. Run from source.

Prerequisites: Node >= 22.5, Windows 10/11 x64 or macOS 13+ (Apple Silicon or Intel).

```powershell
git clone https://github.com/<owner>/nexio.git  # placeholder URL; the repo has not been renamed
cd nexio
npm ci
npm run dev
```

1. Press `Alt+Space`.
2. Open settings, pick a provider, paste your key.
3. Try: `/summarize paste text here`.

If the hotkey is taken, change `hotkey` in settings. If the window disappears on focus loss, that is by design — reopen it from the tray. See [docs/development/troubleshooting.md](docs/development/troubleshooting.md).

## Build / Dev

Commands from `package.json`:

```powershell
npm run build:main      # compile Electron main (tsc)
npm run build:renderer  # copy renderer assets
npm run build             # build main + renderer
npm run dev             # build + run Electron
npx vitest run          # tests (npm test runs vitest run)
npm test                # tests (vitest run)
npm run typecheck       # typecheck main (tsc --noEmit)
npm run dist            # build + electron-builder --win portable
```

Setup details: [docs/development/setup.md](docs/development/setup.md). Testing details: [docs/development/testing.md](docs/development/testing.md). Architecture: [docs/architecture/overview.md](docs/architecture/overview.md).

## Status

v0.1.0 pre-release / experimental.

**Working:** popup / hotkey / tray, Ask + streaming + cancel, slash + templates, workflows, history, `Tab` switching, router, built-in Do loop.

**Planned:** installer release, PNG icon.

**Known issues:**

- Packaged app fails to open SQLite: Electron 33 bundles Node 20.18.x, but `node:sqlite` needs 22.5+. Dev and tests on Node >= 22.5 work.
- Tray icon missing until PNG ships (`assets/icon.svg` is a placeholder).

**Screenshots wanted:** no screenshots exist yet (`assets/` has only the `icon.svg` placeholder). Contributions welcome for: popup, slash palette, workflow run.

Details: [docs/product/implementation-status.md](docs/product/implementation-status.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Start with [docs/](docs/README.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
