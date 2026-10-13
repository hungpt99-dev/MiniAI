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

## Attachments tray

- Tray sits under the composer (`0 22px 12px`, flex, `gap 8px`, wraps to
  2 rows max with scroll). Images show 56×56 thumbs (`r10`, bordered, cover);
  files show surface chips (`r10`, `6×10`, 13px name + file SVG + 12px muted
  size) with an 18px remove button (hover/focus states).
- Dragging files over the panel shows a dashed accent outline with
  "Drop to attach"; drops outside the panel are swallowed so the popup never
  navigates. Paste handles text-only / image-only / files-only / mixed.
- Clicking a thumb/chip opens an in-panel preview (Esc closes it first, focus
  returns to the prior element). The tray is a labelled list with a live
  region; `Backspace` removes the focused (or last) chip.
- Ask history shows 160px thumbs/chips with a "Delete attachments" menu.
  Vision-failure notices carry a one-click "Switch model" button.
