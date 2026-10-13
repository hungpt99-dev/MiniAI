import type { ProviderCapabilities } from '../types';

const DEFAULT: ProviderCapabilities = {
  limitParam: 'auto', requiresLimit: false,
  supportsTemperature: true, supportsTopP: true,
  supportsSystemRole: true, supportsDeveloperRole: false,
  topLevelSystem: false, streamUsage: true,
  supportsTools: true, reasoningAware: false,
  supportsVision: true, maxImages: 5, maxBytes: 20 * 1024 * 1024,
  maxSide: 2048, supportedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

// Thinking models use a reasoning budget on the native API; the OpenAI-compat
// path carries no thinking field — requests stay small and reasoning-aware.
// why: table keeps model knowledge out of request code
const TABLE: Array<{ match: RegExp; caps: Partial<ProviderCapabilities> }> = [
  { match: /thinking|gemini-2\.5|gemini-3/i, caps: { reasoningAware: true } },
];

export function capabilitiesFor(model: string): ProviderCapabilities {
  for (const row of TABLE) {
    if (row.match.test(model || '')) return { ...DEFAULT, ...row.caps };
  }
  return { ...DEFAULT };
}
