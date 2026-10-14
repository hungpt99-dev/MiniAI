import type { AgentLimits, Tool } from './types';

/** Run context mode: decided by main, never trusted from the renderer. */
export type RunMode = 'ask' | 'do';

export const ASK_READ_ONLY_CODE = 'MODE_READ_ONLY';
export const ASK_READ_ONLY_MESSAGE = 'Ask mode is read-only. Switch to Do mode to change files.';
export const ASK_OUTSIDE_ROOTS_MESSAGE =
  'Outside the allowed folders. Add this folder in Settings to let Nexio read it.';
export const ASK_WEB_CONFIRM_MESSAGE =
  'Reading then sending elsewhere needs the user\'s explicit go-ahead. Ask the user to confirm sending file text to the web before calling any web tool.';

/** Stricter, constant Ask limits: max 8 tool calls, 60s total, 30s per tool. */
export const ASK_LIMITS: Pick<AgentLimits, 'maxToolCalls' | 'runTimeoutMs' | 'toolTimeoutMs'> = {
  maxToolCalls: 8,
  runTimeoutMs: 60 * 1000,
  toolTimeoutMs: 30 * 1000,
};

/** True only for read-risk tools explicitly opted in via askSafe. */
export function allowedInAsk(tool: Pick<Tool, 'risk' | 'askSafe'>): boolean {
  return tool.risk === 'read' && tool.askSafe === true;
}

/** Tools visible to the model in Ask mode (write tools are hidden, not just blocked). */
export function askTools<T extends Pick<Tool, 'name' | 'risk' | 'askSafe'>>(tools: T[]): T[] {
  return tools.filter(allowedInAsk);
}

/**
 * MCP tools in Ask: allowed only when ALL are true — server trusted (risk
 * already mapped to 'read' on trusted servers), readOnlyHint, and the user
 * enabled "Allow in Ask mode" for that exact tool (default off).
 * Callers pass the allowlisted full names (mcp__server__tool).
 */
export function allowedMcpInAsk(toolName: string, risk: string, allowlist: string[]): boolean {
  return risk === 'read' && allowlist.includes(toolName);
}
