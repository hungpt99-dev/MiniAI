# MiniAI

Popup AI assistant (BYOK). Alt+Space toggles a frameless 480×640 window. Tray icon, slash commands, prompt templates, 2-step workflows, SQLite history.

## Setup

```powershell
npm install
npm run build:main
npm run build:renderer
npm run dev        # runs Electron
npm run dist       # electron-builder portable + NSIS (win x64)
```

## BYOK

Settings panel → provider → paste API key. Stored via `safeStorage` (DPAPI on Windows) in SQLite `secrets` table. Keys never logged — `redact()` masks `sk-…`, `Bearer …`, `api_key=…`.

Providers: OpenAI, Anthropic, Gemini (OpenAI-compatible endpoint), Custom compatible (e.g. Ollama `http://localhost:11434/v1`). `Test` button pings the chat endpoint.

Env fallback for dev: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc.

## Commands

| Command | Action |
|---|---|
| `/help` | list commands |
| `/new` | new conversation |
| `/clear` | clear view |
| `/model <name>` | get/set model |
| `/history` | history panel |
| `/translate /rewrite /summarize /explain /analyze /reply` | prompt templates (`{{var}}` filled from trailing text) |
| `/email-reply /requirement-review` | workflows |

Slash palette: type `/`, filter exact › prefix › substring › fuzzy, ↑↓ navigate, Enter select, Esc close, click selects.

## Workflows

Steps: `prompt` (templateId + inputVar/outputVar) → `transform` (append/prepend/replace/upper/lower) → `conditional` (contains → then/else) → `user-input` → `output` (must be last). Max 20 steps, conditional depth ≤ 2. Engine returns `{ok|failed|aborted}` with per-step history; abort via Esc/cancel.

## Data location

`%APPDATA%\MiniAI\miniai.db` (WAL mode). Tables: meta (schema_version=1), conversations, messages, templates, workflows, runs, secrets, settings. Override with `MINIAI_DATA_DIR`.

## Troubleshooting

- Hotkey taken: change `hotkey` in settings (letters/digits joined by `+`).
- Window hides on blur by design (launcher behavior); click tray to reshow.
- 401 → wrong key; 429 → rate limit; timeout 60 s; model error → check model name.
- No icon? `assets/icon.svg` placeholder — replace with PNG for tray/installer.

## Tests

```powershell
npx vitest run
```

Unit: slash, providers (fake SSE, no network), workflow, settings, db, secrets-redaction.

## Requirements

- Windows x64.
- Node >= 22.5 for tests (`node:sqlite` via `process.getBuiltinModule`).

## Known limitation

Electron 33.4.11 bundles Node 20.18.x, but `node:sqlite`
(`src/main/db/sqlite.ts`) requires Node 22.5+. The packaged app
therefore fails to open SQLite. Dev and tests on Node >= 22.5 work.
Documented as-is; upgrading Electron is a separate decision.
