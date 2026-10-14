# Attachments

Drop, paste, or pick files to give Nexio context. Every file goes through
one pipeline in the main process: **detect** (what is it, by content) →
**policy** (what may Nexio do with it) → optional **text extraction**.

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

## Policy (`src/main/attachments/policy.ts`)

| Detection | Action |
|---|---|
| text / source / csv / json / md | `inline_text` (existing 200KB cap) |
| png jpeg webp gif | `image` (existing EXIF/resize pipeline) |
| docx xlsx pptx odt ods odp rtf | `document_extract` (built-in extractor) |
| pdf epub zip 7z rar tar gz mp3 mp4 doc xls ppt bmp tiff heic dmg pkg ole | `reference_only` (name, size, type, path; no content sent) |
| macro-enabled / macros flag | `reference_only` + "Contains macros. Nexio will not run it." |
| encrypted flag | `reference_only` + "Encrypted. Contents not readable." |
| exe elf macho msi lnk url scf appx jar apk | **reject** with a specific message |
| unknown / corrupt / empty-inspection-failure | `reference_only` ("Unknown type" never rejects) |

Rejections read `Not attached: <name> is an executable (Windows
program).` plus a `Details:` line (`detected exe (MZ header), rule
executable-deny`) behind a toggle — never "executable or unknown
content". Rejections are inline messages (not chips), dismissible, and
announced through the sr-only live region.

## Text extraction (`src/main/attachments/extract.ts`)

Built-in OOXML/ODF/RTF reader (ZIP index + tag stripping, `zlib` only —
no new dependencies): docx text + headings outline, xlsx sheets + values
+ sheet names, pptx slides + titles, odt headings/paragraphs, RTF.
Limits: 5 MB extracted text, 8 MB per ZIP part, 500 slides / 200 sheets /
200k paragraphs (whichever first). Embedded images are counted, never
read. Macro payloads are never executed (binary parts are never even
inflated for text purposes).

Extracted text is **untrusted data** (delimited-block + prompt-injection
rules), secrets-scanned (chip warn + context note), truncated with a
marker past the budget. The chip shows "Extracted" with a hover preview of
the first lines; `attachment_read` serves the stored text in chunks.

PDF text extraction is **Planned** (would need pdf.js; kept
`reference_only` with "Added as reference only, contents not read").
Scanned PDFs report "No readable text found (scanned?)". Extraction runs
inline under strict input caps — no worker needed (bounded, ms-scale).

## Chips

Normal, "Extracted" (accent), "Reference only" (muted, tooltip: "Nexio can
see the file name and path but not its contents."), "Macros" (warn),
"Encrypted" (muted), "Empty file", "May contain secrets" (existing).
Rejected files are never chips. Same pipeline on Windows and macOS, for
drop, paste and picker.
