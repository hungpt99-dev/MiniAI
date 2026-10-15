/** Text decoding: bytes -> UTF-8 string with detected encoding (main process only).
 * Order: BOM (UTF-8/16LE-BE/32) -> valid UTF-8 -> UTF-16 without BOM (NUL
 * pattern) -> legacy single/multibyte via built-in TextDecoder labels
 * (windows-1252, shift_jis, gb18030, big5, euc-kr, koi8-r). No new deps:
 * Node 22 ICU covers these labels. Never throws.
 */

export type DecodedText = { text: string; encoding: string; confidence: 'high' | 'medium' | 'low' };

const LEGACY: Array<{ label: string; name: string }> = [
  { label: 'windows-1252', name: 'Windows-1252' },
  { label: 'shift_jis', name: 'Shift-JIS' },
  { label: 'gb18030', name: 'GBK' },
  { label: 'big5', name: 'Big5' },
  { label: 'euc-kr', name: 'EUC-KR' },
  { label: 'koi8-r', name: 'KOI8-R' },
];

/** Fraction of printable chars (tabs/CRLF/FF allowed, ~1% odd controls tolerated). */
export function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c === 12 || (c >= 32 && c !== 0x7f) || c > 0xa0) ok++;
  }
  return ok / s.length;
}

function tryDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return null;
  }
}

function utf16NoBom(buf: Buffer): { text: string; encoding: string } | null {
  if (buf.length < 4 || buf.length % 2 !== 0) return null;
  const n = Math.min(buf.length, 8192);
  let nulEven = 0, nulOdd = 0, printEven = 0, printOdd = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    if (buf[i] === 0) nulEven++;
    else if (buf[i] === 9 || buf[i] === 10 || buf[i] === 13 || (buf[i] >= 32 && buf[i] < 127)) printEven++;
    if (buf[i + 1] === 0) nulOdd++;
    else if (buf[i + 1] === 9 || buf[i + 1] === 10 || buf[i + 1] === 13 || (buf[i + 1] >= 32 && buf[i + 1] < 127)) printOdd++;
  }
  const pairs = n / 2;
  // why: the text lane itself must read as text — NULs alone also match
  // sparse binary (e.g. 00 01 02 03 …), which is not UTF-16 text.
  if (nulEven / pairs > 0.3 && nulOdd / pairs < 0.1 && printOdd / pairs > 0.6) {
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16 BE' };
  }
  if (nulOdd / pairs > 0.3 && nulEven / pairs < 0.1 && printEven / pairs > 0.6) {
    return { text: buf.toString('utf16le'), encoding: 'UTF-16 LE' };
  }
  return null;
}

/** Bonus for real CJK/Hangul/Kana script — latin1 maps every byte somewhere
 * printable, so without this Windows-1252 always outscores multibyte text.
 * Weighted per candidate: kana favors Shift-JIS, hanzi favors GBK/Big5,
 * hangul favors EUC-KR (a wrong-encoding decode of CJK bytes lands in a
 * different script block, so the true encoding wins the tiebreak). */
function scriptBonus(s: string, name: string): number {
  const chars = [...s.slice(0, 2000)];
  if (!chars.length) return 0;
  let kana = 0, hanzi = 0, hangul = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0) || 0;
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0x4e00 && c <= 0x9fff) hanzi++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
  }
  const n = chars.length;
  if (name === 'Shift-JIS') return (2 * kana) / n;
  if (name === 'GBK' || name === 'Big5') return (2 * hanzi) / n;
  if (name === 'EUC-KR') return (2 * hangul) / n;
  return 0;
}

