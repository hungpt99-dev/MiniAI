/** Document text extraction (main process, text only — no macros, no objects, no network).
 * Hand-rolled OOXML/ODF/RTF reader over the bounded ZIP index: no new
 * dependencies, input-bounded so a bad file cannot hang the app (no worker
 * needed — parsing is ms-scale and every allocation is capped).
 */
import { readZipEntry, readZipIndex, ZIP_LIMITS, type AttachKind } from './detect';

/** Max extracted text per file. */
export const EXTRACT_TEXT_CAP = 5 * 1024 * 1024;

export interface ExtractedDocument {
  text: string;
  /** Short outline: headings / sheet names / slide titles. */
  outline: string[];
  /** Embedded images ignored by default (count only). */
  images: number;
  truncated: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Math.min(Number(n), 0x10ffff)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try { return String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Pull readable text out of WordprocessingML, preserving headings for the outline. */
function docxText(xml: string): { text: string; outline: string[] } {
  const outline: string[] = [];
  // Headings first (w:pStyle w:val="HeadingN" inside w:pPr).
  const paras: string[] = [];
  let total = 0;
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml)) !== null) {
    const inner = m[1];
    const style = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(inner.slice(0, 2000));
    const words: string[] = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner)) !== null) words.push(decodeEntities(t[1]));
    const line = words.join('').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (style && /^heading/i.test(style[1])) {
      outline.push(line.slice(0, 200));
      paras.push(`## ${line}`);
    } else {
      paras.push(line);
    }
    total += line.length + 1;
    if (total > EXTRACT_TEXT_CAP || paras.length > 200_000) break;
  }
  return { text: paras.join('\n'), outline: outline.slice(0, 100) };
}

function sheetText(shared: string, sheetXml: string): string {
  // Shared strings table -> index, then sheet <v> indexes and inline <t>.
  const strings: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(shared)) !== null) {
    const parts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1])) !== null) parts.push(decodeEntities(t[1]));
    strings.push(parts.join(''));
    if (strings.length > 100_000) break;
  }
  const cells: string[] = [];
  let cellTotal = 0;
  const vRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  while ((m = vRe.exec(sheetXml)) !== null) {
    const type = /t="([^"]*)"/.exec(m[1])?.[1] || '';
    const inner = m[2];
    if (type === 's') {
      const idx = Number(/<v>(-?\d+)/.exec(inner)?.[1]);
      if (Number.isFinite(idx) && strings[idx] !== undefined) cells.push(strings[idx]);
    } else if (type === 'inlineStr' || type === 'str' || type === 'e') {
      const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      cells.push(t ? decodeEntities(t[1]) : inner.replace(/<[^>]+>/g, ''));
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) cells.push(decodeEntities(v[1]));
    }
    cellTotal += (cells[cells.length - 1] || '').length + 1;
    if (cellTotal > EXTRACT_TEXT_CAP || cells.length > 500_000) break;
  }
  return cells.join('\n');
}

