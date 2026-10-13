import type { Mode } from '../../shared/types';

export interface RouteInput {
  mode: Mode;
  sessionId: string;
  requestId: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface RouterContext {
  chat: (input: RouteInput) => Promise<string>;
}

/**
 * Route a frozen request. Mode/sessionId/requestId are snapshotted
 * at call time so a late UI tab switch cannot redirect in-flight work.
 * Built-in only: chat streams via the provider, Do runs the loop in
 * ipc (runBuiltInAgent) â€” never an external runtime, never a fallback.
 */
export async function routeRequest(input: RouteInput, ctx: RouterContext): Promise<string> {
  const { mode, sessionId, requestId, prompt, cwd, signal, onToken } = { ...input };
  void sessionId;
  void requestId;
  if (mode === 'chat') return ctx.chat({ mode, sessionId, requestId, prompt, cwd, signal, onToken });
  throw new Error('agent-direct: Do mode runs the built-in loop (see runBuiltInAgent in ipc)');
}
