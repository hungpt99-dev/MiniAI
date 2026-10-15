import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeAttachmentText, safeSlice } from '../../src/main/attachments/decode';
import { detectAttachment } from '../../src/main/attachments/detect';
import { decideAttachPolicy } from '../../src/main/attachments/policy';
import { decodeText, attachmentLogRecord } from '../../src/main/attachments';
import {
  scanSecretsText, maskSecretsText, looksLikeCredentialsFile,
} from '../../src/shared/attachments';
import {
  attachmentReadTool, registerRunAttachments, __resetAttachmentRefsForTests,
} from '../../src/main/agent/tools/attachment_tools';
import { fsReadTool } from '../../src/main/agent/tools/fs_read';
import { buildUserParts } from '../../src/main/ipc';
import { toOpenAIContent, fileRefText } from '../../src/main/ai/providers/vision';
import { ASK_SYSTEM_PROMPT } from '../../src/main/agent/prompts/ask';

// Fixtures generated in code — no personal files.
const utf16le = (s: string) => Buffer.from(s, 'utf16le');
const withBom16LE = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(s)]);
const withBom16BE = (s: string) => {
  const b = utf16le(s);
  for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
};
const cookieLine = '# Netscape HTTP Cookie File\n.ifg.udemy.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tabc123def456\n';

describe('decoding: every text encoding reads as text', () => {
  it('UTF-8, UTF-8 BOM, CRLF/LF', () => {
    expect(decodeAttachmentText(Buffer.from('hello\r\nworld\r\n', 'utf8'))?.text).toBe('hello\r\nworld\r\n');
    expect(decodeAttachmentText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]))?.encoding).toBe('UTF-8 BOM');
  });
  it('UTF-16 LE/BE with and without BOM', () => {
    expect(decodeAttachmentText(withBom16LE('hello world'))?.text).toBe('hello world');
    expect(decodeAttachmentText(withBom16BE('hello world'))?.text).toBe('hello world');
    expect(decodeAttachmentText(utf16le('hello world'))?.text).toBe('hello world');
    const be = utf16le('hello world');
    for (let i = 0; i < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
    expect(decodeAttachmentText(be)?.text).toBe('hello world');
  });
  it('Windows-1252, Shift-JIS, GBK, EUC-KR', () => {
    expect(decodeAttachmentText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))?.text).toContain('caf');
    expect(decodeAttachmentText(Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]))?.text).toContain('こんにちは');
    expect(decodeAttachmentText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))?.text).toContain('你好');
    expect(decodeAttachmentText(Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]))?.text).toBeTruthy();
  });
  it('tab-separated long lines read as text (never rejected for shape)', () => {
    const tsv = Buffer.from('a\tb\tc\t' + 'x'.repeat(5000) + '\n', 'utf8');
    expect(detectAttachment(tsv).kind).toBe('text');
    expect(decodeAttachmentText(tsv)?.text).toContain('xxxx');
  });
  it('a few NUL/invalid bytes are tolerated; true binary refused', () => {
    const few = Buffer.concat([Buffer.from('hello world, plenty of clean text here. ', 'utf8'), Buffer.from([0x00]), Buffer.from('more clean text.', 'utf8')]);
    expect(decodeAttachmentText(few)?.text).toContain('hello');
    expect(decodeAttachmentText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0x10, 0x00, 0x99]))).toBeNull();
  });
  it('empty file decodes to empty string', () => {
    expect(decodeAttachmentText(Buffer.alloc(0))?.text).toBe('');
  });
  it('16KB, 150KB and 300KB files decode with truncation only past 200KB', () => {
    for (const kb of [16, 150]) {
      const b = Buffer.from(('line ' + 'x'.repeat(60) + '\n').repeat(Math.ceil(kb * 1024 / 68)), 'utf8');
      const { text, truncated } = decodeText(b);
      expect(truncated).toBe(false);
      expect(text).toContain('line');
    }
    const big = Buffer.from('y'.repeat(300 * 1024), 'utf8');
    const r = decodeText(big);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('truncated to 200KB');
  });
});

