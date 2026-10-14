import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
import {
  detectAttachment, readZipIndex, ZIP_LIMITS, mimeForKind,
} from '../../src/main/attachments/detect';
import { decideAttachPolicy, formatRejection, EXTRACTABLE } from '../../src/main/attachments/policy';
import { extractDocumentText, rtfToText, EXTRACT_TEXT_CAP } from '../../src/main/attachments/extract';
import { classifyAttachment } from '../../src/main/attachments';

// ---------- minimal ZIP builder (stored or deflated, optional forged sizes) ----------
interface ZipSrc { name: string; data: Buffer; method?: 0 | 8; forgeUncomp?: number }
function zipBuild(entries: ZipSrc[]): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 0;
    const comp = method === 8 ? zlib.deflateSync(e.data) : e.data;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 16);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.forgeUncomp ?? e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    files.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.forgeUncomp ?? e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length ? entries.length : 0, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, cd, eocd]);
}

const CT = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="w"/></Types>`;
const DOC_XML = `<w:document xmlns:w="http://x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Curriculum Vitae</w:t></w:r></w:p><w:p><w:r><w:t>Pham Thanh Hung, senior engineer</w:t></w:r></w:p></w:body></w:document>`;
const WB_XML = `<workbook xmlns:r="http://x"><sheets><sheet name="Skills" r:id="rId1"/></sheets></workbook>`;
const RELS_XML = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
const SHARED_XML = `<sst><si><t>Python</t></si><si><t>Go</t></si></sst>`;
const SHEET_XML = `<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>5</v></c><c t="inlineStr"><is><t>TypeScript</t></is></c></row></sheetData></worksheet>`;
const SLIDE_XML = `<p:sld><p:cSld><p:sp><a:t xmlns:a="http://x">Title One</a:t></p:sp><p:sp><a:t xmlns:a="http://x">Body text here</a:t></p:sp></p:cSld></p:sld>`;
const ODT_CONTENT = `<office:document-content><office:body><office:text><text:h>Career</text:h><text:p>Ten years of engineering</text:p></office:text></office:body></office:document-content>`;

function docxBuf(extra: ZipSrc[] = []): Buffer {
  return zipBuild([{ name: '[Content_Types].xml', data: Buffer.from(CT) }, { name: 'word/document.xml', data: Buffer.from(DOC_XML) }, ...extra]);
}
function oleBuf(markers: Buffer[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0xe011cfd0, 0); head.writeUInt32LE(0xe11ab1a1, 4);
  return Buffer.concat([head, Buffer.alloc(2048), ...markers, Buffer.alloc(2048)]);
}
const utf16le = (s: string) => Buffer.from(s, 'utf16le');

describe('zip index reader', () => {
  it('reads entries, skips traversal names, flags ratio bombs without allocating', () => {
    const z = zipBuild([
      { name: 'ok.txt', data: Buffer.from('hi') },
      { name: '../evil.txt', data: Buffer.from('x') },
      { name: '/abs.txt', data: Buffer.from('x') },
    ]);
    const idx = readZipIndex(z);
    expect(idx.entries.map((e) => e.name)).toEqual(['ok.txt']);
    expect(idx.skippedTraversal).toBe(true);
    expect(idx.corrupt).toBe(false);
  });
  it('trips the ratio guard on metadata alone', () => {
    const data = Buffer.alloc(300_000, 0);
    const z = zipBuild([{ name: 'bomb.bin', data, method: 8, forgeUncomp: 300 * 150 }]);
    // real compressed size is tiny; the forged header claims 150:1
    const idx = readZipIndex(z);
    expect(idx.truncated).toBe(true);
    expect(idx.totalUncompressed).toBeLessThan(1024 * 1024); // nothing inflated
  });
  it('marks missing EOCD corrupt without throwing', () => {
    expect(readZipIndex(Buffer.from('PK\x03\x04garbage'))).toMatchObject({ corrupt: true });
    expect(readZipIndex(Buffer.alloc(0)).corrupt).toBe(true);
  });
});

