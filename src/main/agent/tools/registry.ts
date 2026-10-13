import type { Tool } from '../types';
import { fsSearchTool } from './fs_search';
import { fsReadTool } from './fs_read';
import { fsListTool } from './fs_list';
import { appsListTool } from './apps_list';
import { clipboardReadTool } from './clipboard_read';
import { webSearchTool } from './web_search';
import { webFetchTool } from './web_fetch';
import { appOpenTool } from './app_open';
import { clipboardWriteTool } from './clipboard_write';
import { fsWriteTool } from './fs_write';
import { fsMoveTool } from './fs_move';
import { fsCopyTool } from './fs_copy';
import { fsTrashTool } from './fs_trash';
import { shellRunTool } from './shell_run';
import { attachmentListTool, attachmentReadTool } from './attachment_tools';

export const ALL_TOOLS: Tool[] = [
  fsSearchTool,
  fsReadTool,
  fsListTool,
  appsListTool,
  clipboardReadTool,
  webSearchTool,
  webFetchTool,
  appOpenTool,
  clipboardWriteTool,
  fsWriteTool,
  fsMoveTool,
  fsCopyTool,
  fsTrashTool,
  shellRunTool,
  attachmentListTool,
  attachmentReadTool,
];

export const TOOL_MAP: Map<string, Tool> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** OpenAI function-calling shape shared by OpenAI-compatible providers (incl. Gemini endpoint). */
export function toProviderTools(tools: Tool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
