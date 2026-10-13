import fs from 'node:fs';
import type { Tool } from '../types';
import { platform } from '../../platform/index';

export const fsListTool: Tool = {
  name: 'fs_list',
  description: 'List files and folders in a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list' },
    },
    required: ['path'],
  },
  risk: 'read',
  describe: (input) => `List directory ${String(input.path || '')}`,
  run: async (input) => {
    const p = String(input.path || '');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      return { ok: false, output: platform().fsErrorHint('list', e) || `cannot list: ${(e as Error).message}` };
    }
    const rows = entries.slice(0, 500).map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`);
    return { ok: true, output: rows.join('\n') || '(empty)', source: p, untrusted: true };
  },
};
