import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_LIMITS, safeName } from '../shared/attachments';
import { isInsideRoots, isPathAllowed, normalizeAndResolve } from './agent/permissions';
import type { PolicyContext } from './agent/types';
import { platform } from './platform/index';

export interface StoredAttachment {
  id: string;
  runId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  kind: 'image' | 'file' | 'text';
  width?: number;
  height?: number;
  truncated?: boolean;
  /** Small preview bytes for images (data URL payload, capped). Never logged. */
  previewDataUrl?: string;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function attachmentDir(baseDir: string, runId: string): string {
  return path.join(baseDir, 'attachments', String(runId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'run');
}

/** Decode text with UTF-8/UTF-16 BOM handling, truncate to 200KB with a marker. */
export function decodeText(buf: Buffer): { text: string; truncated: boolean } {
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
    text = swapped.toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.slice(3).toString('utf8');
  else text = buf.toString('utf8');
  const cap = ATTACH_LIMITS.maxTextBytes;
  if (Buffer.byteLength(text, 'utf8') > cap) {
    let cut = text.slice(0, Math.floor(cap / 3));
    while (Buffer.byteLength(cut, 'utf8') > cap) cut = cut.slice(0, Math.floor(cut.length * 0.9));
    return { text: cut + `\n…[truncated to 200KB]`, truncated: true };
  }
  return { text, truncated: false };
}

/** Trust sniffed bytes over the claimed extension, except text stays text; .md names keep their markdown type. */
export function resolveAttachMime(sniffed: string, claimed: string | undefined, name: string): string {
  const mime = sniffed.startsWith('text/') && claimed?.startsWith('text/') ? claimed : sniffed;
  if (mime === 'text/plain' && /\.m(d|arkdown)$/i.test(name)) return 'text/markdown';
  return mime;
}
/** Strip JPEG APP1 (EXIF) segments so orientation/metadata never leaves the device raw. */
export function stripJpegExif(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out: Buffer[] = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) { out.push(buf.slice(i)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buf.slice(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.slice(i, i + 2 + len);
    // Drop APP1 (EXIF) only; keep the rest (orientation applied by decoder).
    if (!(marker === 0xe1 && seg.slice(4, 10).toString('ascii') === 'Exif\0\0')) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

function tryNativeImage(buf: Buffer): { dataUrl: string; w: number; h: number } | null {
  try {
    // Electron only; plain Node/vitest has no electron module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeImage } = require('electron') as typeof import('electron');
    if (!nativeImage) return null;
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const m = Math.max(size.width, size.height);
    if (m > ATTACH_LIMITS.maxSide) {
      const k = ATTACH_LIMITS.maxSide / m;
      img = img.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k) });
    }
    const s2 = img.getSize();
    // Re-encode (drops EXIF, applies orientation) — PNG for transparency-safe output.
    const png = img.toPNG();
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, w: s2.width, h: s2.height };
  } catch { return null; }
}

/** Re-encode images via Electron nativeImage when present (2048px cap, EXIF dropped).
 * Fallback (plain Node/tests): original bytes, JPEG EXIF-stripped only — PNG/WebP/GIF
 * metadata is retained and no resize applies. No sharp dependency. */
export function processImage(buf: Buffer, mime: string): { bytes: Buffer; mime: string; width?: number; height?: number; dataUrl: string } {
  const stripped = mime === 'image/jpeg' ? stripJpegExif(buf) : buf;
  const native = tryNativeImage(stripped);
  if (native) return { bytes: Buffer.from(native.dataUrl.split(',')[1], 'base64'), mime: 'image/png', width: native.w, height: native.h, dataUrl: native.dataUrl };
  if (stripped.length > ATTACH_LIMITS.maxFileBytes) throw new Error(`Attachment too large (max 20MB per file)`);
  const b64 = stripped.toString('base64');
  return { bytes: stripped, mime, dataUrl: `data:${mime};base64,${b64}` };
}

export function saveAttachment(baseDir: string, runId: string, name: string, mime: string, bytes: Buffer, opts: { width?: number; height?: number; truncated?: boolean; dataUrl?: string } = {}): StoredAttachment {
  const dir = attachmentDir(baseDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeName(name);
  const id = `a-${crypto.randomUUID()}`;
  const filePath = path.join(dir, `${id}-${safe}`);
  fs.writeFileSync(filePath, bytes);
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('text/') || mime.includes('markdown') ? 'text' : 'file';
  return { id, runId, name: safe, mime, size: bytes.length, sha256: sha256(bytes), path: filePath, kind, width: opts.width, height: opts.height, truncated: opts.truncated, previewDataUrl: opts.dataUrl };
}

/** Delete a run's temp files (run delete / Clear / new chat). Never throws. */
export function deleteRunAttachments(baseDir: string, runId: string): void {
  try { fs.rmSync(attachmentDir(baseDir, runId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Remove orphan temp dirs older than 7 days. Returns removed count. */
export function sweepOldAttachments(baseDir: string, maxAgeMs = 7 * 24 * 3600 * 1000): number {
  let removed = 0;
  const root = path.join(baseDir, 'attachments');
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
    } catch { /* keep going */ }
  }
  return removed;
}

export type AttachPathVerdict = 'allow' | 'approval' | 'deny';

/**
 * Per-file attach path check: realpath first, then the shared policy layer.
 * Outside allowed roots → approval (Allow once); protected/symlink escape → deny (Remove).
 */
export function classifyAttachPath(raw: string, cwd: string, ctx: PolicyContext): { verdict: AttachPathVerdict; resolved: string; real: string; reason?: string } {
  let resolved: string;
  try { resolved = normalizeAndResolve(raw, cwd, platform()); }
  catch (e) { return { verdict: 'deny', resolved: raw, real: raw, reason: (e as Error).message }; }
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch {
    // Nearest existing ancestor for missing files.
    try {
      let dir = path.dirname(resolved);
      const tail: string[] = [path.basename(resolved)];
      for (;;) {
        try { real = path.join(fs.realpathSync(dir), ...tail); break; }
        catch { const p = path.dirname(dir); if (p === dir) break; tail.unshift(path.basename(dir)); dir = p; }
      }
    } catch { /* keep resolved */ }
  }
  if (!isPathAllowed(real, ctx, platform())) return { verdict: 'deny', resolved, real, reason: `blocked path: ${real}` };
  if (!isInsideRoots(real, ctx.allowedRoots, platform())) return { verdict: 'approval', resolved, real, reason: 'outside allowed roots' };
  return { verdict: 'allow', resolved, real };
}

/** Log-safe attachment record: name/type/size/SHA256 only — never bytes. */
export function attachmentLogRecord(a: Pick<StoredAttachment, 'name' | 'mime' | 'size' | 'sha256'>): { name: string; type: string; size: number; sha256: string } {
  return { name: a.name, type: a.mime, size: a.size, sha256: a.sha256 };
}
