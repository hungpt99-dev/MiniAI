import type { Tool } from '../types';
import { platform } from '../../platform/index';

export const appsListTool: Tool = {
  name: 'apps_list',
  description: 'List running applications / processes (name only, no window control).',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  askSafe: true,
  describe: () => 'List running applications',
  run: async (_input, ctx) => {
    try {
      const apps = await platform().listApps(ctx.signal);
      const names = apps.map((a) => a.name).slice(0, 300);
      return { ok: true, output: names.join('\n') || '(none)' };
    } catch (e) {
      return { ok: false, output: `apps_list failed: ${(e as Error).message}` };
    }
  },
};
