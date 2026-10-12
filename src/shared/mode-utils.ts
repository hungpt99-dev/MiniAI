import type { Mode, SlashScope } from './types';

export interface ScopeEntry {
  scope?: SlashScope;
}

/** Pure: keep entries visible in `mode`. Missing scope means both. */
export function filterByScope<T extends ScopeEntry>(entries: T[], mode: Mode): T[] {
  return entries.filter((e) => !e.scope || e.scope === 'all' || e.scope === mode);
}

export interface InterceptKeyOpts {
  key: string;
  inputFocused: boolean;
  paletteOpen: boolean;
  isComposing: boolean;
}

/** Pure: Tab switches mode only when input focused, palette closed, not composing. */
export function shouldInterceptKey(o: InterceptKeyOpts): boolean {
  return o.key === 'Tab' && o.inputFocused && !o.paletteOpen && !o.isComposing;
}

export type Drafts = Record<Mode, string>;

/** Pure draft helpers: preserve per-mode input text across tab switches. */
export function saveDraft(drafts: Drafts, mode: Mode, value: string): Drafts {
  return { ...drafts, [mode]: value };
}

export function restoreDraft(drafts: Drafts, mode: Mode): string {
  return drafts[mode] || '';
}
