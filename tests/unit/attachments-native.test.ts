import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAttachments } from '../../src/main/ipc';
import { classifyAttachment } from '../../src/main/attachments';
import { PROVIDER_ADAPTERS } from '../../src/main/ai/providers/index';
import {
  getAttachmentCapabilities, assertAttachments, UnsupportedAttachmentError,
} from '../../src/main/ai/providers/attachments';
import { toOpenAIContent, toAnthropicContent } from '../../src/main/ai/providers/vision';

const prevDataDir = process.env.NEXIO_DATA_DIR;
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-native-'));
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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n', 'utf8');
const pdfB64 = PDF.toString('base64');

/** Minimal stored (uncompressed) OOXML zip: enough for magic-byte detection. */
function ooXml(files: Array<[string, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 16);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += lh.length + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
const docxBuf = () => ooXml([
  ['[Content_Types].xml', Buffer.from('<Types/>')],
  ['word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>')],
]);
const docPart = (size = PDF.length) => ({
  type: 'document' as const, name: 'r.pdf', mimeType: 'application/pdf', size, sha256: 's', dataBase64: pdfB64,
});
const imgPart = () => ({
  type: 'image' as const, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', bytes: 4,
});

describe('attachment capability map', () => {
  it('sends images + PDFs natively on openai/anthropic/gemini, images-only on compatible', () => {
    for (const p of ['openai', 'anthropic', 'gemini'] as const) {
      const caps = getAttachmentCapabilities(p, 'm', PROVIDER_ADAPTERS[p].capabilitiesFor('m'));
      expect(caps.images).not.toBeNull();
      expect(caps.documents.map((d) => d.mime)).toContain('application/pdf');
    }
    const compat = getAttachmentCapabilities('compatible', 'm', PROVIDER_ADAPTERS.compatible.capabilitiesFor('m'));
    expect(compat.images).not.toBeNull();
    expect(compat.documents).toEqual([]);
  });
  it('non-vision models get no native types at all', () => {
    const caps = getAttachmentCapabilities('openai', 'gpt-3.5-turbo', PROVIDER_ADAPTERS.openai.capabilitiesFor('gpt-3.5-turbo'));
    expect(caps.images).toBeNull();
    expect(caps.documents).toEqual([]);
  });
});

describe('native PDF send path (no extraction, no OCR)', () => {
  it('prepareAttachments emits the original bytes as a document part', () => {
    const out = prepareAttachments('c1', [{ name: 'r.pdf', dataBase64: pdfB64 }], dir, ctxOf(dir), { provider: 'anthropic' });
    expect(out.length).toBe(1);
    expect(out[0].part).toMatchObject({ type: 'document', mimeType: 'application/pdf', size: PDF.length });
    expect((out[0].part as { dataBase64: string }).dataBase64).toBe(pdfB64);
    expect(JSON.stringify(out[0].part)).not.toContain('Extracted from');
  });
  it('classifyAttachment marks PDFs native without reading their text', () => {
    const c = classifyAttachment(PDF, 'r.pdf');
    expect(c.docState).toBe('native');
    expect(c.extractedText).toBeUndefined();
  });
  it('anthropic maps the document part to a base64 document block', () => {
    const content = toAnthropicContent([{ type: 'text', text: 'read' }, docPart()]) as Array<Record<string, unknown>>;
    const doc = content.find((b) => b.type === 'document') as { source: { type: string; media_type: string; data: string } };
    expect(doc.source).toMatchObject({ type: 'base64', media_type: 'application/pdf', data: pdfB64 });
    const built = PROVIDER_ADAPTERS.anthropic.buildRequest('claude-sonnet-4-20250514', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, docPart()] }],
      maxOutputTokens: 16, stream: false,
    });
    expect(JSON.stringify(built.body)).toContain('"document"');
  });
  it('openai + gemini map the document part to a file content part (Chat Completions shape)', () => {
    for (const p of ['openai', 'gemini'] as const) {
      const content = toOpenAIContent([{ type: 'text', text: 'read' }, docPart()]) as Array<Record<string, unknown>>;
      const file = content.find((b) => b.type === 'file') as { file: { filename: string; file_data: string } };
      expect(file.file.filename).toBe('r.pdf');
      expect(file.file.file_data).toBe(`data:application/pdf;base64,${pdfB64}`);
      const model = p === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash';
      const built = PROVIDER_ADAPTERS[p].buildRequest(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, docPart()] }],
        maxOutputTokens: 16, stream: false,
      });
      expect(JSON.stringify(built.body)).toContain('"file_data"');
    }
  });
  it('images still ride data URLs; text still rides inline text (BOM-decoded, truncated)', () => {
    const img = prepareAttachments('c1', [{
      name: 'p.png',
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64'),
    }], dir, ctxOf(dir), { provider: 'openai' });
    expect(img[0].part.type).toBe('image');
    const txt = prepareAttachments('c1', [{ name: 'n.txt', dataBase64: Buffer.from('hello').toString('base64') }], dir, ctxOf(dir), { provider: 'openai' });
    expect(txt[0].part).toMatchObject({ type: 'file_ref' });
    expect((txt[0].part as { text: string }).text).toContain('hello');
  });
});

