import type { RuntimeId } from '../../shared/types';

export interface AgentCaps {
  id: RuntimeId;
  label: string;
  available: boolean;
  reason?: string;
}

export interface AgentReq {
  prompt: string;
  sessionId?: string;
  requestId: string;
  cwd?: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

export interface AgentRuntimeAdapter {
  id: RuntimeId;
  caps(): Promise<AgentCaps> | AgentCaps;
  run(req: AgentReq): Promise<string>;
}
