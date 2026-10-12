# Troubleshooting

- Hotkey taken: change `hotkey` in settings.
- Window hides on blur by design; click tray to reshow.
- 401 → wrong key; 429 → rate limit; 60 s timeout; model error → name.
- No icon: `assets/icon.svg` is a placeholder, replace with PNG.

## SQLite / Electron blocker (known limitation)

`src/main/db/sqlite.ts` loads `node:sqlite` via
`process.getBuiltinModule`, which requires Node 22.5+.
Electron 33.4.11 bundles Node 20.18.x, so the **packaged app fails
to open SQLite**. Dev and tests on Node >= 22.5 work. Documented;
not fixed — upgrading Electron is a separate decision.