describe('unsupported types fail before sending (never silent extraction)', () => {
  it.each([
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic'],
    ['gemini', 'Gemini'],
    ['compatible', 'Custom'],
  ])('%s refuses .docx with a named notice', (provider, label) => {
    const req = {
      messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'r' }, { ...docPart(), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'c.docx' }] }],
      maxOutputTokens: 16, stream: false,
    };
    const caps = getAttachmentCapabilities(provider, 'm', PROVIDER_ADAPTERS[provider as 'openai'].capabilitiesFor('m'));
    expect(() => assertAttachments(req, caps)).toThrow(UnsupportedAttachmentError);
    expect(() => assertAttachments(req, caps)).toThrow(`${label} can't read .docx directly`);
  });
  it('compatible refuses even PDFs (images only)', () => {
    const caps = getAttachmentCapabilities('compatible', 'm', PROVIDER_ADAPTERS.compatible.capabilitiesFor('m'));
    const req = {
      messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'r' }, docPart()] }],
      maxOutputTokens: 16, stream: false,
    };
    expect(() => assertAttachments(req, caps)).toThrow(UnsupportedAttachmentError);
    expect(() => PROVIDER_ADAPTERS.compatible.buildRequest('m', { ...req, imageMode: 'on' })).toThrow(UnsupportedAttachmentError);
  });
  it('prepareAttachments refuses office files with the same notice (bytes never extracted)', () => {
    let err = '';
    try {
      prepareAttachments('c1', [{ name: 'c.docx', dataBase64: docxBuf().toString('base64') }], dir, ctxOf(dir), { provider: 'openai' });
    } catch (e) { err = (e as Error).message; }
    expect(err).toBe("OpenAI can't read .docx directly");
  });
});

describe('limits count base64 inflation and fail with the limit named', () => {
  it('over-limit file refuses before sending', () => {
    expect(() => prepareAttachments('c1', [{ name: 'big.pdf', size: 21 * 1024 * 1024 }], dir, ctxOf(dir), { provider: 'openai' }))
      .toThrow(/max 20MB per file/);
  });
  it('over-limit total refuses before sending', () => {
    const files = [1, 2, 3].map((i) => ({ name: `f${i}.pdf`, size: 20 * 1024 * 1024 }));
    expect(() => prepareAttachments('c1', files, dir, ctxOf(dir), { provider: 'openai' }))
      .toThrow(/max 50MB total/);
  });
  it('provider request-size cap counts ~33% base64 inflation', () => {
    // 2 x 20MB PDFs = 40MB raw -> ~53MB encoded > 32MB Anthropic request cap.
    const big = { ...docPart(20 * 1024 * 1024), dataBase64: 'AAAA' };
    const req = {
      messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'r' }, big, { ...big }] }],
      maxOutputTokens: 16, stream: false,
    };
    const caps = getAttachmentCapabilities('anthropic', 'm', PROVIDER_ADAPTERS.anthropic.capabilitiesFor('m'));
    expect(() => assertAttachments(req, caps)).toThrow(/request size cap/);
  });
});

describe('missing temp files send the rest with a note', () => {
  it('deleted path becomes an unavailable note; other files still send natively', () => {
    const gone = path.join(dir, 'gone.pdf');
    const out = prepareAttachments('c1', [
      { name: 'gone.pdf', path: gone },
      { name: 'r.pdf', dataBase64: pdfB64 },
    ], dir, ctxOf(dir), { provider: 'openai' });
    expect(out.length).toBe(2);
    expect((out[0].part as { text: string }).text).toContain('attachment no longer available: gone.pdf');
    expect(out[1].part.type).toBe('document');
  });
});

describe('logs and errors never carry file content', () => {
  it('log records keep name/type/size/SHA256 only', () => {
    const out = prepareAttachments('c1', [{ name: 'r.pdf', dataBase64: pdfB64 }], dir, ctxOf(dir), { provider: 'openai' });
    expect(Object.keys(out[0].log).sort()).toEqual(['name', 'sha256', 'size', 'type']);
    expect(JSON.stringify(out[0].log)).not.toContain(pdfB64.slice(0, 20));
    expect(JSON.stringify(out[0].log)).not.toContain('data:');
  });
  it('unsupported errors carry names only, never bytes', () => {
    const caps = getAttachmentCapabilities('openai', 'm', PROVIDER_ADAPTERS.openai.capabilitiesFor('m'));
    const req = {
      messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'r' }, { ...docPart(), mimeType: 'application/zip', name: 'a.zip' }] }],
      maxOutputTokens: 16, stream: false,
    };
    let err = '';
    try { assertAttachments(req, caps); } catch (e) { err = (e as Error).message; }
    expect(err).toBe("OpenAI can't read .zip directly");
    expect(err).not.toContain('AAAA');
  });
});

describe('renderer: unsupported notice reuses the Switch-model flow', () => {
  it("matches can't-read notices and confirms before switching", () => {
    const src = fs.readFileSync('src/renderer/app.js', 'utf8');
    expect(src).toContain("t.indexOf(\"can't read\")");
    expect(src).toContain('Switch model to OpenAI gpt-4o-mini and re-attach the file?');
    expect(src).toContain("t('attach.chip.unsupported')");
  });
  it('stages the unsupported flag from the picker', () => {
    const src = fs.readFileSync('src/renderer/app.js', 'utf8');
    expect(src).toContain('unsupportedType: r.unsupportedType');
  });
});
