# MiniAI — Your AI, One Shortcut Away.

Lightweight Windows desktop assistant for direct AI chat, reusable prompts, workflows, path toward integrated coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows x64](https://img.shields.io/badge/Platform-Windows_x64-lightgrey.svg)](docs/development/setup.md)
[![Status: v0.1.0 pre-release experimental](https://img.shields.io/badge/Status-v0.1.0_pre--release_experimental-orange.svg)](docs/product/implementation-status.md)

[Why MiniAI](#why-miniai) · [Features](#features) · [When to use it](#when-to-use-it) · [Quick Start](#quick-start) · [Build / Dev](#build--dev) · [Status](#status) · [Contributing](#contributing) · [License](#license) · [Docs](docs/README.md)

## Why MiniAI

Most AI tools live in a browser tab. MiniAI lives on a hotkey.

Press `Alt+Space`, type, get an answer, dismiss. No tab-switching, no copy-paste round-trip. Reusable slash prompts and small multi-step workflows handle the repeatable work. Bring your own keys, keep history in a local SQLite file.

## Features

**Instant access**

- Global `Alt+Space` (default, configurable) toggles a frameless `480x640` popup.
- Popup hides on blur (launcher behavior). Tray has Show / Hide + Quit.
- Single-instance app. Mode toggle with `Tab` in the composer or `Alt+M`.

**Bring your own key (BYOK) chat**

- Providers: `openai` (default model `gpt-4o-mini`), `anthropic`, `gemini`, `compatible` (default `http://localhost:11434/v1`, e.g. Ollama).
- Keys are entered in the settings panel and stored via `safeStorage` / DPAPI in the SQLite `secrets` table. Fallback XOR obfuscation warns only (dev).
- `redact()` masks `sk-` / `Bearer` / `api_key` before logging. Dev-only env fallback: `OPENAI_API_KEY`, etc.
- Chat streams with cancel. Provider usage may incur charges.

**Slash commands and prompt templates**

- Builtins: `/help` `/new` `/clear` `/model` (chat-only) `/history` `/settings`.
- Templates: `/translate` `/rewrite` `/summarize` `/explain` `/analyze` `/reply`.
- Workflows: `/email-reply` `/requirement-review`.
- Palette: type `/`, ranked exact > prefix > substring > fuzzy. Arrows + `Enter` + `Esc` + click. Unknown commands show top-3 suggestions.
- Scopes (`chat` / `agent` / `all`) follow the active mode.

See [docs/agents/README.md](docs/agents/README.md).

**Small multi-step workflows**

- 5 step kinds: `prompt` / `transform` / `conditional` / `user-input` / `output`.
- Transforms: `append` / `prepend` / `replace` / `uppercase` / `lowercase`.
- Limits: max 20 steps, conditional depth <= 2, last step must be `output`.
- Per-step history; cancel via cancel action (Esc closes popup, may strand run).

See [docs/agents/workflows.md](docs/agents/workflows.md).

**Local history**

- Stored in `%APPDATA%\MiniAI\miniai.db` (WAL mode). Override with `MINIAI_DATA_DIR`.
- Note: message text is sent to the configured provider on each request.

**Agent Mode (implemented, needs real-runtime verification)**

- Adapters exist for OpenCode (HTTP-SSE) and Claude / Codex (CLI-JSONL). Router never falls back silently. Sessions are tracked per runtime.
- This is implemented but not live-verified: tests are mocked only, no real runtime has been connected. Do not treat it as done.

See [docs/architecture/agent-runtime-adapters.md](docs/architecture/agent-runtime-adapters.md) and [docs/agents/compatibility.md](docs/agents/compatibility.md).

## When to use it

- Quick AI answers without leaving the current window (`Alt+Space`, ask, dismiss).
- Repeated rewrites: summarize, translate, or explain with one slash command.
- Repeatable two-path tasks via `/email-reply` or `/requirement-review`.
- Local-first draft history with your own provider keys and models.

## Quick Start

No releases exist. Run from source.

Prerequisites: Node >= 22.5, Windows x64.

```powershell
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
npm run dev             # build + run Electron
npx vitest run          # tests (npm test runs vitest run)
npm test                # tests (vitest run)
npm run typecheck       # typecheck main (tsc --noEmit)
npm run dist            # build + electron-builder --win portable
```

Setup details: [docs/development/setup.md](docs/development/setup.md). Testing details: [docs/development/testing.md](docs/development/testing.md). Architecture: [docs/architecture/overview.md](docs/architecture/overview.md).

## Status

v0.1.0 pre-release / experimental.

**Working:** popup / hotkey / tray, chat + streaming + cancel, slash + templates, workflows, history, `Tab` switching, router.

**Implemented, needs real-runtime verification:** Agent Mode adapters (OpenCode HTTP-SSE, Claude / Codex CLI-JSONL) versus live runtimes. Mocked tests only, no real runtime connected.

**Planned:** live runtime verification, installer release, PNG icon.

**Known issues:**

- Packaged app fails to open SQLite: Electron 33 bundles Node 20.18.x, but `node:sqlite` needs 22.5+. Dev and tests on Node >= 22.5 work.
- Tray icon missing until PNG ships (`assets/icon.svg` is a placeholder).

**Screenshots wanted:** no screenshots exist yet (`assets/` has only the `icon.svg` placeholder). Contributions welcome for: popup, slash palette, workflow run.

Details: [docs/product/implementation-status.md](docs/product/implementation-status.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Start with [docs/](docs/README.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