function attr(xml: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Extract plain text + outline from a document buffer.
 * Returns null when the kind isn't extractable or the file is unusable
 * (caller keeps it as reference_only). Never throws, never executes macros.
 */
export function extractDocumentText(buf: Buffer, kind: AttachKind): ExtractedDocument | null {
  try {
    if (kind === 'rtf') return { text: rtfToText(buf.toString('utf8', 0, Math.min(buf.length, EXTRACT_TEXT_CAP + 1024))), outline: [], images: 0, truncated: buf.length > EXTRACT_TEXT_CAP };
    const idx = readZipIndex(buf);
    if (idx.corrupt || !idx.entries.length) return null;
    let budget = EXTRACT_TEXT_CAP;
    const take = (name: string): string | null => {
      const e = idx.entries.find((x) => x.name === name);
      if (!e) return null;
      const data = readZipEntry(buf, e, Math.min(budget, 20 * 1024 * 1024));
      if (!data) return null;
      budget -= data.length;
      return data.toString('utf8');
    };
    // Capped partial read for big content parts: parse what fits, mark truncation.
    // Stored entries slice (regex still finds early content); deflated entries
    // inflate at most PART_CAP (zip-bomb safe — never trusts header sizes).
    const PART_CAP = 8 * 1024 * 1024;
    const takePartial = (name: string): { xml: string; complete: boolean } | null => {
      const e = idx.entries.find((x) => x.name === name);
      if (!e || e.compSize > PART_CAP * 4) return null;
      try {
        const off = e.localOffset;
        if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) return null;
        const nl = buf.readUInt16LE(off + 26);
        const xl = buf.readUInt16LE(off + 28);
        const start = off + 30 + nl + xl;
        if (e.method === 0) {
          const n = Math.min(e.compSize, PART_CAP);
          if (start + n > buf.length) return null;
          return { xml: buf.subarray(start, start + n).toString('utf8'), complete: e.compSize <= PART_CAP };
        }
        if (e.method === 8) {
          if (start + e.compSize > buf.length) return null;
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const zlib = require('node:zlib') as typeof import('node:zlib');
          const out = zlib.inflateSync(buf.subarray(start, start + e.compSize), { maxOutputLength: PART_CAP });
          return { xml: Buffer.from(out).toString('utf8'), complete: e.uncompSize <= PART_CAP };
        }
      } catch { /* fall through */ }
      return null;
    };
    const mediaCount = idx.entries.filter((e) => /^(word|ppt)\/media\//.test(e.name) || /^Pictures\//.test(e.name)).length;
    if (kind === 'docx' || kind === 'docm') {
      const part = takePartial('word/document.xml');
      if (!part) return null;
      const { text, outline } = docxText(part.xml);
      const res = finish(text, outline, mediaCount);
      res.truncated = res.truncated || !part.complete;
      return res;
    }
    if (kind === 'xlsx' || kind === 'xlsm') {
      const wb = take('xl/workbook.xml');
      if (wb == null) return null;
      const outline: string[] = [];
      const sheetRe = /<sheet\b[^>]*>/g;
      const sheets: Array<{ name: string; id: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = sheetRe.exec(wb)) !== null) {
        const name = attr(m[0], 'name');
        const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
        if (name && rid) { sheets.push({ name, id: rid }); outline.push(name.slice(0, 200)); }
        if (sheets.length > 200) break;
      }
      const rels = take('xl/_rels/workbook.xml.rels');
      const targets = new Map<string, string>();
      if (rels) {
        const rRe = /<Relationship\b[^>]*>/g;
        while ((m = rRe.exec(rels)) !== null) {
          const id = attr(m[0], 'Id');
          let target = attr(m[0], 'Target');
          if (id && target) {
            // Targets are relative to xl/_rels: ../worksheets/sheet1.xml -> xl/worksheets/sheet1.xml.
            if (target.startsWith('../')) target = 'xl/' + target.slice(3);
            else if (!target.startsWith('xl/')) target = 'xl/' + target;
            targets.set(id, target);
          }
        }
      }
      const sharedPart = takePartial('xl/sharedStrings.xml');
      const shared = sharedPart ? sharedPart.xml : '';
      let partial = !sharedPart;
      const parts: string[] = [];
      let partsTotal = 0;
      for (const s of sheets.slice(0, 200)) {
        const target = targets.get(s.id) || `xl/worksheets/sheet${sheets.indexOf(s) + 1}.xml`;
        const sp = takePartial(target);
        if (!sp) { partial = true; continue; }
        if (!sp.complete) partial = true;
        const xml = sp.xml;
        parts.push(`# ${s.name}`);
        partsTotal += s.name.length + 3;
        if (xml) {
          const body = sheetText(shared, xml);
          parts.push(body);
          partsTotal += body.length + 1;
        }
        if (partsTotal > EXTRACT_TEXT_CAP) break;
      }
      return finish(parts.join('\n'), outline.slice(0, 100), mediaCount, partial);
    }
    if (kind === 'pptx' || kind === 'pptm') {
      const parts: string[] = [];
      const outline: string[] = [];
      let partial = false;
      const slides = idx.entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).slice(0, 500);
      slides.forEach((e, i) => {
        const sp = takePartial(e.name);
        if (!sp) { partial = true; return; }
        if (!sp.complete) partial = true;
        const xml = sp.xml;
        const texts: string[] = [];
        const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(xml)) !== null) texts.push(decodeEntities(t[1]));
        const body = texts.join('\n').replace(/[ \t]+/g, ' ').trim();
        if (!body) return;
        const title = body.split('\n', 1)[0].slice(0, 200);
        outline.push(`Slide ${i + 1}: ${title}`);
        parts.push(`# Slide ${i + 1}\n${body}`);
      });
      if (!parts.length) return null;
      return finish(parts.join('\n'), outline.slice(0, 100), mediaCount, partial);
    }
    if (kind === 'odt' || kind === 'ods' || kind === 'odp') {
      const cp = takePartial('content.xml');
      if (!cp) return null;
      const xml = cp.xml;
      const outline: string[] = [];
      const hRe = /<text:h\b[^>]*>([\s\S]*?)<\/text:h>/g;
      let m: RegExpExecArray | null;
      while ((m = hRe.exec(xml)) !== null) {
        const t = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
        if (t) outline.push(t.slice(0, 200));
        if (outline.length >= 100) break;
      }
      const text = decodeEntities(
        xml
          .replace(/<text:h\b[^>]*>([\s\S]*?)<\/text:h>/g, '\n## $1\n')
          .replace(/<text:p\b[^>]*>/g, '\n')
          .replace(/<table:table-row\b[^>]*>/g, '\n')
          .replace(/<[^>]+>/g, ''),
      ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const res = finish(text, outline, mediaCount);
      res.truncated = res.truncated || !cp.complete;
      return res;
    }
    return null;
  } catch {
    return null;
  }
}

