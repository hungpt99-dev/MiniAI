# Release (signing, notarization, updates)

## Windows

- `npm run dist` builds nsis (x64) + portable via `electron-builder.yml`.
- Signing: set `CSC_LINK` (certificate file or thumbprint) and
  `CSC_KEY_PASSWORD` in the environment. Unsigned local builds work.

## macOS

- Targets: `dmg` + `zip`, universal (`arm64` + `x64`). The `zip` target is
  required for auto-update.
- Hardened runtime is on; entitlements are in `build/entitlements.mac.plist`
  (`allow-jit` + `allow-unsigned-executable-memory`, which Electron needs;
  nothing broader). Category: productivity. Minimum: macOS 13.0.
- Signing: `CSC_LINK` + `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`.
- Notarization: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` (or API key
  `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`). Without owner
  credentials the build works unsigned for local dev but will trigger
  Gatekeeper warnings; notarization was not performed here.
- `LSUIElement` keeps Nexio as a menu-bar app (no Dock icon).

## Auto-update

No auto-updater is wired in yet (Planned). When added: use the `zip` target
on macOS, require signed builds, and never auto-install without the user's
consent.

## Native modules

None. Storage uses Node's built-in `node:sqlite`; the MCP SDK is pure JS.
No per-architecture native rebuilds are needed beyond Electron itself.

## CI

`.github/workflows/ci.yml` builds + tests on `windows-latest`, `macos-latest`
(arm64) and `macos-13` (x64 Intel check): `npm ci`, typecheck, tests, full
build, unsigned `electron-builder --dir` smoke, artifacts upload.
