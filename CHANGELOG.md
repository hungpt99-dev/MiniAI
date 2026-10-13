# Changelog

## Unreleased

- Brand assets (full spec): `design/*.svg` promoted to `assets/` C2PA-free
  (icon 512 `r112`/`stroke42`/`dot26`, banner 1280x320, social 1280x640);
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
