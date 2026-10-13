import type { ProviderId } from '../../../shared/types';
import type { ProviderError } from '../errors/provider-error';

/** Neutral chat content: no provider literals cross this boundary. */
export type NormalizedMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: NormalizedToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Neutral request: only sampling/limit/stop/stream controls, no provider params. */
export interface NormalizedRequest {
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface ToolTurn {
  text: string;
  calls: NormalizedToolCall[];
}

/** What a model name implies about request shape. Data-driven via regex tables. */
export interface ProviderCapabilities {
  /** Which limit param to send. 'auto' lets retry downgrade on 400/422. */
  limitParam: 'max_tokens' | 'max_completion_tokens' | 'auto';
  requiresLimit: boolean;
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsSystemRole: boolean;
  supportsDeveloperRole: boolean;
  /** True when system messages must move to a top-level field instead. */
  topLevelSystem: boolean;
  streamUsage: boolean;
  supportsTools: boolean;
  reasoningAware: boolean;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  chatEndpoint(baseUrl?: string): string;
  headers(apiKey: string): Record<string, string>;
  listModels(apiKey: string, baseUrl?: string, signal?: AbortSignal, fetchFn?: typeof fetch): Promise<string[]>;
  buildRequest(model: string, req: NormalizedRequest, baseUrl?: string): BuiltRequest;
  parseResponse(json: unknown): ToolTurn;
  /** Returns a text delta, or undefined for control/usage events. */
  parseStreamEvent(json: unknown): string | undefined;
  parseError(status: number, bodyText: string): ProviderError;
  capabilitiesFor(model: string): ProviderCapabilities;
}
