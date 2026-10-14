/** Renderer-safe Unicode text helpers (main + renderer, no Node APIs).
 * Rules: NFC for comparison/storage keys, original bytes stay on disk;
 * Intl.Segmenter for words/graphemes (never UTF-16 slicing);
 * locale-aware case folding (Turkish dotted i).
 */

/** Canonical form for comparison, dedupe keys and storage keys. */
export function nfc(s: string): string {
  try {
    return String(s).normalize('NFC');
  } catch {
    return String(s);
  }
}

/** Locale-aware lowercase. Falls back to runtime default, then plain lower. */
export function lowerSmart(s: string, locale?: string): string {
  const t = String(s);
  if (locale) {
    try { return t.toLocaleLowerCase(locale); } catch { /* fall through */ }
  }
  try { return t.toLocaleLowerCase(); } catch { /* fall through */ }
  return t.toLowerCase();
}

/** Locale-aware case-insensitive equality. */
export function eqFold(a: string, b: string, locale?: string): boolean {
  return lowerSmart(nfc(a), locale) === lowerSmart(nfc(b), locale);
}

type Segmenter = { segment(s: string): Iterable<{ segment: string }> };

function wordSegmenter(locale?: string): Segmenter | null {
  try {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter }).Segmenter;
    if (!Seg) return null;
    return new Seg(locale || undefined, { granularity: 'word' });
  } catch {
    return null;
  }
}

function graphemeSegmenter(): Segmenter | null {
  try {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter }).Segmenter;
    if (!Seg) return null;
    return new Seg(undefined, { granularity: 'grapheme' });
  } catch {
    return null;
  }
}

/** Word-like tokens for search/dedupe. Segments CJK/Thai; falls back to whitespace. */
export function words(s: string, locale?: string): string[] {
  const t = nfc(s);
  const seg = wordSegmenter(locale);
  if (seg) {
    try {
      const out: string[] = [];
      for (const part of seg.segment(t)) {
        const w = part.segment.trim();
        if (w && /[\p{L}\p{N}]/u.test(w)) out.push(w);
      }
      if (out.length) return out;
    } catch { /* fall through */ }
  }
  return t.split(/\s+/).filter(Boolean);
}

/** Grapheme clusters (emoji + combining marks stay whole). */
export function graphemes(s: string): string[] {
  const t = String(s);
  const seg = graphemeSegmenter();
  if (seg) {
    try {
      return [...seg.segment(t)].map((p) => p.segment);
    } catch { /* fall through */ }
  }
  return [...t];
}

/** First n grapheme clusters as a string (never splits emoji/marks). */
export function takeGraphemes(s: string, n: number): string {
  if (n <= 0) return '';
  return graphemes(s).slice(0, n).join('');
}

/** Grapheme-cluster count (limits count clusters, not UTF-16 units). */
export function graphemeLength(s: string): number {
  return graphemes(s).length;
}