describe('detection kinds', () => {
  const cases: Array<[string, Buffer, string, string[]]> = [
    ['docx', docxBuf(), 'docx', []],
    ['docm', docxBuf([{ name: 'word/vbaProject.bin', data: Buffer.from('fake-macro') }]), 'docm', ['macros']],
    ['xlsx', zipBuild([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'xl/workbook.xml', data: Buffer.from(WB_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS_XML) },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(SHARED_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(SHEET_XML) },
    ]), 'xlsx', []],
    ['pptx', zipBuild([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'ppt/presentation.xml', data: Buffer.from('<p:presentation/>') },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(SLIDE_XML) },
    ]), 'pptx', []],
    ['odt', zipBuild([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text') },
      { name: 'content.xml', data: Buffer.from(ODT_CONTENT) },
    ]), 'odt', []],
    ['epub', zipBuild([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from('<c/>') },
    ]), 'epub', []],
    ['zip', zipBuild([{ name: 'a.txt', data: Buffer.from('hello') }]), 'zip', []],
    ['jar', zipBuild([{ name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0') }, { name: 'com/A.class', data: Buffer.from('cafebabe', 'hex') }]), 'jar', ['executable']],
    ['apk', zipBuild([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }]), 'apk', ['executable']],
    ['doc', oleBuf([utf16le('WordDocument')]), 'doc', []],
    ['doc+macros', oleBuf([utf16le('WordDocument'), utf16le('VBA')]), 'doc', ['macros']],
    ['xls', oleBuf([utf16le('Workbook')]), 'xls', []],
    ['ppt', oleBuf([utf16le('PowerPoint Document')]), 'ppt', []],
    ['office-encrypted', oleBuf([Buffer.from('EncryptedPackage')]), 'office-encrypted', ['encrypted']],
    ['msi', oleBuf([Buffer.from('Windows Installer')]), 'msi', ['executable']],
    ['pe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 'exe', ['executable']],
    ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'elf', ['executable']],
    ['macho-le64', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), 'macho', ['executable']],
    ['macho-fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]), 'macho', ['executable']],
    ['lnk', Buffer.from([0x4c, 0, 0, 0, 1, 0x14, 2, 0]), 'lnk', ['executable']],
    ['shebang', Buffer.from('#!/bin/bash\necho hi\n'), 'text', []],
    ['utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]), 'text', []],
    ['utf16', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('hello world')]), 'text', []],
    ['url', Buffer.from('[InternetShortcut]\nURL=https://example.com\n'), 'url', []],
    ['scf', Buffer.from('[Shell]\nCommand=2\n'), 'scf', []],
    ['pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\n'), 'pdf', []],
    ['pdf-encrypted', Buffer.from('%PDF-1.4\n1 0 obj\n<</Encrypt 2 0 R>>\n'), 'pdf', ['encrypted']],
    ['rtf', Buffer.from('{\\rtf1\\ansi Hello\\par World}'), 'rtf', []],
    ['7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]), 'archive', []],
    ['rar', Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0]), 'archive', []],
    ['gzip', Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]), 'archive', []],
    ['mp3', Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]), 'mp3', []],
    ['mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(16)]), 'mp4', []],
    ['bmp', Buffer.from([0x42, 0x4d, 0, 0, 0, 0]), 'bmp', []],
    ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png', []],
    ['dmg', Buffer.concat([Buffer.alloc(600, 7), Buffer.from('koly'), Buffer.alloc(100)]), 'dmg', []],
    ['pkg', Buffer.from([0x78, 0x61, 0x72, 0x21, 0, 0, 0, 0]), 'pkg', []],
    ['appx', zipBuild([{ name: 'AppxManifest.xml', data: Buffer.from('<pkg/>') }]), 'appx', ['executable']],
    ['empty', Buffer.alloc(0), 'empty', []],
  ];
  it.each(cases)('%s detects as %s', (_label, buf, kind, flags) => {
    const d = detectAttachment(buf);
    expect(d.kind).toBe(kind);
    expect(d.flags).toEqual(flags);
    expect(d.mime.length).toBeGreaterThan(0);
    expect(d.evidence.length).toBeGreaterThan(0);
  });
  it('never throws on random bytes', () => {
    for (let i = 0; i < 50; i++) {
      const n = Math.floor(Math.random() * 300);
      const b = Buffer.alloc(n);
      for (let j = 0; j < n; j++) b[j] = Math.floor(Math.random() * 256);
      const d = detectAttachment(b);
      expect(typeof d.kind).toBe('string');
    }
  });
  it('renamed executable still detects as exe', () => {
    const d = detectAttachment(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]));
    expect(d.kind).toBe('exe');
    expect(d.flags).toContain('executable');
  });
});

