import fs from 'node:fs';
import type { Tool } from '../types';
import { decodeText } from '../../attachments';
import { safeSlice, decodeAttachmentText } from '../../attachments/decode';

export interface RunAttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  kind: 'image' | 'file' | 'text';
}

const RUN_REFS = new Map<string, RunAttachmentRef[]>();

/** Test seam + IPC bridge: stage a run's attachments for Do-context tools. */
export function registerRunAttachments(runId: string, refs: RunAttachmentRef[]): void {
  RUN_REFS.set(runId, [...refs]);
}
export function getRunAttachments(runId: string): RunAttachmentRef[] {
  return [...(RUN_REFS.get(runId) || [])];
}
export function clearRunAttachments(runId: string): void {
  RUN_REFS.delete(runId);
}
export function __resetAttachmentRefsForTests(): void {
  RUN_REFS.clear();
}

/** Typed read failure codes — the model reports the exact code, never a vague guess. */
export type AttachReadCode =
  | 'NOT_FOUND' | 'OUTSIDE_ALLOWED_ROOTS' | 'PERMISSION_DENIED' | 'FILE_LOCKED'
  | 'TOO_LARGE' | 'BINARY_CONTENT' | 'ENCODING_UNKNOWN' | 'REDACTED_ONLY' | 'TEMP_COPY_MISSING';

function fail(code: AttachReadCode, message: string) {
  return { ok: false as const, code, output: `[${code}] ${message}` };
}

export const attachmentListTool: Tool = {
  name: 'attachment_list',
  description: 'List files attached to this run (name, type, size). Read-only.',
  inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'Run id' } }, required: ['runId'] },
  risk: 'read',
  askSafe: true,
  describe: (input) => `List attachments for run ${String(input.runId || '')}`,
  run: async (input) => {
    const runId = String(input.runId || '');
    const refs = RUN_REFS.get(runId) || [];
    if (!refs.length) return { ok: true, output: 'No attachments for this run.' };
    const lines = refs.map((r) => `- ${r.name} (${r.mime}, ${r.size} bytes, sha256:${r.sha256.slice(0, 12)}…)`);
    return { ok: true, output: lines.join('\n'), untrusted: true, source: `attachments of ${runId}` };
  },
};

export const attachmentReadTool: Tool = {
  name: 'attachment_read',
  description: 'Read one attached file as text (capped, untrusted). Images return a note — vision handles pixels. Reports exact failure codes; never claim to have read a file unless content is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      id: { type: 'string', description: 'Attachment id or file name' },
      maxBytes: { type: 'number' },
      startLine: { type: 'number', description: '1-based first line for chunked reads' },
      maxLines: { type: 'number', description: 'Max lines for chunked reads' },
    },
    required: ['runId', 'id'],
  },
  risk: 'read',
  askSafe: true,
  describe: (input) => `Read attachment ${String(input.id || '')}`,
  run: async (input) => {
    const runId = String(input.runId || '');
    const id = String(input.id || '');
    const refs = RUN_REFS.get(runId) || [];
    const ref = refs.find((r) => r.id === id) || refs.find((r) => r.name === id);
    if (!ref) return fail('NOT_FOUND', `unknown attachment: ${id}`);
    if (ref.kind === 'image') {
      return { ok: true, output: `[image ${ref.name} (${ref.mime}, ${ref.size} bytes) — pixels are in the message, not this text]`, untrusted: true, source: ref.name };
    }
    const max = Math.min(Number(input.maxBytes) || 20_000, 200_000);
    let buf: Buffer;
    try { buf = fs.readFileSync(ref.path); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return fail('TEMP_COPY_MISSING', `attachment temp copy missing: ${ref.name}`);
      if (code === 'EACCES' || code === 'EPERM') return fail('PERMISSION_DENIED', `no permission to read attachment: ${ref.name}`);
      if (code === 'EBUSY') return fail('FILE_LOCKED', `attachment locked by another process: ${ref.name}`);
      return fail('NOT_FOUND', `cannot read attachment: ${ref.name}`);
    }
    const { text, truncated, encoding } = decodeText(buf);
    // why: decodeText falls back to raw UTF-8 for logging safety — the tool
    // gate must use the strict verdict so binary never reaches the model.
    if (!decodeAttachmentText(buf) || !text.trim()) {
      if (buf.length > 0) return fail('BINARY_CONTENT', `${ref.name} is binary content, not decodable text`);
      return fail('NOT_FOUND', `${ref.name} is empty`);
    }
    // Chunked line ranges (code-point safe, never splits surrogate pairs).
    const startLine = Math.max(1, Math.floor(Number(input.startLine) || 1));
    const maxLines = Math.min(Math.max(1, Math.floor(Number(input.maxLines) || 500)), 5000);
    const lines = text.split('\n');
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
    let out = safeSlice(slice.join('\n'), 0, max);
    const hasMore = startLine - 1 + maxLines < lines.length || truncated || buf.length > max;
    const head = `[${ref.name} — ${encoding}, lines ${startLine}–${startLine + slice.length - 1} of ${lines.length}]`;
    if (hasMore) out += `\n…[truncated — read more with startLine=${startLine + slice.length}]`;
    return { ok: true, output: `${head}\n${out}`, untrusted: true, source: ref.name };
  },
};
