import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../types';

export const fsMoveTool: Tool = {
  name: 'fs_move',
  description: 'Move/rename a file or folder.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to: { type: 'string', description: 'Destination path' },
    },
    required: ['from', 'to'],
  },
  risk: 'write',
  describe: (input) => `Move ${String(input.from || '')} → ${String(input.to || '')}`,
  run: async (input) => {
    const from = String(input.from || '');
    const to = String(input.to || '');
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { ok: true, output: `moved ${from} → ${to}` };
    } catch (e) {
      return { ok: false, output: `move failed: ${(e as Error).message}` };
    }
  },
};
