import type { ChatMessage } from '../../shared/types';

export type Risk = 'read' | 'write' | 'destructive';

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
}

/** Thrown out of the agent loop when a task must park (write lock held by another task). */
export class TaskParkedError extends Error {
  constructor(public reason: string) {
    super(`task-parked: ${reason}`);
    this.name = 'TaskParkedError';
  }
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
  /**
   * Explicit Ask-mode opt-in (default false: blocked in Ask until set true).
   * True only for read-only tools that cannot create, modify, open or run anything.
   */
  askSafe?: boolean;
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
  /** Terminal failure: message is user-friendly (never raw internals);
   * code/technical/action feed the error row (Details toggle, Retry, Open Settings). */
  | { type: 'error'; message: string; code?: string; technical?: string; action?: 'open-settings' | 'retry' | null }
  | { type: 'stopped' }
  /** Long-term memory used for this run (ids only, never text). */
  | { type: 'memory_used'; count: number; ids: string[] };

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
  /** Extra hard-deny paths from enforced memory prohibitions (user's own "never touch" rules). */
  extraProtected?: string[];
}

/** Plain history seed from the conversation DB (tool fidelity lives in tools-chat AgentMsg). */
export type SeedHistory = ChatMessage[];
