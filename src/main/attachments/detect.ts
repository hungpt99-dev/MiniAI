/** Attachment detection: WHAT is this file (magic bytes + structure, never the extension).
 * Main-process only (needs Buffer/zlib for container inspection). */
import { decodeAttachmentText } from './decode';

export type AttachKind =
  | 'empty' | 'text' | 'rtf'
  | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic'
  | 'pdf'
  | 'docx' | 'docm' | 'xlsx' | 'xlsm' | 'pptx' | 'pptm'
  | 'odt' | 'ods' | 'odp' | 'epub'
  | 'doc' | 'xls' | 'ppt' | 'ole' | 'office-encrypted'
  | 'zip' | 'zip-corrupt' | 'jar' | 'apk' | 'archive'
  | 'mp3' | 'mp4' | 'dmg' | 'pkg'
  | 'exe' | 'elf' | 'macho' | 'msi' | 'lnk' | 'url' | 'scf' | 'appx'
  | 'unknown';

export type AttachFlag = 'macros' | 'encrypted' | 'executable' | 'zipbomb';

export interface Detection {
  kind: AttachKind;
  mime: string;
  /** Container format when the kind was found by inspection ('zip' | 'ole'). */
  container?: 'zip' | 'ole';
  flags: AttachFlag[];
  /** Human evidence for the Details toggle (never file content). */
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  /** Detected text encoding for kind 'text' (shown on the chip tooltip). */
  encoding?: string;
}

/** Safety limits for container inspection (constants, tested). */
export const ZIP_LIMITS = {
  maxEntries: 10_000,
  maxTotalUncompressed: 500 * 1024 * 1024,
  maxRatio: 100,
  /** Bytes scanned for OLE stream-name markers. */
  oleScanBytes: 64 * 1024,
  /** Bytes scanned for PDF /Encrypt. */
  headScanBytes: 8192,
} as const;

const MIME: Record<AttachKind, string> = {
  empty: 'application/x-empty',
  text: 'text/plain',
  rtf: 'application/rtf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  ole: 'application/x-ole-storage',
  'office-encrypted': 'application/x-office-encrypted',
  zip: 'application/zip',
  'zip-corrupt': 'application/zip',
  jar: 'application/java-archive',
  apk: 'application/vnd.android.package-archive',
  archive: 'application/x-archive',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  dmg: 'application/x-apple-diskimage',
  pkg: 'application/x-pkg',
  exe: 'application/x-msdownload',
  elf: 'application/x-elf',
  macho: 'application/x-mach-binary',
  msi: 'application/x-msi',
  lnk: 'application/x-ms-shortcut',
  url: 'application/x-url',
  scf: 'application/x-shortshell',
  appx: 'application/x-appx',
  unknown: 'application/octet-stream',
};

export function mimeForKind(kind: AttachKind): string {
  return MIME[kind];
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  encrypted: boolean;
}

export interface ZipIndex {
  entries: ZipEntry[];
  totalUncompressed: number;
  truncated: boolean;
  corrupt: boolean;
  skippedTraversal: boolean;
}

/** Read the ZIP central directory only (never extracts). Bounded, never throws. */
export function readZipIndex(buf: Buffer): ZipIndex {
  const out: ZipIndex = { entries: [], totalUncompressed: 0, truncated: false, corrupt: false, skippedTraversal: false };
  try {
    const EOCD = 0x06054b50;
    const tail = Math.min(buf.length, 65535 + 22);
    let eocd = -1;
    for (let i = buf.length - 22; i >= buf.length - tail && i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) { out.corrupt = true; return out; }
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    let off = buf.readUInt32LE(eocd + 16);
    if (count > ZIP_LIMITS.maxEntries || off + cdSize > buf.length) { out.corrupt = true; return out; }
    const end = off + cdSize;
    while (off + 46 <= end && off + 46 <= buf.length) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const flags = buf.readUInt16LE(off + 8);
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const uncompSize = buf.readUInt32LE(off + 24);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOffset = buf.readUInt32LE(off + 42);
      const nameStart = off + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > buf.length) { out.corrupt = true; break; }
      const rawName = buf.subarray(nameStart, nameEnd);
      const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
      off = nameEnd + extraLen + commentLen;
      // Reject traversal entries: skip them, keep inspecting the rest.
      const segs = name.split('/');
      if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || segs.includes('..')) {
        out.skippedTraversal = true;
        continue;
      }
      // Zip-bomb guard on metadata alone (no allocation).
      if (method === 8 && compSize > 0 && uncompSize / compSize > ZIP_LIMITS.maxRatio) {
        out.entries.push({ name, method, compSize, uncompSize, localOffset, encrypted: (flags & 1) !== 0 });
        out.totalUncompressed += uncompSize;
        return { ...out, truncated: true };
      }
      out.totalUncompressed += uncompSize;
      if (out.totalUncompressed > ZIP_LIMITS.maxTotalUncompressed || out.entries.length >= ZIP_LIMITS.maxEntries) {
        return { ...out, truncated: true };
      }
      out.entries.push({ name, method, compSize, uncompSize, localOffset, encrypted: (flags & 1) !== 0 });
    }
  } catch {
    out.corrupt = true;
  }
  return out;
}

