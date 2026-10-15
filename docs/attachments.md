# Attachments

Drop, paste, or pick files to give Nexio context. Every file goes through
one pipeline in the main process: **detect** (what is it, by content) →
**policy** (what may Nexio do with it) → **native send** (the provider's own
file/document/image input, original bytes — no OCR, no local text
extraction) or a refusal notice for types the provider cannot read.

## Detection (`src/main/attachments/detect.ts`)

Magic bytes + structure. Never the file extension, never the renderer MIME.

1. **Executables first**: PE `MZ`, ELF, Mach-O (all variants + fat
   binaries), LNK headers. Shebang scripts are *not* executables by content
   — they classify as text.
2. **ZIP containers**: a `PK` header never stops inspection. The central
   directory is read (bounded) and classified: OOXML (`[Content_Types].xml`
   + `word/document.xml` → docx, `xl/workbook.xml` → xlsx,
   `ppt/presentation.xml` → pptx; `vbaProject.bin`/ActiveX → macro
   variants docm/xlsm/pptm), OpenDocument (first entry `mimetype` →
   odt/ods/odp), EPUB, JAR/APK (manifest → `executable` flag → rejected),
   otherwise generic `zip`.
3. **Legacy Office** (OLE2 `D0 CF 11 E0`): stream markers `WordDocument`,
   `Workbook`, `PowerPoint Document`, `VBA` (macros), `EncryptedPackage`.
4. PDF (`%PDF`, `/Encrypt` scan), RTF, images (PNG/JPEG/WebP/GIF/BMP/TIFF/
   HEIC), MP3, MP4 (`ftyp`), 7z/rar/tar/gz, DMG (`koly` trailer), shortcuts
   (LNK binary, INI `[InternetShortcut]`/`[Shell]`), text (BOM, strict
   UTF-8/UTF-16, printable heuristic).

Safety limits (`ZIP_LIMITS`, tested): max 10,000 entries, 500 MB total
uncompressed, 100:1 compression-ratio guard on metadata alone (no
allocation), traversal entries (`../`, absolute paths) skipped, no nested
extraction, central directory only. Inspection failure → `unknown`, never
a crash and never a rejection by itself.

## Policy (`src/main/attachments/policy.ts`) + native send

| Detection | Action |
|---|---|
| text / source / csv / json / md | inline UTF-8 text (existing 200KB cap, secrets-masked) |
| png jpeg gif webp | native `image` part (EXIF stripped, 2048px cap — sanitizing, not OCR) |
| pdf (unencrypted) | native `document` part (original bytes; Anthropic document block, OpenAI/Gemini-compat file part) |
| docx xlsx pptx odt ods odp rtf | **refused** (`<provider> can't read .docx directly`) unless `localTextFallback` is on |
| macro-enabled / macros flag | `reference_only` + "Contains macros. Nexio will not run it." (never opened) |
| encrypted flag | `reference_only` + "Encrypted. Contents not readable." (never opened) |
| other known / unknown | **refused** with the same unsupported notice (remove it or switch model) |
| exe elf macho msi lnk url scf appx jar apk | **reject** with a specific message |

Per-provider native map: `getAttachmentCapabilities(provider, model)` in
`src/main/ai/providers/attachments.ts` (images + PDF on OpenAI/Anthropic/
Gemini; images-only on Compatible; nothing without vision). Shared limits
(5 files, 20MB/file, 50MB total) still apply, plus each provider's own
request-size cap (base64 adds ~33%, checked before sending) and page caps
where documented (Anthropic: 100 pages under 1M context, 600 above —
enforced by the provider). A limit failure names the hit limit inline.

Rejections read `Not attached: <name> is an executable (Windows
program).` plus a `Details:` line (`detected exe (MZ header), rule
executable-deny`) behind a toggle — never "executable or unknown
content". Unsupported-type refusals show on the chip ("Unsupported" badge)
and as an assistant message with a confirming "Switch model" button.
Rejections are inline messages (not chips), dismissible, and
announced through the sr-only live region.

## Text extraction (`src/main/attachments/extract.ts`, opt-in only)

The built-in OOXML/ODF/RTF reader (ZIP index + tag stripping, `zlib` only)
runs **only** when `localTextFallback` is on (Settings, default off) and
only for types the active provider cannot read. Extracted text is marked
`[text extracted locally]` on the chip ("Extracted" badge) and in the
sent block. Limits: 5 MB extracted text, 8 MB per ZIP part, 500 slides /
200 sheets / 200k paragraphs (whichever first). Embedded images are
counted, never read. Macro payloads are never executed.

Extracted text is **untrusted data** (delimited-block + prompt-injection
rules), secrets-scanned (chip warn + context note), truncated with a
marker past the budget. `attachment_read` serves the stored text in chunks.

The old PDF worker (`pdf.ts`/`pdf-worker.ts`, pdf.js + tesseract OCR) is
gone: PDFs go natively, so nothing parses or OCRs them locally anymore
(dependencies removed).

## Chips

Normal, "Native" (accent — sent as the provider's own file input),
"Extracted" (accent, fallback only), "Unsupported" (warn — remove or
switch model), "Reference only" (muted, macros/encrypted only),
"Macros" (warn), "Encrypted" (muted), "Empty file", "May contain
secrets" (existing). Rejected files are never chips. Same pipeline on
Windows and macOS, for drop, paste and picker.