describe('policy table', () => {
  it('routes kinds to actions', () => {
    const action = (kind: string, flags: string[] = []) =>
      decideAttachPolicy({ kind: kind as never, mime: 'x', flags: flags as never[], evidence: 't', confidence: 'high' }).action;
    expect(action('text')).toBe('inline_text');
    expect(action('png')).toBe('image');
    expect(action('docx')).toBe('document_extract');
    expect(action('xlsx')).toBe('document_extract');
    expect(action('odt')).toBe('document_extract');
    expect(action('rtf')).toBe('document_extract');
    expect(action('pdf')).toBe('reference_only');
    expect(action('epub')).toBe('reference_only');
    expect(action('zip')).toBe('reference_only');
    expect(action('doc')).toBe('reference_only');
    expect(action('mp3')).toBe('reference_only');
    expect(action('dmg')).toBe('reference_only');
    expect(action('unknown')).toBe('reference_only');
    expect(action('docx', ['macros'])).toBe('reference_only');
    expect(action('pdf', ['encrypted'])).toBe('reference_only');
    expect(action('exe', ['executable'])).toBe('reject');
    expect(action('jar', ['executable'])).toBe('reject');
    expect(action('apk', ['executable'])).toBe('reject');
    expect(action('appx', ['executable'])).toBe('reject');
    expect(action('pkg', [])).toBe('reference_only');
    expect(action('lnk', ['executable'])).toBe('reject');
  });
  it('rejection messages are specific and kind, with Details', () => {
    const msg = formatRejection(
      'notes.docx',
      { kind: 'exe', mime: 'x', flags: ['executable'], evidence: 'MZ header', confidence: 'high' },
      { action: 'reject', rule: 'executable-deny' },
    );
    expect(msg).toBe('Not attached: notes.docx is an executable (Windows program).\nDetails: detected exe (MZ header), rule executable-deny.');
    expect(msg).not.toMatch(/executable or unknown/);
    expect(EXTRACTABLE.has('docx')).toBe(true);
    expect(EXTRACTABLE.has('pdf')).toBe(false);
  });
});

describe('extractor', () => {
  it('reads docx text + headings, counts media, ignores everything else', () => {
    const ext = extractDocumentText(docxBuf([{ name: 'word/media/image1.png', data: Buffer.alloc(10) }]), 'docx');
    expect(ext).not.toBeNull();
    expect(ext!.text).toMatch(/Curriculum Vitae/);
    expect(ext!.text).toMatch(/Pham Thanh Hung, senior engineer/);
    expect(ext!.outline).toEqual(['Curriculum Vitae']);
    expect(ext!.images).toBe(1);
  });
  it('reads xlsx sheets + values with outline of sheet names', () => {
    const ext = extractDocumentText(zipBuild([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'xl/workbook.xml', data: Buffer.from(WB_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS_XML) },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(SHARED_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(SHEET_XML) },
    ]), 'xlsx');
    expect(ext!.text).toMatch(/Python/);
    expect(ext!.text).toMatch(/TypeScript/);
    expect(ext!.outline).toEqual(['Skills']);
  });
  it('reads pptx slides with titles', () => {
    const ext = extractDocumentText(zipBuild([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'ppt/presentation.xml', data: Buffer.from('<p:presentation/>') },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(SLIDE_XML) },
    ]), 'pptx');
    expect(ext!.text).toMatch(/Title One/);
    expect(ext!.outline).toEqual(['Slide 1: Title One']);
  });
  it('reads odt and rtf', () => {
    const odt = extractDocumentText(zipBuild([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text') },
      { name: 'content.xml', data: Buffer.from(ODT_CONTENT) },
    ]), 'odt');
    expect(odt!.text).toMatch(/Ten years of engineering/);
    expect(odt!.outline).toEqual(['Career']);
    expect(rtfToText('{\\rtf1\\ansi Hello\\par World}')).toBe('Hello\nWorld');
  });
  it('caps huge documents without hanging', () => {
    const big = Buffer.from(`<w:document><w:body>${'<w:p><w:r><w:t>word </w:t></w:r></w:p>'.repeat(300_000)}</w:body></w:document>`);
    const t0 = Date.now();
    const ext = extractDocumentText(zipBuild([
      { name: '[Content_Types].xml', data: Buffer.from(CT) },
      { name: 'word/document.xml', data: big },
    ]), 'docx');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(ext!.truncated).toBe(true);
    expect(ext!.text.length).toBeLessThanOrEqual(EXTRACT_TEXT_CAP + 100);
  });
  it('extracts macro files as text without executing anything', () => {
    const ext = extractDocumentText(docxBuf([{ name: 'word/vbaProject.bin', data: Buffer.from('MZ-fake-macro-payload') }]), 'docm');
    expect(ext!.text).toMatch(/Curriculum Vitae/);
    expect(ext!.text).not.toMatch(/fake-macro-payload/);
  });
  it('returns null for missing parts and corrupt zips', () => {
    expect(extractDocumentText(zipBuild([{ name: 'a.txt', data: Buffer.from('x') }]), 'docx')).toBeNull();
    expect(extractDocumentText(Buffer.from('PK\x03\x04junk'), 'docx')).toBeNull();
  });
});

