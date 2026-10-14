import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../types';
import { platform } from '../../platform/index';

const SKIP_DIRS = new Set(['node_modules', '.git', 'AppData', 'Windows', '$Recycle.Bin']);

export const fsSearchTool: Tool = {
  name: 'fs_search',
  description: 'Search file names under a root folder (case-insensitive substring). Never scans the whole disk without a root.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'File name substring to match' },
      root: { type: 'string', description: 'Folder to search under (defaults to working folder)' },
      maxResults: { type: 'number', description: 'Max matches (default 50)' },
    },
    required: ['query'],
  },
  risk: 'read',
  askSafe: true,
  describe: (input) => `Search files named "*${String(input.query || '')}*" under ${String(input.root || '(working folder)')}`,
  run: async (input, ctx) => {
    const query = String(input.query || '').toLowerCase();
    if (!query) return { ok: false, output: 'query is required' };
    const root = path.resolve(String(input.root || ctx.cwd || '.'));
    const max = Math.min(Number(input.maxResults) || 50, 200);
    const out: string[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    const t0 = Date.now();
    // Permission-denied root: fail visibly with guidance, not empty results.
    try {
      fs.readdirSync(root);
    } catch (e) {
      const hint = platform().fsErrorHint('search', e);
      if (hint) return { ok: false, output: hint };
    }
    while (queue.length && out.length < max && Date.now() - t0 < 10_000) {
      const cur = queue.shift() as { dir: string; depth: number };
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur.dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdirs are skipped silently during the walk
      }
      for (const e of entries) {
        if (out.length >= max) break;
        const full = path.join(cur.dir, e.name);
        if (e.isDirectory()) {
          if (cur.depth < 6 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ dir: full, depth: cur.depth + 1 });
        } else if (e.name.toLowerCase().includes(query)) {
          out.push(full);
        }
      }
    }
    return { ok: true, output: JSON.stringify(out, null, 1), source: root, untrusted: true };
  },
};
