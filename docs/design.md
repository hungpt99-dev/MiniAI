# Design notes (incl. macOS)

Single panel, 1px `--border`, no shadow, 22px radius, solid `#15161B` panel —
identical on Windows and macOS. Slim custom scrollbars, real buttons with
`aria-label`s, accent usage as before. The legacy `design/MiniAI — Popup UI.html`
file does not exist in this repo; these notes are the source of truth.

macOS differences (conventions only, no redesign):

- Font stack: bundled Geist first, then `-apple-system` / `SF Pro Text`
  (`body.mac`), then sans-serif. Windows keeps `Segoe UI` after Geist.
  JetBrains Mono stays bundled; no network fonts.
- Menu-bar app: no Dock presence; Template tray icon adapts to light/dark bars.
- Key caps use macOS glyphs (`⌥` `⌃` `⇧` `⌘`) from the same helper as docs.
- Native `<select>` stays banned. `prefers-reduced-motion` and the OS
  dark/light/high-contrast setting are respected on both OSes.
- Resize animation and the 560px cap behave the same.
