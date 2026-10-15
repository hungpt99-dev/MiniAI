import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_LIMITS, scanSecretsText, displayName as displayNameOf, storageExt } from '../shared/attachments';
import { isInsideRoots, isPathAllowed, normalizeAndResolve } from './agent/permissions';
import type { PolicyContext } from './agent/types';
import { platform } from './platform/index';
import { detectAttachment, type Detection } from './attachments/detect';
import { decideAttachPolicy, formatRejection, type AttachDecision } from './attachments/policy';
import { extractDocumentText } from './attachments/extract';
import { t } from './i18n/index';

export interface StoredAttachment {
  id: string;
  runId: string;
  /** On-disk storage name (id-based, never shown anywhere). */
  name: string;
  /** What the user attached (NFC, verbatim) — chips, rows, requests, tools, logs. */
  displayName: string;
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

import { decodeAttachmentText } from './attachments/decode';

/** Decode text with BOM/UTF-16/legacy-encoding handling, truncate to 200KB with a marker. */
export function decodeText(buf: Buffer): { text: string; truncated: boolean; encoding: string } {
  let text: string;
  let encoding = 'UTF-8';
  try {
    const dec = decodeAttachmentText(buf);
    if (dec) { text = dec.text; encoding = dec.encoding; }
    else text = buf.toString('utf8');
  } catch { text = buf.toString('utf8'); }
  const cap = ATTACH_LIMITS.maxTextBytes;
  if (Buffer.byteLength(text, 'utf8') > cap) {
    let cut = text.slice(0, Math.floor(cap / 3));
    while (Buffer.byteLength(cut, 'utf8') > cap) cut = cut.slice(0, Math.floor(cut.length * 0.9));
    return { text: cut + `\n…[truncated to 200KB]`, truncated: true, encoding };
  }
  return { text, truncated: false, encoding };
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
  // why: the disk name is id-based (traversal-proof, unicode-proof); the
  // user-visible name stays verbatim (NFC) and is never derived from it.
  const display = displayNameOf(name);
  const id = `a-${crypto.randomUUID()}`;
  const storage = `${id}.${storageExt(name)}`;
  const filePath = path.join(dir, storage);
  fs.writeFileSync(filePath, bytes);
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('text/') || mime.includes('markdown') ? 'text' : 'file';
  return { id, runId, name: storage, displayName: display, mime, size: bytes.length, sha256: sha256(bytes), path: filePath, kind, width: opts.width, height: opts.height, truncated: opts.truncated, previewDataUrl: opts.dataUrl };
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

/** Log-safe attachment record: display name/type/size/SHA256 only — never bytes, paths, or storage names. */
export function attachmentLogRecord(a: Pick<StoredAttachment, 'displayName' | 'mime' | 'size' | 'sha256'>): { name: string; type: string; size: number; sha256: string } {
  return { name: a.displayName, type: a.mime, size: a.size, sha256: a.sha256 };
}

/** Chip state for document/reference files (renderer badges + tooltips). */
export type DocState = 'extracted' | 'reference' | 'macros' | 'encrypted' | 'native';

export interface ClassifiedAttachment {
  det: Detection;
  decision: AttachDecision;
  /** Final mime (bytes win; .md names keep markdown for text). */
  mime: string;
  docState?: DocState;
  docNote?: string;
  /** Extracted plain text when action is document_extract and it worked. */
  extractedText?: string;
  /** Secrets scanner hit on the extracted text (chip warn / context note). */
  secretsInExtracted?: boolean;
  /** 'kind (evidence), rule X' for the Details toggle. */
  details: string;
  /** True when the active provider cannot read this type natively (send refuses; remove or switch model). */
  unsupportedType?: boolean;
}

export interface ClassifyOpts {
  /** Opt-in local text extraction for provider-unsupported types (default off). */
  localTextFallback?: boolean;
  /** Provider display label for the unsupported notice (e.g. 'Anthropic'). */
  providerLabel?: string;
}

/** Extension for the unsupported notice (never the full path). */
export function attachExt(name: string): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(base);
  return m ? `.${m[1].toLowerCase()}` : 'this file type';
}

/**
 * Single classify pipeline shared by picker preview, paste/drop processing
 * and the send path: detect (bytes, never extension) -> policy -> optional
 * extraction. PDFs classify as native (the provider reads the original bytes;
 * no local parsing on the send path). Office types extract locally only with
 * the opt-in fallback, otherwise they are flagged unsupported (the send path
 * refuses with the same notice). Never throws (worst case: unknown ->
 * reference_only).
 */
export function classifyAttachment(bytes: Buffer, name: string, opts: ClassifyOpts = {}): ClassifiedAttachment {
  let det: Detection;
  try {
    det = detectAttachment(bytes);
  } catch {
    det = { kind: 'unknown', mime: 'application/octet-stream', flags: [], evidence: 'inspection failed', confidence: 'low' };
  }
  let decision = decideAttachPolicy(det);
  let mime = det.mime;
  if (det.kind === 'text' && /\.m(d|arkdown)$/i.test(name)) mime = 'text/markdown';
  const details = `${det.kind} (${det.evidence}), rule ${decision.rule}`;
  let docState: DocState | undefined;
  let docNote: string | undefined;
  let extractedText: string | undefined;
  let secretsInExtracted = false;
  let unsupportedType = false;
  // why: unencrypted PDFs go to the provider as native documents — classifying
  // them native here keeps every staging badge honest (no extraction anywhere).
  if (det.kind === 'pdf' && !det.flags.includes('encrypted')) {
    return {
      det, decision, mime,
      docState: 'native', docNote: t('attach.nativeNote'),
      details, unsupportedType: false,
    };
  }
  // why: Office text extraction is opt-in (localTextFallback); otherwise the
  // file is provider-unsupported — flagged here, refused on the send path.
  if (decision.action === 'document_extract' && !opts.localTextFallback) {
    const note = t('attach.unsupported', { provider: opts.providerLabel || 'This provider', ext: attachExt(name) });
    return {
      det,
      decision: { action: 'reference_only', rule: 'doc-reference', note },
      mime, docState: 'reference', docNote: note, details, unsupportedType: true,
    };
  }
  if (decision.action === 'reference_only') {
    if (decision.rule === 'macro-warn') { docState = 'macros'; docNote = decision.note; }
    else if (decision.rule === 'encrypted-note') { docState = 'encrypted'; docNote = decision.note; }
    else { docState = 'reference'; docNote = decision.note || 'Nexio can see the file name and path but not its contents.'; }
  } else if (decision.action === 'document_extract') {
    let ext: { text: string; outline: string[]; images: number } | null = null;
    try {
      ext = extractDocumentText(bytes, det.kind);
    } catch { ext = null; }
    if (ext && ext.text.trim()) {
      docState = 'extracted';
      const outline = ext.outline.length ? `Outline: ${ext.outline.slice(0, 20).join(' | ')}\n` : '';
      const imgs = ext.images ? `${ext.images} embedded image(s) listed, not read.\n` : '';
      extractedText = `${outline}${imgs}${ext.text}`;
      try { secretsInExtracted = scanSecretsText(extractedText); } catch { /* no badge without evidence */ }
      docNote = `Extracted text from ${det.kind}${ext.images ? ` (${ext.images} images ignored)` : ''}.`;
    } else {
      // Extraction unavailable or empty: stay accepted, clearly reference-only.
      decision = { action: 'reference_only', rule: 'doc-reference', note: 'Added as reference only, contents not read.' };
      docState = 'reference';
      docNote = decision.note;
    }
  }
  return { det, decision, mime, docState, docNote, extractedText, secretsInExtracted, details, ...(unsupportedType ? { unsupportedType: true } : {}) };
}

/** Rejection error for an attachment, with a Details line for the UI toggle. */
export function attachmentRejected(name: string, c: ClassifiedAttachment): Error {
  return new Error(formatRejection(name, c.det, c.decision));
}
