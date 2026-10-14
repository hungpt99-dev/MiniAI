'use strict';
// Shared attachment constants + pure helpers (main + renderer safe, no Node APIs).
// Limits: 5 files max, 20MB per file, 200KB text truncation, 50MB total.

export const ATTACH_LIMITS = {
  maxCount: 5,
  maxFileBytes: 20 * 1024 * 1024,
  maxTextBytes: 200 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxSide: 2048,
} as const;

export const ATTACH_STRINGS = {
  dropHint: 'Drop to attach',
  defaultInstruction: 'Describe the attached file(s).',
  placeholderWithAttach: 'Add a note, Enter to send…',
  visionNotice: 'This model does not support images. Switch model to send images — image bytes were not sent.',
  visionSwitch: 'Switch model',
  deleteAttachments: 'Delete attachments',
  oversizeError: 'Attachment too large',
  countError: 'Too many attachments (max 5)',
} as const;

export type AttachMime =
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  | 'application/pdf' | 'text/plain' | 'text/markdown' | 'application/octet-stream';

export interface PendingAttach {
  id: string;
  name: string;
  mime: AttachMime | string;
  size: number;
  kind: 'image' | 'file' | 'text';
}

/** Magic-byte sniffing: never trust the extension. Returns mime or null when unknown. */
export function sniffMime(buf: Uint8Array, _filename = ''): string | null {
  void _filename;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return 'exe';
  // UTF BOMs / plain text heuristic: mostly printable ASCII/UTF-8.
  let printable = 0;
  const n = Math.min(buf.length, 512);
  if (n === 0) return null;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  if (printable / n > 0.85) return 'text/plain';
  return null;
}

export function isImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp';
}

/** Renamed executables reject even when the extension claims image/text. */
export function validateMagic(buf: Uint8Array, filename: string): { ok: boolean; mime: string | null; error?: string } {
  const mime = sniffMime(buf, filename);
  if (mime === 'exe') return { ok: false, mime, error: `Rejected ${filename}: executable or unknown content (type checked, not extension)` };
  if (!mime) return { ok: false, mime, error: `Rejected ${filename}: executable or unknown content (type checked, not extension)` };
  return { ok: true, mime };
}

export function validateLimits(files: Array<{ size: number }>): { ok: boolean; error?: string } {
  if (files.length > ATTACH_LIMITS.maxCount) return { ok: false, error: ATTACH_STRINGS.countError };
  let total = 0;
  for (const f of files) {
    if (f.size > ATTACH_LIMITS.maxFileBytes) return { ok: false, error: `${ATTACH_STRINGS.oversizeError} (max 20MB per file)` };
    total += f.size;
  }
  if (total > ATTACH_LIMITS.maxTotalBytes) return { ok: false, error: `${ATTACH_STRINGS.oversizeError} (max 50MB total)` };
  return { ok: true };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Safe temp name: basename only, no traversal, capped length. */
export function safeName(name: string): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
}

/** Fit (w,h) inside maxSide, preserving aspect. Pure — covered by downscale test. */
export function fitSize(w: number, h: number, maxSide = ATTACH_LIMITS.maxSide): { w: number; h: number; scaled: boolean } {
  const m = Math.max(w, h);
  if (!Number.isFinite(m) || m <= 0) return { w, h, scaled: false };
  if (m <= maxSide) return { w, h, scaled: false };
  const k = maxSide / m;
  return { w: Math.round(w * k), h: Math.round(h * k), scaled: true };
}

/** Clipboard 4 cases for paste handling. */
export function classifyPaste(hasText: boolean, fileCount: number): 'text-only' | 'image-only' | 'files-only' | 'mixed' | 'empty' {
  if (fileCount > 0 && hasText) return 'mixed';
  if (fileCount > 0) return fileCount === 1 ? 'image-only' : 'files-only';
  if (hasText) return 'text-only';
  return 'empty';
}

/** Strip paths from console/log text: keep basename only. */
export function redactPaths(text: string): string {
  return String(text).replace(/[A-Za-z]:\\[^\s"']+/g, (m) => m.split('\\').pop() || m)
    .replace(/\/(?:[^\s"']*\/)+([^\s"'/]+)/g, '$1');
}

/** Evidence-based secret scan for attachment text (chip badge, send gate). */
const SECRET_VALUE = `(?:['"][^'"]{2,}['"]|[A-Za-z0-9-_]{8,})`;
const SECRET_RES: RegExp[] = [
  /sk-[A-Za-z0-9-_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key\s*[:=]\s*\S{8,}/i,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  new RegExp(`\\bpassw(?:or)?d\\s*[:=]\\s*(?![A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\()${SECRET_VALUE}`, 'i'),
  new RegExp(`\\b(?:api[_-]?key|auth[_-]?token)\\s*[:=]\\s*(?![A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\()${SECRET_VALUE}`, 'i'),
  /\bbearer\s+['"]?\S{8,}/i,
];

/** True when text matches a known secret pattern. Empty/short text never matches. */
export function scanSecretsText(text: string): boolean {
  if (!text || text.length < 8) return false;
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  return SECRET_RES.some((re) => re.test(sample));
}

/** "1 attachment added" / "3 attachments added" (no "(s)"). */
export function formatAttachCount(n: number): string {
  return n === 1 ? '1 attachment added' : `${n} attachments added`;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  compatible: 'Custom',
};

/** Local provider = compatible/custom endpoint on this machine or LAN. */
export function isLocalProvider(provider: string, baseUrl?: string): boolean {
  if (provider !== 'compatible') return false;
  const host = (() => {
    try {
      // why: Node keeps IPv6 brackets in hostname, browsers strip them.
      return new URL(String(baseUrl || '')).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
    } catch {
      return '';
    }
  })();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** The single attachment notice sentence, decided by provider type only. */
export function attachNoticeText(provider: string, baseUrl?: string): string {
  if (isLocalProvider(provider, baseUrl)) return 'Stays on this computer.';
  const name = PROVIDER_DISPLAY[provider] || provider || 'Custom';
  return `Sent to ${name} when you press Enter.`;
}
