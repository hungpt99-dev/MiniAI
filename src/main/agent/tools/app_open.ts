import type { Tool } from '../types';
import { platform } from '../../platform/index';

export const appOpenTool: Tool = {
  name: 'app_open',
  description: 'Open an app, file or URL with the OS default handler. Only http/https/file URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      nameOrPath: { type: 'string', description: 'App name, file path, or http(s)/file URL' },
    },
    required: ['nameOrPath'],
  },
  risk: 'write',
  describe: (input) => `Open ${String(input.nameOrPath || '')} with the OS default handler`,
  run: async (input) => {
    const target = String(input.nameOrPath || '').trim();
    if (!target) return { ok: false, output: 'nameOrPath is required' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(https?|file):/i.test(target)) {
      return { ok: false, output: 'only http/https/file URLs allowed' };
    }
    try {
      await platform().openTarget(target);
      return { ok: true, output: `opened ${target}` };
    } catch (e) {
      return { ok: false, output: `open failed: ${(e as Error).message}` };
    }
  },
};
