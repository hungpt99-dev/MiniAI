import fs from 'node:fs';
import type { Tool } from '../types';
import { decodeText } from '../../attachments';

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

export const attachmentListTool: Tool = {
  name: 'attachment_list',
  description: 'List files attached to this run (name, type, size). Read-only.',
  inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'Run id' } }, required: ['runId'] },
  risk: 'read',
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
  description: 'Read one attached file as text (capped, untrusted). Images return a note — vision handles pixels.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' }, id: { type: 'string', description: 'Attachment id or file name' }, maxBytes: { type: 'number' } },
    required: ['runId', 'id'],
  },
  risk: 'read',
  describe: (input) => `Read attachment ${String(input.id || '')}`,
  run: async (input) => {
    const runId = String(input.runId || '');
    const id = String(input.id || '');
    const refs = RUN_REFS.get(runId) || [];
    const ref = refs.find((r) => r.id === id || r.name === id);
    if (!ref) return { ok: false, output: `unknown attachment: ${id}` };
    if (ref.kind === 'image') {
      return { ok: true, output: `[image ${ref.name} (${ref.mime}, ${ref.size} bytes) — pixels are in the message, not this text]`, untrusted: true, source: ref.name };
    }
    const max = Math.min(Number(input.maxBytes) || 20_000, 200_000);
    let buf: Buffer;
    try { buf = fs.readFileSync(ref.path); }
    catch { return { ok: false, output: `cannot read attachment: ${ref.name}` }; }
    const { text, truncated } = decodeText(buf);
    const out = text.slice(0, max) + (truncated || buf.length > max ? `\n…[truncated]` : '');
    return { ok: true, output: out, untrusted: true, source: ref.name };
  },
};
