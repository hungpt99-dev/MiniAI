import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../types';

export const fsCopyTool: Tool = {
  name: 'fs_copy',
  description: 'Copy a file or folder.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to: { type: 'string', description: 'Destination path' },
    },
    required: ['from', 'to'],
  },
  risk: 'write',
  describe: (input) => `Copy ${String(input.from || '')} → ${String(input.to || '')}`,
  run: async (input) => {
    const from = String(input.from || '');
    const to = String(input.to || '');
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      return { ok: true, output: `copied ${from} → ${to}` };
    } catch (e) {
      return { ok: false, output: `copy failed: ${(e as Error).message}` };
    }
  },
};
