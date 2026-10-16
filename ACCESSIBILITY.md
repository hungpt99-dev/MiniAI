# Accessibility Statement for Nexio

## Our commitment to accessibility

Nexio is a keyboard-first popup assistant, and we want it to be usable by
everyone. We aim to support keyboard-only operation for every core action,
visible focus states, readable text, and a consistent layout. Accessibility
is part of our definition of done for UI changes: new popup, Settings, and
Tasks-view work should be fully operable without a mouse.

## Supported environments

* OS: Windows 10/11 (x64) and macOS 13+, the same platforms Nexio supports.
* Input: full keyboard operation â€” every core action has a shortcut
  (see [docs/shortcuts.md](docs/shortcuts.md)). No pointer-only flows.
* Languages: English and Vietnamese UI with a no-restart switch.
* Display: the popup follows the OS theme; text scales with OS settings.

Screen-reader and high-contrast support have not been formally verified yet
(see limitations below). If you rely on assistive technology, your reports
directly shape our priorities.

## Known limitations

* Screen-reader behavior (NVDA, JAWS, VoiceOver) has not been tested
  end to end; labels and live-region announcements for streaming answers
  and approval cards may be incomplete.
* High-contrast / forced-colors modes have not been verified.
* Demo media in `docs/media/` are placeholders; captions or transcripts
  are missing until they are recorded (see README capture list).
* Reduced-motion preferences are not yet honored by animations.
* Some Settings and Tasks-view surfaces are new and may have focus-order
  or contrast gaps.

We fix accessibility barriers based on user impact, and regressions in
keyboard operation are treated as bugs, not enhancements.

## How to report barriers

Open a GitHub issue with a title starting with `[a11y]` and include:

* What you tried to do and what stopped you.
* OS and version, app version (`package.json`), and assistive technology
  used (screen reader, magnifier, voice control, keyboard only).
* Screenshots or redacted logs if helpful â€” never include API keys
  (see [SECURITY.md](SECURITY.md)).

If the barrier involves sensitive or private information, report it
privately via a
[GitHub security advisory](https://github.com/hungpt99-dev/Nexio/security/advisories/new)
instead of a public issue. We aim to acknowledge reports promptly and to
offer a workaround while a fix is in progress.
