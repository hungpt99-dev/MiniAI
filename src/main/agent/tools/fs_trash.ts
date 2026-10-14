import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Tool } from '../types';
import { platform } from '../../platform/index';

export const fsTrashTool: Tool = {
  name: 'fs_trash',
  description: 'Move a file or folder to the Recycle Bin / Trash. NEVER permanently deletes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to move to trash' },
    },
    required: ['path'],
  },
  risk: 'write',
  askSafe: false,
  describe: (input) => `Move ${String(input.path || '')} to the ${platform().trashWord}`,
  run: async (input) => {
    const p = String(input.path || '');
    try {
      await platform().trashItem(p);
      return { ok: true, output: `moved to trash: ${p}` };
    } catch {
      // Fallback outside Electron (tests/dev): move aside, never delete.
      try {
        const dir = path.join(os.tmpdir(), 'nexio-trash');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${Date.now()}-${path.basename(p)}`);
        fs.renameSync(p, dest);
        return { ok: true, output: `moved to trash: ${p} (staged at ${dest})` };
      } catch (e) {
        return { ok: false, output: `trash failed: ${(e as Error).message}` };
      }
    }
  },
};
