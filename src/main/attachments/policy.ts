/** Attachment policy: WHAT may Nexio do with it (per detected kind, one table). */
import type { AttachKind, Detection } from './detect';
import { t } from '../i18n/index';

export type AttachAction = 'inline_text' | 'image' | 'document_extract' | 'reference_only' | 'reject';

export interface AttachDecision {
  action: AttachAction;
  /** Rule id for the Details toggle (e.g. 'executable-deny'). */
  rule: string;
  /** Short human note for chips/tooltips (no file content). */
  note?: string;
}

/** Kinds the built-in extractor can turn into text (no new dependencies). */
export const EXTRACTABLE: ReadonlySet<AttachKind> = new Set([
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);

const REJECT_WHAT_KEY: Record<string, string> = {
  exe: 'attach.reject.executable.windows',
  elf: 'attach.reject.executable.linux',
  macho: 'attach.reject.executable.macos',
  msi: 'attach.reject.installer',
  lnk: 'attach.reject.shortcut',
  url: 'attach.reject.internet',
  scf: 'attach.reject.internet',
  appx: 'attach.reject.package',
  jar: 'attach.reject.code',
  apk: 'attach.reject.code',
};

/**
 * One table: detection -> action. Unknown/unsupported is NEVER a rejection —
 * only positively dangerous files are rejected. Never throws.
 */
export function decideAttachPolicy(det: Detection): AttachDecision {
  try {
    // Positively dangerous: executables, installers, shortcuts, code packages.
    if (det.flags.includes('executable')) {
      return { action: 'reject', rule: 'executable-deny' };
    }
    // Encrypted content cannot be read — reference, never reject.
    if (det.flags.includes('encrypted')) {
      return { action: 'reference_only', rule: 'encrypted-note', note: t('attach.encrypted') };
    }
    // Macros: allowed as reference with a visible warning. Never executed.
    if (det.flags.includes('macros')) {
      return { action: 'reference_only', rule: 'macro-warn', note: t('attach.macros') };
    }
    switch (det.kind) {
      case 'empty':
        return { action: 'reject', rule: 'empty-deny' };
      case 'text':
        return { action: 'inline_text', rule: 'text-inline' };
      case 'rtf':
        return EXTRACTABLE.has('rtf')
          ? { action: 'document_extract', rule: 'doc-extract' }
          : { action: 'reference_only', rule: 'doc-reference', note: t('attach.refonly') };
      case 'png': case 'jpeg': case 'gif': case 'webp':
        return { action: 'image', rule: 'image-inline' };
      case 'docx': case 'xlsx': case 'pptx': case 'odt': case 'ods': case 'odp':
        return EXTRACTABLE.has(det.kind)
          ? { action: 'document_extract', rule: 'doc-extract' }
          : { action: 'reference_only', rule: 'doc-reference', note: t('attach.refonly') };
      case 'pdf': case 'epub':
        return { action: 'reference_only', rule: 'doc-reference', note: t('attach.refonly') };
      case 'zip': case 'zip-corrupt': case 'archive': case 'ole':
      case 'doc': case 'xls': case 'ppt':
      case 'bmp': case 'tiff': case 'heic': case 'mp3': case 'mp4':
      case 'dmg': case 'pkg':
        return { action: 'reference_only', rule: 'known-reference', note: t('attach.seeMeta') };
      default:
        return { action: 'reference_only', rule: 'unknown-reference', note: t('attach.seeMeta') };
    }
  } catch {
    return { action: 'reference_only', rule: 'unknown-reference', note: t('attach.seeMeta') };
  }
}

/** Specific, kind rejection message. Never "executable or unknown content". */
export function formatRejection(name: string, det: Detection, decision: AttachDecision): string {
  const base = baseName(name);
  if (decision.rule === 'empty-deny') return t('attach.reject.prefix', { name: base, what: t('attach.reject.empty') });
  const what = t(REJECT_WHAT_KEY[det.kind] || 'attach.reject.other');
  return t('attach.reject.prefix', { name: base, what }) + '\n' + t('attach.reject.details', { kind: det.kind, evidence: det.evidence, rule: decision.rule });
}

function baseName(name: string): string {
  try {
    return String(name || 'file').split(/[\\/]/).pop() || 'file';
  } catch {
    return 'file';
  }
}
