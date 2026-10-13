import type { ProviderCapabilities } from '../types';

const DEFAULT: ProviderCapabilities = {
  limitParam: 'max_tokens', requiresLimit: true,
  supportsTemperature: true, supportsTopP: true,
  supportsSystemRole: false, supportsDeveloperRole: false,
  topLevelSystem: true, streamUsage: false,
  supportsTools: true, reasoningAware: false,
  supportsVision: true, maxImages: 5, maxBytes: 20 * 1024 * 1024,
  maxSide: 2048, supportedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

// Anthropic rejects temperature+top_p together on some models —
// capabilities stay conservative; buildRequest drops top_p when both are set.
const TABLE: Array<{ match: RegExp; caps: Partial<ProviderCapabilities> }> = [
  { match: /claude-opus-4|claude-sonnet-4|claude-3-7/i, caps: { reasoningAware: true } },
];

export function capabilitiesFor(model: string): ProviderCapabilities {
  for (const row of TABLE) {
    if (row.match.test(model || '')) return { ...DEFAULT, ...row.caps };
  }
  return { ...DEFAULT };
}
