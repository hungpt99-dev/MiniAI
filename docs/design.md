# Design notes (incl. macOS)

Single panel, 1px `--border`, no shadow, 22px radius, solid `#15161B` panel —
identical on Windows and macOS. Slim custom scrollbars, real buttons with
`aria-label`s, accent usage as before. No legacy mockup files remain in this repo; these notes are the source of truth.

macOS differences (conventions only, no redesign):

- Font stack: bundled Geist first, then `-apple-system` / `SF Pro Text`
  (`body.mac`), then sans-serif. Windows keeps `Segoe UI` after Geist.
  JetBrains Mono stays bundled; no network fonts.
- Menu-bar app: no Dock presence; Template tray icon adapts to light/dark bars.
- Key caps use macOS glyphs (`⌥` `⌃` `⇧` `⌘`) from the same helper as docs.
- Native `<select>` stays banned. `prefers-reduced-motion` and the OS
  dark/light/high-contrast setting are respected on both OSes.
- Resize animation and the 560px cap behave the same.

## Brand

![Nexio icon](images/icon-128.png)

Dark-background brand only — there is no light variant.

- Source vectors: `assets/icon.svg` (512, `viewBox 0 0 512 512`),
  `assets/banner.svg` (1280x360), `assets/social-preview.svg` (1280x640).
  C2PA metadata is stripped from the committed copies. Source of truth is
  `design/*.svg`: edit those first, then run `npm run assets` to regenerate.
- Construction: rounded square `rx 112`, N path `stroke-width 42`,
  dot `r 26`, accent `#B8F26B` on `#15161B`.
- Generated files (`npm run assets`, verified by `npm run assets:check`):  `assets/icon.png` (1024), `assets/icons/icon-{16,24,32,48,64,128,256,512,1024}.png`,
  `assets/icon.ico` (16–256), `assets/icon.icns` (macOS `iconutil` only),
  `assets/banner.png` (2560x720), `assets/social-preview.png` (1280x640, <1MB),
  `assets/tray/tray-{16,20,24,32}.png`, `docs/images/icon-128.png`.
  PNG text renders with system fonts (bundled woff2 subsets don't match
  resvg's fontdb); the SVG is canonical, PNG text may differ subtly per OS.
- Template tray icons (`assets/Nexio-Template*.png`, 18/36px): black-only N + dot,
  no rounded square; filenames must end in `Template` or macOS will not treat
  them as templates (`setTemplateImage`). Stroke stays readable at 18px.
- Rules: transparent outside the rounded square (no halo), 4% safe margin for
  the inner artwork, 12% clear space around the tile in layouts, 16px minimum size.
- Don'ts: no light-background variant, no gradients, no shadow, no recoloring
  the accent, no square Template icons.
- GitHub social preview is a manual upload (no automation):
  Repository Settings > General > Social preview > Upload
  `assets/social-preview.png` (1280x640, <1MB).

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

## Answer actions

- One row, never wraps: `#answer-meta` (flex, 8px gap, exactly 28px tall,
  no margins, 12px muted, `line-height: 1`; sits 6px under the answer via
  `#run` gaps). Everything inside is `nowrap`/`flex:none` except the model
  label (ellipsis, `max-width 160px`).
  Model label: 6px accent dot + 12px muted name with full-name tooltip.
  Steps/memory toggles stay in their own row above, in `#agent-steps`.
- Right group (`margin-inline-start: auto`, 2px gap): Copy and Follow up are
  visible ghost buttons (28px, `0 8px`, `r8`, 12px muted, 14px icon, 6px
  gap; hover surface + text; 2px accent focus ring). Copy confirms inline
  ("Copied", 1.5 s). A "More" dots button (28x28, `aria-haspopup="menu"`)
  opens a custom menu: New chat, Run as separate task, Add to queue (with
  the Ctrl/Cmd+Enter hint). Ask mode shows New chat as a visible button
  instead of More and hides the task items.
- Menu: absolute under the button, right-aligned, flips up without room,
  `min-width 220px`, surface + border, `r12`, 4px padding, no shadow.
  Items 32px, `0 10px`, `r8`, 13px text-soft, 14px icon, mono muted shortcut
  hint right. Full keyboard (arrows/Home/End/Enter/Esc/Tab), focus returns
  to More, click-outside closes, in-panel so never clipped.
- Narrow: container-driven with hysteresis (no fixed breakpoints, follows
  font scale + RTL logical props) — icon-only actions under ~420px, then
  dot-only model. Footer hints hide from the right under pressure
  (queue, clear, run, switch mode) via a separate `crowd-hide` class and
  never wrap.
- Rhythm (4px scale, one owner per gap): `.view` owns outer padding
  (`12px 22px 12px`); `#messages` gap 16, `.turn` gap 6, You rows gap 8;
  answer 15px/1.5 regular with 2px top; markdown blocks use one sibling
  rule (8px); mode dividers are marginless separators; footer 74px (16px + 40px content + 18px).
  `--space-scale` (1, or 0.75 via Settings > Compact spacing) scales them.

## Window visibility

- One module owns show/hide/focus (`src/main/app/window-visibility.ts`):
  every transition carries a reason and is debug-logged. Blur never hides
  directly — a 150ms recheck hides only with the pointer outside, outside
  the grace windows (600ms show, 300ms resize, 400ms dialog, 1s task),
  and with no dialog lock, approval, pin, or `hideOnBlur: false`.
- Pin (Alt+P, `/pin`, tray, footer badge): only Esc, hotkey and toggle hide.
- Notifications are silent; clicking one opens Tasks through the module.
- Prompt commands (`/translate` etc.) render their template with the command
  text before sending; the model parses target language/tone from the text.

## Footer icons

- Inline SVGs, 18px, stroke `currentColor` 1.8, round caps (no icon
  dependency). Settings uses the Lucide "settings" gear (ISC license):
  cog path + `r=3` center circle. No sun/brightness glyphs anywhere —
  the UI is dark-only with no theme toggle.

## Memory view

- Like Extensions: title "Memory" + back, segmented tabs
  (All | Preferences | Facts | Folders | Procedures | Episodes), search
  field, 56px rows (14px text 2-line clamp, 12px muted meta with kind, scope
  chip in mono, last-used, "Enforced" badge in accent on surface), pin
  toggle + overflow menu (Edit, Forget) on the right, inline edit form
  (textarea, kind seg, scope input, pin, Save/Cancel), "Add memory" primary
  button. Run-view rows reuse the 12px ghost button. No native selects.
