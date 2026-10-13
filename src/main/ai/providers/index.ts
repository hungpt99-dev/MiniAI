import type { ProviderId } from '../../../shared/types';
import type { ProviderAdapter } from './types';
import { openaiAdapter } from './openai/adapter';
import { anthropicAdapter } from './anthropic/adapter';
import { geminiAdapter } from './gemini/adapter';
import { compatibleAdapter } from './compatible/adapter';

export const PROVIDER_ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  compatible: compatibleAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  const a = PROVIDER_ADAPTERS[provider];
  if (!a) throw new Error(`Unknown provider: ${provider}`);
  return a;
}

export { DEFAULT_MAX_OUTPUT_TOKENS, TEST_MAX_OUTPUT_TOKENS, TEST_MAX_REASONING_TOKENS, TEST_TIMEOUT_MS, CHAT_TIMEOUT_MS } from './constants';
export { stripTrailingSlash, resolveBase } from './base';
export type { NormalizedRequest, ProviderAdapter, ProviderCapabilities, ToolTurn } from './types';
