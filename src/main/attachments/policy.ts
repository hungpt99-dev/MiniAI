/** Attachment policy: WHAT may Nexio do with it (per detected kind, one table). */
import type { AttachKind, Detection } from './detect';

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

const REJECT_MESSAGE: Record<string, string> = {
  exe: 'an executable (Windows program)',
  elf: 'an executable (Linux program)',
  macho: 'an executable (macOS program)',
  msi: 'a Windows installer',
  lnk: 'a Windows shortcut',
  url: 'an internet shortcut',
  scf: 'an internet shortcut',
  appx: 'a Windows app package',
  jar: 'a Java package (may contain code)',
  apk: 'an Android package (may contain code)',
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
      return { action: 'reference_only', rule: 'encrypted-note', note: 'Encrypted. Contents not readable.' };
    }
    // Macros: allowed as reference with a visible warning. Never executed.
    if (det.flags.includes('macros')) {
      return { action: 'reference_only', rule: 'macro-warn', note: 'Contains macros. Nexio will not run it.' };
    }
    switch (det.kind) {
      case 'empty':
        return { action: 'reject', rule: 'empty-deny' };
      case 'text':
        return { action: 'inline_text', rule: 'text-inline' };
      case 'rtf':
        return EXTRACTABLE.has('rtf')
          ? { action: 'document_extract', rule: 'doc-extract' }
          : { action: 'reference_only', rule: 'doc-reference', note: 'Added as reference only, contents not read.' };
      case 'png': case 'jpeg': case 'gif': case 'webp':
        return { action: 'image', rule: 'image-inline' };
      case 'docx': case 'xlsx': case 'pptx': case 'odt': case 'ods': case 'odp':
        return EXTRACTABLE.has(det.kind)
          ? { action: 'document_extract', rule: 'doc-extract' }
          : { action: 'reference_only', rule: 'doc-reference', note: 'Added as reference only, contents not read.' };
      case 'pdf': case 'epub':
        return { action: 'reference_only', rule: 'doc-reference', note: 'Added as reference only, contents not read.' };
      case 'zip': case 'zip-corrupt': case 'archive': case 'ole':
      case 'doc': case 'xls': case 'ppt':
      case 'bmp': case 'tiff': case 'heic': case 'mp3': case 'mp4':
      case 'dmg': case 'pkg':
        return { action: 'reference_only', rule: 'known-reference', note: 'Nexio can see the file name and path but not its contents.' };
      default:
        return { action: 'reference_only', rule: 'unknown-reference', note: 'Nexio can see the file name and path but not its contents.' };
    }
  } catch {
    return { action: 'reference_only', rule: 'unknown-reference', note: 'Nexio can see the file name and path but not its contents.' };
  }
}

/** Specific, kind rejection message. Never "executable or unknown content". */
export function formatRejection(name: string, det: Detection, decision: AttachDecision): string {
  const base = baseName(name);
  if (decision.rule === 'empty-deny') return `Not attached: ${base} is empty.`;
  const what = REJECT_MESSAGE[det.kind] || 'a file type Nexio cannot accept';
  return `Not attached: ${base} is ${what}.\nDetails: detected ${det.kind} (${det.evidence}), rule ${decision.rule}.`;
}

function baseName(name: string): string {
  try {
    return String(name || 'file').split(/[\\/]/).pop() || 'file';
  } catch {
    return 'file';
  }
}