describe('send path: prepareAttachments end to end', () => {
  const prevDataDir = process.env.NEXIO_DATA_DIR;
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-docsend-'));
    process.env.NEXIO_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.NEXIO_DATA_DIR;
    else process.env.NEXIO_DATA_DIR = prevDataDir;
  });
  const ctxOf = (cwd: string) => ({
    allowedRoots: [cwd], explicitRoots: [] as string[], alwaysAllow: [] as never[],
    requireApprovalForWrites: true, homeDir: os.homedir(),
  });
  it('attaches SHDS-CV-PhamThanhHung.docx with extracted text (Unicode-safe name)', async () => {
    const { prepareAttachments } = await import('../../src/main/ipc');
    const out = prepareAttachments('conv1', [{
      name: 'SHDS-CV-PhamThanhHung.docx',
      dataBase64: docxBuf([{ name: 'word/media/image1.png', data: Buffer.alloc(10) }]).toString('base64'),
    }], dir, ctxOf(dir));
    expect(out.length).toBe(1);
    expect(out[0].part.type).toBe('file_ref');
    const text = (out[0].part as { text: string }).text;
    expect(text).toMatch(/Curriculum Vitae/);
    expect(text).toMatch(/Pham Thanh Hung, senior engineer/);
    expect(text).toMatch(/\[Extracted from SHDS-CV-PhamThanhHung.docx \(docx\)\]/);
    expect(out[0].ref.kind).toBe('text');
    expect(out[0].ref.name).toBe('SHDS-CV-PhamThanhHung.docx');
  });
  it('rejects a renamed exe with the specific executable message', async () => {
    const { prepareAttachments } = await import('../../src/main/ipc');
    let err = '';
    try {
      prepareAttachments('conv1', [{
        name: 'notes.docx', dataBase64: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)]).toString('base64'),
      }], dir, ctxOf(dir));
    } catch (e) { err = (e as Error).message; }
    expect(err).toBe('Not attached: notes.docx is an executable (Windows program).\nDetails: detected exe (MZ header), rule executable-deny.');
  });
  it('keeps zips, macro docs and encrypted PDFs as reference with notes', async () => {
    const { prepareAttachments } = await import('../../src/main/ipc');
    const zip = prepareAttachments('conv1', [{
      name: 'a.zip', dataBase64: zipBuild([{ name: 'a.txt', data: Buffer.from('hi') }]).toString('base64'),
    }], dir, ctxOf(dir));
    expect(zip[0].ref.kind).toBe('file');
    expect((zip[0].part as { text: string }).text).toMatch(/name and path but not its contents/);
    const docm = prepareAttachments('conv1', [{
      name: 'r.docm', dataBase64: docxBuf([{ name: 'word/vbaProject.bin', data: Buffer.from('x') }]).toString('base64'),
    }], dir, ctxOf(dir));
    expect((docm[0].part as { text: string }).text).toMatch(/will not run it/);
    const enc = prepareAttachments('conv1', [{
      name: 'r.pdf', dataBase64: Buffer.from('%PDF-1.4\n<</Encrypt 1 0 R>>').toString('base64'),
    }], dir, ctxOf(dir));
    expect((enc[0].part as { text: string }).text).toMatch(/Encrypted\. Contents not readable/);
  });
  it('Do-side attachment_read serves extracted text in chunks', async () => {
    const { prepareAttachments } = await import('../../src/main/ipc');
    const { attachmentReadTool, registerRunAttachments, __resetAttachmentRefsForTests } = await import('../../src/main/agent/tools/attachment_tools');
    __resetAttachmentRefsForTests();
    const out = prepareAttachments('run9', [{
      name: 'cv.docx', dataBase64: docxBuf().toString('base64'),
    }], dir, ctxOf(dir));
    registerRunAttachments('run9', out.map((p) => p.ref));
    const first = await attachmentReadTool.run({ runId: 'run9', id: out[0].ref.id, maxBytes: 20 }, { signal: new AbortController().signal, cwd: dir });
    expect(first.ok).toBe(true);
    expect(first.output).toMatch(/truncated/);
    const full = await attachmentReadTool.run({ runId: 'run9', id: out[0].ref.id }, { signal: new AbortController().signal, cwd: dir });
    expect(full.output).toMatch(/Curriculum Vitae/);
    __resetAttachmentRefsForTests();
  });
});

