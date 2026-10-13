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
  firstUseNotice: 'Attachments stay on this computer until you send them. Stays on this computer — processing runs on localhost.',
  visionNotice: 'This model does not support images. Switch model to send images — image bytes were not sent.',
  visionSwitch: 'Switch model',
  deleteAttachments: 'Delete attachments',
  secretsHint: 'Attachment text may contain secrets — confirm before sharing.',
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
