import fs from 'node:fs';
import type { Tool } from '../types';
import { platform } from '../../platform/index';

const HARD_CAP_BYTES = 200_000;

export const fsReadTool: Tool = {
  name: 'fs_read',
  description: 'Read a text file (size-capped). Binary files are rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to read' },
      maxBytes: { type: 'number', description: 'Max bytes to return (default 20000)' },
    },
    required: ['path'],
  },
  risk: 'read',
  describe: (input) => `Read file ${String(input.path || '')}`,
  run: async (input) => {
    const p = String(input.path || '');
    const max = Math.min(Number(input.maxBytes) || 20_000, HARD_CAP_BYTES);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { ok: false, output: platform().fsErrorHint('read', e) || `cannot stat: ${p}` };
    }
    if (!st.isFile()) return { ok: false, output: `not a file: ${p}` };
    if (st.size > HARD_CAP_BYTES * 5) return { ok: false, output: `file too large (${st.size} bytes)` };
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
      return { ok: false, output: platform().fsErrorHint('read', e) || `read failed: ${(e as Error).message}` };
    }
    if (buf.includes(0)) return { ok: false, output: 'binary file, refusing to read as text' };
    const text = buf.toString('utf8');
    const truncated = st.size > max ? `\n…[truncated ${st.size - max} of ${st.size} bytes]` : '';
    return { ok: true, output: text.slice(0, max) + truncated, source: p, untrusted: true };
  },
};
