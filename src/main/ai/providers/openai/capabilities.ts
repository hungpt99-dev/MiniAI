import type { ProviderCapabilities } from '../types';

interface CapRow { match: RegExp; caps: Partial<ProviderCapabilities>; }

const DEFAULT: ProviderCapabilities = {
  limitParam: 'auto', requiresLimit: false,
  supportsTemperature: true, supportsTopP: true,
  supportsSystemRole: true, supportsDeveloperRole: true,
  topLevelSystem: false, streamUsage: true,
  supportsTools: true, reasoningAware: false,
};

// Reasoning models reject sampling params and want the completion limit.
// why: data-driven table keeps model knowledge out of request code
const TABLE: CapRow[] = [
  { match: /\bo1\b|\bo3\b|gpt-5|o[34](-mini)?\b/i, caps: { limitParam: 'max_completion_tokens', supportsTemperature: false, supportsTopP: false, reasoningAware: true } },
];

export function capabilitiesFor(model: string): ProviderCapabilities {
  for (const row of TABLE) {
    if (row.match.test(model || '')) return { ...DEFAULT, ...row.caps };
  }
  return { ...DEFAULT };
}
