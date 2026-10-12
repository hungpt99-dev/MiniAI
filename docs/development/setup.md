# Setup (Windows x64)

Requires Node >= 22.5 (tests use `node:sqlite`).

```powershell
npm ci
npm run typecheck
npx vitest run
npm run build:main
npm run build:renderer
npm run dev    # launches Electron
npm run dist   # electron-builder --win portable
```

No lint/format tooling. Match 2-space style, CRLF.