/**
 * Read one entry's data, bounded by budget (deflated entries inflate only
 * when the header-claimed size fits the budget). Returns null when refused.
 */
export function readZipEntry(buf: Buffer, entry: ZipEntry, budget: number): Buffer | null {
  try {
    const off = entry.localOffset;
    if (off + 30 > buf.length) return null;
    if (buf.readUInt32LE(off) !== 0x04034b50) return null;
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    if (start + entry.compSize > buf.length) return null;
    if (entry.uncompSize > budget) return null;
    const data = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const zlib = require('node:zlib') as typeof import('node:zlib');
      const out = zlib.inflateSync(data, { maxOutputLength: budget });
      return Buffer.from(out);
    }
    return null;
  } catch {
    return null;
  }
}

function hasName(entries: ZipEntry[], re: RegExp): boolean {
  return entries.some((e) => re.test(e.name));
}

function scanText(hay: Buffer, needle: string): boolean {
  if (hay.includes(needle)) return true;
  // UTF-16LE variant (OLE stream names are wide).
  const wide = Buffer.from(needle.split('').join('\0') + '\0', 'latin1');
  return hay.includes(wide);
}

function classifyZip(buf: Buffer): Detection {
  const idx = readZipIndex(buf);
  if (idx.corrupt && !idx.entries.length) {
    return { kind: 'zip-corrupt', mime: MIME['zip-corrupt'], container: 'zip', flags: [], evidence: 'PK header, unreadable central directory', confidence: 'medium' };
  }
  const names = idx.entries;
  const macro = hasName(names, /vbaProject\.bin$/i) || hasName(names, /activeX/i);
  const flags: AttachFlag[] = [];
  if (macro) flags.push('macros');
  if (names.some((e) => e.encrypted)) flags.push('encrypted');
  const has = (...parts: string[]) => parts.some((p) => names.some((e) => e.name === p));
  // JAR/APK/AAR: executable containers are rejected by policy via the flag.
  if (has('META-INF/MANIFEST.MF') || has('AndroidManifest.xml') || names.some((e) => e.name.endsWith('classes.dex'))) {
    const isApk = has('AndroidManifest.xml') || names.some((e) => e.name.endsWith('classes.dex'));
    return mk(isApk ? 'apk' : 'jar', 'zip', [...flags, 'executable'], 'ZIP + Java/Android manifest');
  }
  // APPX/MSIX packages: executable containers, rejected by policy.
  if (has('AppxManifest.xml')) {
    return mk('appx', 'zip', [...flags, 'executable'], 'ZIP + AppxManifest.xml');
  }
  if (has('[Content_Types].xml')) {
    if (has('word/document.xml')) return mk(macro ? 'docm' : 'docx', 'zip', flags, 'PK + [Content_Types].xml + word/document.xml');
    if (has('xl/workbook.xml')) return mk(macro ? 'xlsm' : 'xlsx', 'zip', flags, 'PK + [Content_Types].xml + xl/workbook.xml');
    if (has('ppt/presentation.xml')) return mk(macro ? 'pptm' : 'pptx', 'zip', flags, 'PK + [Content_Types].xml + ppt/presentation.xml');
  }
  // OpenDocument / EPUB: mimetype must be the first entry, stored.
  if (names.length && names[0].name === 'mimetype' && names[0].method === 0) {
    const data = readZipEntry(buf, names[0], 200);
    const mt = data ? data.toString('utf8').trim().replace(/\0/g, '') : '';
    if (mt === 'application/vnd.oasis.opendocument.text') return mk('odt', 'zip', flags, 'PK + mimetype=odt');
    if (mt === 'application/vnd.oasis.opendocument.spreadsheet') return mk('ods', 'zip', flags, 'PK + mimetype=ods');
    if (mt === 'application/vnd.oasis.opendocument.presentation') return mk('odp', 'zip', flags, 'PK + mimetype=odp');
    if (mt === 'application/epub+zip') return mk('epub', 'zip', flags, 'PK + mimetype=epub');
  }
  return mk('zip', 'zip', flags, `PK + ${names.length} central-directory entries`);
}

function mk(kind: AttachKind, container: 'zip' | 'ole' | undefined, flags: AttachFlag[], evidence: string): Detection {
  const d: Detection = { kind, mime: MIME[kind], flags, evidence, confidence: 'high' };
  if (container) d.container = container;
  // jar/apk mime depends on the final kind.
  if (kind === 'jar') d.mime = MIME.jar;
  if (kind === 'apk') d.mime = MIME.apk;
  return d;
}