describe('policy: decodable text is never reference_only', () => {
  const samples: Array<[string, Buffer]> = [
    ['utf8', Buffer.from('hello', 'utf8')],
    ['utf16-bom', withBom16LE('hello')],
    ['utf16-nobom', utf16le('hello world, enough text to score well here')],
    ['win1252', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20, 0x68, 0x65, 0x6c, 0x6c, 0x6f])],
    ['sjis', Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x20, 0x41])],
    ['cookie-tsv', Buffer.from(cookieLine.repeat(10), 'utf8')],
  ];
  for (const [name, buf] of samples) {
    it(`${name} -> inline_text`, () => {
      const det = detectAttachment(buf);
      expect(det.kind).toBe('text');
      expect(decideAttachPolicy(det).action).toBe('inline_text');
    });
  }
});

describe('provider request carries decoded UTF-8 text', () => {
  it('file_ref block contains the decoded string', () => {
    const { text } = decodeText(withBom16LE('cookie value 12345'));
    const parts = buildUserParts('what is in this file?', [{
      part: { type: 'file_ref', name: 'f.txt', mimeType: 'text/plain', size: 10, sha256: 'ab'.repeat(32), text },
      log: { name: 'f.txt', type: 'text/plain', size: 10, sha256: 'ab'.repeat(32) },
      ref: { id: 'a-1', name: 'f.txt', mime: 'text/plain', size: 10, sha256: 'ab'.repeat(32), path: '/tmp/f', kind: 'text' },
    }]);
    const content = toOpenAIContent(parts as unknown);
    expect(JSON.stringify(content)).toContain('cookie value 12345');
    expect(fileRefText('f.txt', 'text/plain', 10, 'ab'.repeat(32), text)).toContain('cookie value 12345');
  });
});

describe('chunked reads keep grapheme/surrogate pairs whole', () => {
  it('line ranges are correct and safeSlice never splits pairs', () => {
    const s = 'a😀b\nc😀d\nef\n';
    const lines = s.split('\n');
    expect(lines.slice(0, 2).join('\n')).toBe('a😀b\nc😀d');
    const cut = safeSlice('😀'.repeat(10), 0, 3);
    expect(cut).toBe('😀'.repeat(3));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
  });
  it('attachment_read returns line ranges', async () => {
    __resetAttachmentRefsForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-t-'));
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'l1\nl2\nl3\nl4\nl5\n');
    registerRunAttachments('r1', [{ id: 'a-1', name: 'a.txt', mime: 'text/plain', size: 15, sha256: 'ab'.repeat(32), path: p, kind: 'text' }]);
    const r = await attachmentReadTool.run({ runId: 'r1', id: 'a-1', startLine: 2, maxLines: 2 }) as { ok: boolean; output: string };
    expect(r.ok).toBe(true);
    expect(r.output).toContain('l2\nl3');
    expect(r.output).not.toContain('l4');
  });
});