describe('renderer: chips, Details toggle, preview', () => {
  const root = path.join(__dirname, '..', '..');
  const appJs = () => fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  it('showError splits Details into a toggle with aria state', () => {
    const src = appJs();
    expect(src).toContain("indexOf('\\nDetails: ')");
    expect(src).toContain('adetails');
    expect(src).toContain("aria-expanded', 'false'");
  });
  it('chips render extracted/reference/macros/encrypted badges with tooltips', () => {
    const src = appJs();
    expect(src).toContain("a.docState === 'extracted' ? 'Extracted'");
    expect(src).toContain("a.docState === 'macros' ? 'Macros'");
    expect(src).toContain('Nexio can see the file name and path but not its contents.');
    expect(src).toContain("docState: r.docState, docNote: r.docNote, details: r.details, preview: r.preview");
  });
  it('preview shows the doc note and first lines', () => {
    const src = appJs();
    expect(src).toContain('a.docNote');
    expect(src).toContain('String(a.preview).slice(0, 500)');
  });
  it('badge + details styles exist', () => {
    const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
    expect(css).toContain('.abadge.acc');
    expect(css).toContain('pre.adetails');
  });
});
describe('classify pipeline', () => {
  it('accepts a real docx for extraction, rejects a renamed exe specifically', () => {
    const ok = classifyAttachment(docxBuf(), 'SHDS-CV-PhamThanhHung.docx');
    expect(ok.decision.action).toBe('document_extract');
    expect(ok.extractedText).toMatch(/Curriculum Vitae/);
    expect(ok.mime).toMatch(/wordprocessingml/);
    const bad = classifyAttachment(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)]), 'notes.docx');
    expect(bad.decision.action).toBe('reject');
    expect(bad.decision.rule).toBe('executable-deny');
  });
  it('flags macros and encrypted files as reference with notes', () => {
    const m = classifyAttachment(docxBuf([{ name: 'word/vbaProject.bin', data: Buffer.from('x') }]), 'r.docm');
    expect(m.docState).toBe('macros');
    expect(m.decision.action).toBe('reference_only');
    const e = classifyAttachment(oleBuf([Buffer.from('EncryptedPackage')]), 'r.docx');
    expect(e.docState).toBe('encrypted');
    const p = classifyAttachment(Buffer.from('%PDF-1.4\n<</Encrypt 1 0 R>>'), 'r.pdf');
    expect(p.docState).toBe('encrypted');
  });
  it('unknown bytes become reference_only, never reject', () => {
    const u = classifyAttachment(Buffer.from([0, 1, 2, 3, 255, 254, 253, 128, 129, 130]), 'blob.bin');
    expect(u.det.kind).toBe('unknown');
    expect(u.decision.action).toBe('reference_only');
  });
  it('zip limits constants are sane', () => {
    expect(ZIP_LIMITS.maxEntries).toBe(10_000);
    expect(ZIP_LIMITS.maxTotalUncompressed).toBe(500 * 1024 * 1024);
    expect(ZIP_LIMITS.maxRatio).toBe(100);
  });
});
