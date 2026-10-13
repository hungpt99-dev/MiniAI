import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../types';
import { platform } from '../../platform/index';

export const fsWriteTool: Tool = {
  name: 'fs_write',
  description: 'Write text content to a file. Refuses to overwrite unless overwrite:true (which needs approval).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination file path' },
      content: { type: 'string', description: 'Text content to write' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing file' },
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  describe: (input) => `Write ${String(input.content || '').length} chars to ${String(input.path || '')}${input.overwrite ? ' (overwrite)' : ''}`,
  run: async (input) => {
    const p = String(input.path || '');
    const content = String(input.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > 1_000_000) return { ok: false, output: 'content too large (1MB cap)' };
    try {
      if (fs.existsSync(p) && !input.overwrite) {
        return { ok: false, output: `exists: ${p} (set overwrite:true to replace — requires approval)` };
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return { ok: true, output: `wrote ${content.length} chars to ${p}` };
    } catch (e) {
      return { ok: false, output: platform().fsErrorHint('write', e) || `write failed: ${(e as Error).message}` };
    }
  },
};