function classifyOle(buf: Buffer): Detection {
  const head = buf.subarray(0, Math.min(buf.length, ZIP_LIMITS.oleScanBytes));
  const flags: AttachFlag[] = [];
  if (scanText(head, 'EncryptedPackage')) {
    return { kind: 'office-encrypted', mime: MIME['office-encrypted'], container: 'ole', flags: ['encrypted'], evidence: 'OLE + EncryptedPackage stream', confidence: 'high' };
  }
  if (scanText(head, 'Windows Installer') || scanText(head, 'MSI.DAT')) {
    return { kind: 'msi', mime: MIME.msi, container: 'ole', flags: ['executable'], evidence: 'OLE + installer markers', confidence: 'medium' };
  }
  if (scanText(head, 'VBA')) flags.push('macros');
  if (scanText(head, 'WordDocument')) return mk('doc', 'ole', flags, 'OLE + WordDocument stream');
  if (scanText(head, 'PowerPoint Document')) return mk('ppt', 'ole', flags, 'OLE + PowerPoint Document stream');
  if (scanText(head, 'Workbook')) return mk('xls', 'ole', flags, 'OLE + Workbook stream');
  return mk('ole', 'ole', flags, 'OLE compound document, unknown streams');
}

function isUtf16Text(sample: Buffer): boolean {
  if (sample.length < 4 || sample.length % 2 !== 0) return false;
  let nulEven = 0, nulOdd = 0, printEven = 0, printOdd = 0;
  const n = Math.min(sample.length, 8192);
  for (let i = 0; i + 1 < n; i += 2) {
    const a = sample[i], b = sample[i + 1];
    if (a === 0) nulEven++; else if (a === 9 || a === 10 || a === 13 || (a >= 32 && a < 127)) printEven++;
    if (b === 0) nulOdd++; else if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printOdd++;
  }
  const pairs = n / 2;
  return (nulEven / pairs > 0.3 && (printOdd / pairs) > 0.5) || (nulOdd / pairs > 0.3 && (printEven / pairs) > 0.5);
}

function classifyText(buf: Buffer): Detection | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { kind: 'text', mime: MIME.text, flags: [], evidence: 'UTF-8 BOM', confidence: 'high', encoding: 'UTF-8 BOM' };
  }
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { kind: 'text', mime: MIME.text, flags: [], evidence: 'UTF-16 BOM', confidence: 'high', encoding: buf[0] === 0xff ? 'UTF-16 LE' : 'UTF-16 BE' };
  }
  const sample = buf.subarray(0, Math.min(buf.length, ZIP_LIMITS.headScanBytes));
  const head = sample.toString('utf8');
  const firstLine = head.split(/\r?\n/, 1)[0].trim();
  if (firstLine === '[InternetShortcut]') return mk('url', undefined, [], 'INI [InternetShortcut] header');
  if (firstLine === '[Shell]') return mk('scf', undefined, [], 'INI [Shell] header');
  if (isUtf16Text(sample)) return { kind: 'text', mime: MIME.text, flags: [], evidence: 'UTF-16 pattern, no BOM', confidence: 'medium', encoding: 'UTF-16' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    if (!sample.includes(0)) return { kind: 'text', mime: MIME.text, flags: [], evidence: 'valid UTF-8, no NUL bytes', confidence: 'medium', encoding: 'UTF-8' };
  } catch { /* not strict UTF-8 */ }
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    // why: tabs/CRLF/FF allowed; long lines and ;/tab separators never disqualify.
    if (c === 9 || c === 10 || c === 12 || c === 13 || (c >= 32 && c < 127) || c >= 0xa0) printable++;
  }
  if (sample.length > 0 && printable / sample.length > 0.85) {
    return { kind: 'text', mime: MIME.text, flags: [], evidence: 'printable bytes heuristic', confidence: 'medium', encoding: 'Windows-1252' };
  }
  // Legacy multibyte encodings (Shift-JIS/GBK/EUC-KR/...) fail strict UTF-8
  // but decode cleanly with their own label — never call them binary.
  try {
    const dec = decodeAttachmentText(buf.subarray(0, Math.min(buf.length, 65536)));
    if (dec && dec.text.trim()) return { kind: 'text', mime: MIME.text, flags: [], evidence: `decoded as ${dec.encoding}`, confidence: dec.confidence, encoding: dec.encoding };
  } catch { /* decoder never breaks detection */ }
  return null;
}

