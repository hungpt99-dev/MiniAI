# Changelog

## Unreleased

- Long-term memory (off by default): preferences, facts, folder rules,
  procedures and auto-expiring episodes in the app SQLite DB (FTS5 search,
  safeStorage encryption when available), retrieved per run (8 items,
  ~1,200 tokens) as a `<user_memory>` block, user-approved "never touch"
  rules enforced as permission paths, explicit "remember …" saves with
  Undo/Edit rows, opt-in suggestion chips from user messages only, Memory
  view + Settings section, `/memory /remember /forget /incognito`, and an
  incognito mode with no history/memory. Untrusted content can never write
  memories (confirmation card after any untrusted read; Ask writes blocked
  except via the confirmation path). See `docs/memory.md` and
  `docs/adr/0006-local-memory.md`. Semantic search stays FTS until an
  embeddings backend is wired.

- Ask mode is now read-only with teeth: the same agent loop runs with only
  `askSafe` read tools (`fs_search fs_read fs_list apps_list clipboard_read
  attachment_list attachment_read skill_load web_search web_fetch`), a dispatcher
  guard blocks forged write calls with `MODE_READ_ONLY`, no approval cards ever
  appear in Ask, limits are 8 calls / 60s, secrets are redacted before the model,
  web calls right after a file read wait for explicit confirmation, and a quiet
  "Switch to Do and run this" chip re-sends the prompt in Do (approvals still
  apply). Settings → Agent gains the Ask-mode toggle (default on) and per-tool
  MCP opt-ins (default off).

- README banner redesign (1280x360): new `design/banner.svg` promoted C2PA-free
  to `assets/banner.svg`; `banner.png` regenerated at 2560x720. PNG text uses
  system fonts (bundled woff2 subsets don't match resvg); SVG is canonical.

- Brand assets (full spec): `design/*.svg` promoted to `assets/` C2PA-free
  (icon 512 `r112`/`stroke42`/`dot26`, social 1280x640);
  `npm run assets` renders icon.png 1024, `assets/icons/` 16–1024, `icon.ico`
  16–256, `icon.icns` (macOS `iconutil`, PNG fallback + note elsewhere),
  banner 2560x640, social 1280x640 (<1MB), docs `icon-128.png`, tray
  16/20/24/32 plus black-only `Nexio-Template` 18/36px; `npm run assets:check`
  verifies dims/format/monochrome/size, `tests/unit/assets.test.ts` fails on
  missing refs; installer wired (`win.ico`, `mac.icns`, `linux` dir, NSIS/DMG
  icons), window `icon.png`, SVG favicon, README banner; CI runs assets first.

- Attachments (full spec): composer tray (paste `Ctrl/Cmd+V`, drag-drop with
  "Drop to attach", paperclip multi-picker through the dialog lock, in-panel
  preview, `Backspace`/live-region a11y); main-side magic-byte typing, 5 /
  20MB / 200KB / 50MB limits with inline rejects, `nativeImage` EXIF strip +
  2048px re-encode, UTF BOM decoding, temp `attachments/<runId>` storage with
  run-delete/Clear/7-day cleanup, per-file Allow once/Remove path checks;
  neutral `text`/`image`/`file_ref` parts with per-adapter vision mapping and
  caps, non-vision notice + one-click switch (bytes never sent), Compatible
  `compatibleImages` Auto/On/Off (default Auto); `attachment_list` /
  `attachment_read` Do-context tools (read-only, untrusted); history 160px
  thumbs/chips + Delete attachments menu; hash-only logs; mocked test suite
  `tests/unit/attachments.test.ts` (30 tests, no keys).

- Provider robustness overhaul: per-provider adapters
  (`src/main/ai/providers/<id>/{adapter,capabilities,errors}.ts`) with a
  neutral request boundary, data-driven capabilities, one-shot 400/422
  parameter recovery (30-day cache + Reset fixes), bounded 429/5xx backoff
  (non-streaming only), and normalized error kinds with friendly messages.
- Settings Test button now uses unsaved values (listModels → tiny completion
  → tool probe), shows inline success/failure, aborts at 15 s; model input
  suggests names from `listModels`; new `sendTemperature` toggle for Custom.
- Conformance suite runs identical mocked-HTTP scenarios per adapter plus a
  literal-contract test; see `docs/providers.md`.