describe('typed tool failures reach the model with exact codes', () => {
  it('attachment_read: NOT_FOUND / TEMP_COPY_MISSING / BINARY_CONTENT', async () => {
    __resetAttachmentRefsForTests();
    registerRunAttachments('r9', []);
    const nf = await attachmentReadTool.run({ runId: 'r9', id: 'nope' }) as { ok: boolean; output: string };
    expect(nf.ok).toBe(false);
    expect(nf.output).toMatch(/\[NOT_FOUND\]/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-t-'));
    registerRunAttachments('r9', [{ id: 'a-x', name: 'x.txt', mime: 'text/plain', size: 3, sha256: 'ab'.repeat(32), path: path.join(dir, 'gone.txt'), kind: 'text' }]);
    const tc = await attachmentReadTool.run({ runId: 'r9', id: 'a-x' }) as { ok: boolean; output: string };
    expect(tc.output).toMatch(/\[TEMP_COPY_MISSING\]/);
    const bp = path.join(dir, 'b.bin');
    fs.writeFileSync(bp, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0x10, 0x00, 0x99, 0x00, 0x77]));
    registerRunAttachments('r9', [{ id: 'a-b', name: 'b.txt', mime: 'application/octet-stream', size: 12, sha256: 'cd'.repeat(32), path: bp, kind: 'file' }]);
    const bin = await attachmentReadTool.run({ runId: 'r9', id: 'a-b' }) as { ok: boolean; output: string };
    expect(bin.output).toMatch(/\[BINARY_CONTENT\]/);
  });
  it('fs_read: UTF-16 reads; binary refused; missing is NOT_FOUND; prompt forbids guessing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-t-'));
    const p = path.join(dir, 'u.txt');
    fs.writeFileSync(p, withBom16LE('utf16 content here'));
    const ok = await fsReadTool.run({ path: p }) as { ok: boolean; output: string };
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('utf16 content here');
    const miss = await fsReadTool.run({ path: path.join(dir, 'no.txt') }) as { ok: boolean; output: string };
    expect(miss.output).toMatch(/\[NOT_FOUND\]/);
    expect(ASK_SYSTEM_PROMPT).toContain('exact reason');
    expect(ASK_SYSTEM_PROMPT).toContain('Never say you read a file unless the tool returned its content');
  });
});

describe('secrets: masking stays useful, mostly-credentials flagged, cookie hint fires', () => {
  it('masking keeps context and reports the count', () => {
    const { masked, matches, hiddenRatio } = maskSecretsText('api_key: sk-abcdefghijklmnopqrstuvwx\nplain notes here\n');
    expect(matches).toBeGreaterThan(0);
    expect(masked).toContain('plain notes here');
    expect(masked).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(hiddenRatio).toBeLessThan(0.5);
  });
  it('cookie-style files trigger the caution by header and by name', () => {
    expect(looksLikeCredentialsFile('ifg.udemy.com_14-10-2026.txt', cookieLine)).toBe(true);
    expect(looksLikeCredentialsFile('site_cookies.txt', 'plain')).toBe(true);
    expect(looksLikeCredentialsFile('notes.txt', 'plain text')).toBe(false);
    expect(scanSecretsText(cookieLine)).toBe(false); // hint fires even without a secret match
  });
  it('log records never carry content', () => {
    const rec = attachmentLogRecord({ name: 'c.txt', mime: 'text/plain', size: 5, sha256: 'ab'.repeat(32) });
    expect(JSON.stringify(rec)).not.toContain('sessionid');
    expect(Object.keys(rec).sort()).toEqual(['name', 'sha256', 'size', 'type']);
  });
});

describe('layout rules in the same screenshot', () => {
  const root = path.join(__dirname, '..', '..');
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  it('search input flexes with 220px floor; placeholder single-line ellipsis', () => {
    expect(css).toContain('min-width: 220px');
    expect(css).toContain('#input::placeholder { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }');
    expect(js).toContain('Ask or do…');
  });
  it('folder chip capped with middle ellipsis and full-path tooltip', () => {
    expect(css).toContain('#agent-cwd { flex: none; max-width: 180px;');
    expect(js).toContain('…/');
    expect(js).toContain('chip.title = agentCwd');
  });
  it('attachment chip is one 32px line; answer stays 400/15px/1.5', () => {
    expect(css).toContain('border-radius: 10px; height: 32px;');
    expect(css).toContain('.attach-chip .aname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;');
    expect(css).toContain('.attach-chip .asz { font-size: 12px; color: var(--muted); flex: none; white-space: nowrap; }');
    expect(css).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.5; font-weight: 400;');
  });
  it('chip preview offers Open folder; credential files get a caution', () => {
    expect(js).toContain('Open folder');
    expect(js).toContain('looksLikeCredentialsFile');
  });
});