/** WHAT is this file? Magic bytes + structure. Never the extension. Never throws. */
export function detectAttachment(input: Buffer | Uint8Array): Detection {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (buf.length === 0) return { kind: 'empty', mime: MIME.empty, flags: [], evidence: '0 bytes', confidence: 'high' };
    const u32le = (i: number) => (buf.length >= i + 4 ? buf.readUInt32LE(i) : 0);
    const u32be = (i: number) => (buf.length >= i + 4 ? buf.readUInt32BE(i) : 0);
    // Executables and installers first (positively dangerous).
    if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
      return { kind: 'exe', mime: MIME.exe, flags: ['executable'], evidence: 'MZ header', confidence: 'high' };
    }
    if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return { kind: 'elf', mime: MIME.elf, flags: ['executable'], evidence: 'ELF magic', confidence: 'high' };
    }
    if (buf.length >= 4) {
      const le = u32le(0), be = u32be(0);
      if (le === 0xfeedface || le === 0xfeedfacf || be === 0xfeedface || be === 0xfeedfacf || be === 0xcafebabe || be === 0xcafebabf) {
        return { kind: 'macho', mime: MIME.macho, flags: ['executable'], evidence: 'Mach-O / fat-binary magic', confidence: 'high' };
      }
    }
    if (buf.length >= 8 && buf[0] === 0x4c && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x00) {
      return { kind: 'lnk', mime: MIME.lnk, flags: ['executable'], evidence: 'LNK shell-link header', confidence: 'high' };
    }
    // Images.
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return mk('png', undefined, [], 'PNG magic');
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return mk('jpeg', undefined, [], 'JPEG magic');
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return mk('gif', undefined, [], 'GIF magic');
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return mk('webp', undefined, [], 'RIFF WEBP');
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return mk('bmp', undefined, [], 'BM header');
    if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))) return mk('tiff', undefined, [], 'TIFF magic');
    if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.subarray(8, 12).toString('ascii');
      if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return mk('heic', undefined, [], 'ISO-BMFF HEIC brand');
      return mk('mp4', undefined, [], 'ISO-BMFF ftyp box');
    }
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return mk('mp3', undefined, [], 'ID3 tag');
    // PDF (with encryption flag).
    if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      const head = buf.subarray(0, Math.min(buf.length, ZIP_LIMITS.headScanBytes)).toString('latin1');
      if (/\/Encrypt\b/.test(head)) {
        return { kind: 'pdf', mime: MIME.pdf, flags: ['encrypted'], evidence: '%PDF + /Encrypt', confidence: 'high' };
      }
      return mk('pdf', undefined, [], '%PDF magic');
    }
    // RTF.
    if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '{\\rtf') return mk('rtf', undefined, [], 'RTF header');
    // ZIP containers (docx/xlsx/pptx/odt/jar/...): never stop at "PK".
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 && buf[3] === 0x04 || buf[2] === 0x05 && buf[3] === 0x06 || buf[2] === 0x07 && buf[3] === 0x08)) {
      return classifyZip(buf);
    }
    // Legacy Office (OLE2).
    if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
      && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1) {
      return classifyOle(buf);
    }
    // Other archives.
    if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c) {
      return { kind: 'archive', mime: 'application/x-7z-compressed', flags: [], evidence: '7z magic', confidence: 'high' };
    }
    if (buf.length >= 7 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 && buf[4] === 0x1a && buf[5] === 0x07) {
      return { kind: 'archive', mime: 'application/vnd.rar', flags: [], evidence: 'RAR magic', confidence: 'high' };
    }
    if (buf.length >= 262 && buf.subarray(257, 262).toString('ascii') === 'ustar') {
      return { kind: 'archive', mime: 'application/x-tar', flags: [], evidence: 'tar ustar header', confidence: 'high' };
    }
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return { kind: 'archive', mime: 'application/gzip', flags: [], evidence: 'gzip magic', confidence: 'high' };
    }
    // Apple disk images: 'koly' trailer in the last 512 bytes.
    if (buf.length >= 512 && buf.subarray(buf.length - 512).includes('koly')) {
      return { kind: 'dmg', mime: MIME.dmg, flags: [], evidence: 'UDIF koly trailer', confidence: 'medium' };
    }
    // macOS installer packages (xar).
    if (buf.length >= 4 && buf[0] === 0x78 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
      return { kind: 'pkg', mime: MIME.pkg, flags: [], evidence: 'xar! header', confidence: 'high' };
    }
    // Text last (shebang scripts land here as text, per policy).
    const text = classifyText(buf);
    if (text) return text;
    return { kind: 'unknown', mime: MIME.unknown, flags: [], evidence: 'no recognized magic or structure', confidence: 'low' };
  } catch {
    // A failure to inspect is never a crash — and never a rejection by itself.
    return { kind: 'unknown', mime: MIME.unknown, flags: [], evidence: 'inspection failed', confidence: 'low' };
  }
}
