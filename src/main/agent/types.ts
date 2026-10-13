import type { ChatMessage } from '../../shared/types';

export type Risk = 'read' | 'write' | 'destructive';

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Where the output came from (file path, URL, 'clipboard'). Set for untrusted sources. */
  source?: string;
  /** True when output is attacker-influenced data (files, web, clipboard). */
  untrusted?: boolean;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: Risk;
  /** Exact human-readable action shown in approval (full command / path / URL). */
  describe(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type AgentEvent =
  | { type: 'step'; id: string; text: string }
  | { type: 'tool_call'; id: string; tool: string; input: unknown; risk: Risk; summary: string; afterUntrusted?: string }
  | { type: 'approval_request'; id: string; tool: string; input: unknown; risk: Risk; summary: string; afterUntrusted?: string }
  | { type: 'tool_result'; id: string; ok: boolean; output: string; durationMs: number }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

export type ApprovalDecision = 'allow-once' | 'deny' | 'always';

export interface ApprovalOutcome {
  decision: ApprovalDecision;
}

/** Scoped "Always allow" rule stored in settings. */
export interface AlwaysRule {
  scope: 'tool-dir' | 'exact-command';
  tool?: string;
  dir?: string;
  command?: string;
}

export interface AgentLimits {
  maxToolCalls: number;
  runTimeoutMs: number;
  toolTimeoutMs: number;
  maxOutputChars: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxToolCalls: 25,
  runTimeoutMs: 5 * 60 * 1000,
  toolTimeoutMs: 30 * 1000,
  maxOutputChars: 8000,
};

export interface PolicyContext {
  allowedRoots: string[];
  /** Folders the user explicitly added in Settings — only these override blocked paths. */
  explicitRoots?: string[];
  alwaysAllow: AlwaysRule[];
  requireApprovalForWrites: boolean;
  homeDir: string;
}

/** Plain history seed from the conversation DB (tool fidelity lives in tools-chat AgentMsg). */
export type SeedHistory = ChatMessage[];
