import type { Mode, RuntimeId } from '../../shared/types';
import type { AgentRuntimeAdapter } from './adapter';

export interface RouteInput {
  mode: Mode;
  runtimeId: RuntimeId;
  sessionId: string;
  requestId: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface RouterContext {
  chat: (input: RouteInput) => Promise<string>;
  agents: Partial<Record<RuntimeId, AgentRuntimeAdapter>>;
}

/**
 * Route a frozen request. Mode/runtime/sessionId/requestId are snapshotted
 * at call time so a late UI tab/runtime switch cannot redirect in-flight work.
 * Agent path never falls back to chat: unknown/unavailable runtime throws.
 */
export async function routeRequest(input: RouteInput, ctx: RouterContext): Promise<string> {
  const { mode, runtimeId, sessionId, requestId, prompt, cwd, signal, onToken } = { ...input };
  void sessionId;
  void requestId;
  if (mode === 'chat') return ctx.chat({ mode, runtimeId, sessionId, requestId, prompt, cwd, signal, onToken });
  const adapter = ctx.agents[runtimeId];
  if (!adapter) throw new Error(`unknown-runtime: ${runtimeId}`);
  const caps = await adapter.caps();
  if (!caps.available) throw new Error(`runtime-unavailable: ${runtimeId}${caps.reason ? ` (${caps.reason})` : ''}`);
  return adapter.run({ prompt, sessionId, requestId, cwd, signal, onToken: onToken || (() => {}) });
}
