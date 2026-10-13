import type { ProviderCapabilities } from '../types';

const DEFAULT: ProviderCapabilities = {
  limitParam: 'auto', requiresLimit: false,
  supportsTemperature: true, supportsTopP: true,
  supportsSystemRole: true, supportsDeveloperRole: false,
  topLevelSystem: false, streamUsage: false,
  supportsTools: true, reasoningAware: false,
  supportsVision: true, maxImages: 5, maxBytes: 20 * 1024 * 1024,
  maxSide: 2048, supportedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

// Servers vary wildly (Ollama, LM Studio, vLLM, proxies) — stay conservative:
// auto limit, no stream usage block, tools claimed but response may carry
// text only (tool detection fallback: callers accept text-only as valid).
const TABLE: Array<{ match: RegExp; caps: Partial<ProviderCapabilities> }> = [
  { match: /o1\b|o3\b|gpt-5|deepseek-r1|qwq|r1-distill/i, caps: { limitParam: 'max_completion_tokens', supportsTemperature: false, supportsTopP: false, reasoningAware: true } },
];

export function capabilitiesFor(model: string): ProviderCapabilities {
  for (const row of TABLE) {
    if (row.match.test(model || '')) return { ...DEFAULT, ...row.caps };
  }
  return { ...DEFAULT };
}
