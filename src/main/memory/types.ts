import type { MemoryKind, MemoryScope, MemorySource } from '../../shared/types';

/** One small, human-readable record about the user. */
export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;
  scope: MemoryScope;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
  pinned: boolean;
  confidence: number;
  expiresAt?: number;
  link?: string;
}

export const MEMORY_KINDS: MemoryKind[] = ['preference', 'fact', 'folder_rule', 'procedure', 'episode'];

/** Memory text cap (episodes get their own cap). */
export const MEMORY_TEXT_CAP = 300;
export const MEMORY_EPISODE_CAP = 500;

/** Retrieval budgets: at most 8 items and ~1,200 tokens (≈4 chars/token). */
export const MEMORY_MAX_ITEMS = 8;
export const MEMORY_MAX_CHARS = 4800;

/** Near-duplicate threshold (Jaccard over content tokens). */
export const MEMORY_DUPE_JACCARD = 0.8;
/** Same-scope contradiction threshold. */
export const MEMORY_CONFLICT_JACCARD = 0.5;

/** "Forget everything" needs this exact typed confirmation. */
export const FORGET_ALL_CONFIRM = 'forget everything';

/** Explicit-remember triggers in user messages (router runs before the loop). */
export const REMEMBER_RE =
  /\bremember\s+(that|this|to\b|for\b)?|\bfrom now on\b|\bghi nh[ớo]\b|\bhãy nh[ớo]\b|\bdon't forget\b|\bnever forget\b/i;

const STOP = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'the', 'a', 'an', 'and', 'or', 'of', 'to',
  'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'as', 'at',
  'by', 'from', 'please', 'always', 'never', 'not', 'no', 'do', 'does',
]);

/** Normalize for dedupe: lowercase, collapse whitespace/punctuation. */
export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Content tokens (stopwords dropped) for similarity. */
export function memoryTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeMemoryText(text).split(' ').filter(Boolean)) {
    if (!STOP.has(w) && w.length > 1) out.add(w);
  }
  return out;
}

/** Jaccard similarity over content tokens. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Short stable hash for dismissed-suggestion tracking. */
export function memoryHash(text: string): string {
  let h = 5381;
  const s = normalizeMemoryText(text);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Extra PII shapes beyond the shared secrets scanner (cards, gov IDs). */
const PII_RES: RegExp[] = [
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // card-like 16-digit runs
  /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/, // SSN-like
  /\b[A-Z]{1,2}\d{6,9}\b/, // passport/ID-like
];

/** True when the text must never be stored (caller reports the reason). */
export function blockedMemoryText(text: string, scanSecrets: (t: string) => boolean): string | null {
  if (!text || !text.trim()) return 'empty';
  if (scanSecrets(text)) return 'looks like a secret';
  if (PII_RES.some((re) => re.test(text))) return 'looks like private ID or card data';
  return null;
}
