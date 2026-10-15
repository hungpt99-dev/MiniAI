import fs from 'node:fs';
import type { Tool } from '../types';
import { platform } from '../../platform/index';
import { decodeAttachmentText } from '../../attachments/decode';

const HARD_CAP_BYTES = 200_000;

export const fsReadTool: Tool = {
  name: 'fs_read',
  description: 'Read a text file (size-capped, encodings auto-detected). Truly binary files are rejected with BINARY_CONTENT. Report the exact failure reason given.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to read' },
      maxBytes: { type: 'number', description: 'Max bytes to return (default 20000)' },
    },
    required: ['path'],
  },
  risk: 'read',
  askSafe: true,
  describe: (input) => `Read file ${String(input.path || '')}`,
  run: async (input) => {
    const p = String(input.path || '');
    const max = Math.min(Number(input.maxBytes) || 20_000, HARD_CAP_BYTES);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { ok: false, output: `[NOT_FOUND] ${platform().fsErrorHint('read', e) || `cannot stat: ${p}`}` };
    }
    if (!st.isFile()) return { ok: false, output: `[NOT_FOUND] not a file: ${p}` };
    if (st.size > HARD_CAP_BYTES * 5) return { ok: false, output: `[TOO_LARGE] file too large (${st.size} bytes, max ${HARD_CAP_BYTES * 5})` };
    let buf: Buffer;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        buf = Buffer.alloc(Math.min(st.size, max) + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        buf = buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, output: `[PERMISSION_DENIED] ${platform().fsErrorHint('read', e) || `read failed: ${(e as Error).message}`}` };
      if (code === 'EBUSY') return { ok: false, output: `[FILE_LOCKED] file locked: ${p}` };
      return { ok: false, output: `[NOT_FOUND] ${platform().fsErrorHint('read', e) || `read failed: ${(e as Error).message}`}` };
    }
    const dec = decodeAttachmentText(buf);
    if (!dec || !dec.text.trim()) return { ok: false, output: '[BINARY_CONTENT] binary file, refusing to read as text' };
    const text = dec.text;
    const truncated = st.size > max ? `\n…[truncated ${st.size - max} of ${st.size} bytes — ${dec.encoding}]` : '';
    return { ok: true, output: text.slice(0, max) + truncated, source: p, untrusted: true };
  },
};