function finish(text: string, outline: string[], images: number, partial = false): ExtractedDocument {
  const truncated = partial || text.length > EXTRACT_TEXT_CAP;
  const cut = text.length > EXTRACT_TEXT_CAP ? text.slice(0, EXTRACT_TEXT_CAP) + '\n…[truncated to 5MB]' : text;
  return { text: cut, outline, images, truncated };
}

/** Minimal RTF to text: control words out, \par/\line/\tab to breaks. Bounded. */
export function rtfToText(rtf: string): string {
  try {
    let s = rtf.slice(0, EXTRACT_TEXT_CAP + 1024);
    // Drop destination groups (fonttbl, colortbl, stylesheet, info, pict...).
    for (let i = 0; i < 5; i++) {
      const next = s.replace(/\{\\\*\\[a-z]+\b[^{}]*\{[^{}]*\}[^{}]*\}|\{\\(fonttbl|colortbl|stylesheet|info|pict|object|themedata)[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
      if (next === s) break;
      s = next;
    }
    s = s
      .replace(/\\par\b|\\line\b/g, '\n')
      .replace(/\\tab\b/g, ' ')
      .replace(/\\'[0-9a-fA-F]{2}/g, (m) => {
        try { return Buffer.from(m.slice(2), 'hex').toString('latin1'); } catch { return ''; }
      })
      .replace(/\\[a-z]+\d* ?/g, '')
      .replace(/[{}]/g, '');
    return decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

/** True while the limits table is honored (unit-tested constant). */
export function zipLimitsNote(): string {
  return `zip: max ${ZIP_LIMITS.maxEntries} entries, ${ZIP_LIMITS.maxTotalUncompressed / (1024 * 1024)}MB uncompressed, ${ZIP_LIMITS.maxRatio}:1 ratio`;
}