/** Best legacy-encoding candidate with its contest score (0 when none beats binary). */
function bestLegacy(buf: Buffer): { text: string; encoding: string; score: number } | null {
  let best: { text: string; encoding: string; score: number } | null = null;
  let bestScore = 0.9;
  for (const { label, name } of LEGACY) {
    const s = tryDecode(buf.subarray(0, Math.min(buf.length, 256 * 1024)), label);
    if (s == null) continue;
    // CJK-script bonus: latin1 maps every byte to something printable, so a
    // bare ratio always favors Windows-1252 over real multibyte text.
    const score = printableRatio(s.slice(0, 8192)) + (name === 'Windows-1252' ? 0 : scriptBonus(s, name));
    if (score > bestScore) {
      bestScore = score;
      let text = s;
      if (buf.length > 256 * 1024) text += tryDecode(buf.subarray(256 * 1024), label) || '';
      best = { text, encoding: name, score };
    }
  }
  return best;
}

/** Decode any decodable text. Returns null only for true binary. */
export function decodeAttachmentText(input: Buffer | Uint8Array): DecodedText | null {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (!buf.length) return { text: '', encoding: 'empty', confidence: 'high' };
    // 1. BOMs.
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { text: buf.slice(3).toString('utf8'), encoding: 'UTF-8 BOM', confidence: 'high' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      if (buf.length >= 4 && buf[2] === 0 && buf[3] === 0) {
        return { text: tryDecode(buf.slice(4), 'utf-32le') || '', encoding: 'UTF-32 LE', confidence: 'high' };
      }
      return { text: buf.slice(2).toString('utf16le'), encoding: 'UTF-16 LE', confidence: 'high' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.slice(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
      return { text: swapped.toString('utf16le'), encoding: 'UTF-16 BE', confidence: 'high' };
    }
    // 2. Valid UTF-8 (strict). NULs allowed only when the rest is clean text.
    // why: Shift-JIS/GBK byte pairs are often also *valid* UTF-8 (mojibake
    // trap: 82 B1 decodes as U+0471). A legacy candidate wins only with
    // strong script evidence (margin 0.5) so real UTF-8 CJK never flips.
    let utf8: string | null = null;
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 512 * 1024)));
      const full = buf.length > 512 * 1024 ? s + buf.subarray(512 * 1024).toString('utf8') : s;
      if (printableRatio(full.slice(0, 8192)) > 0.85 || full.length === 0) {
        utf8 = full;
      }
    } catch { /* not strict UTF-8 — try UTF-16 pattern, then legacy */ }
    if (utf8 != null && utf8.length !== 0) {
      const legacy = bestLegacy(buf);
      if (legacy && legacy.score > printableRatio(utf8.slice(0, 8192)) + 0.5) return { text: legacy.text, encoding: legacy.encoding, confidence: 'medium' };
      return { text: utf8, encoding: 'UTF-8', confidence: 'high' };
    }
    if (utf8 != null) return { text: utf8, encoding: 'UTF-8', confidence: 'high' }; // empty handled above; kept for clarity
    // 3. UTF-16 without BOM.
    const u16 = utf16NoBom(buf);
    if (u16 && printableRatio(u16.text.slice(0, 8192)) > 0.9) {
      return { text: u16.text, encoding: u16.encoding, confidence: 'medium' };
    }
    // 4. Legacy encodings: best printable-ratio wins (needs >0.9 to beat binary).
    const legacy = bestLegacy(buf);
    if (legacy) {
      return { text: legacy.text, encoding: legacy.encoding, confidence: printableRatio(legacy.text.slice(0, 8192)) > 0.98 ? 'medium' : 'low' };
    }
    // Long lines / tabs / semicolons never disqualify: re-check raw bytes as
    // latin1-mapped text before calling it binary.
    const latin = buf.toString('latin1');
    if (printableRatio(latin.slice(0, 8192)) > 0.95 && !buf.subarray(0, 8192).includes(0)) {
      return { text: latin, encoding: 'Windows-1252', confidence: 'low' };
    }
    return null;
  } catch {
    return null;
  }
}

/** Slice a string without splitting surrogate pairs / grapheme breaks (code-point safe). */
export function safeSlice(s: string, start: number, end: number): string {
  const pts = Array.from(s);
  return pts.slice(start, end).join('');
}
