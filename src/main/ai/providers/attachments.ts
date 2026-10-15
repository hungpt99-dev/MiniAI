import type { NormalizedRequest, ProviderCapabilities } from './types';

/**
 * Native attachment capabilities per provider/model: which MIME types ride
 * the provider's own file/document/image input instead of local extraction.
 * Images keep the shared vision caps; documents carry per-file and
 * per-request byte caps (base64 inflates ~33%, enforced before sending).
 * PDF page caps are documented here but enforced by the provider (counting
 * pages locally would reintroduce local PDF parsing on the send path).
 */
export interface DocumentCap {
  mime: string;
  maxBytes: number;
  /** Documented provider page cap, when the provider publishes one. */
  maxPages?: number;
}

export interface AttachmentCapabilities {
  provider: string;
  images: { maxCount: number; maxBytes: number; maxSide: number; types: string[] } | null;
  documents: DocumentCap[];
  /** Max encoded request payload (file bytes + ~33% base64 + the rest). */
  maxRequestBytes: number;
}

/** Thrown when a file meets a provider/model that cannot read it natively. Never carries bytes. */
export class UnsupportedAttachmentError extends Error {
  provider: string;
  mime: string;
  constructor(provider: string, mime: string, name: string) {
    super(`${provider} can't read ${extOf(name)} directly`);
    this.name = 'UnsupportedAttachmentError';
    this.provider = provider;
    this.mime = mime;
  }
}

function extOf(name: string): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(base);
  return m ? `.${m[1].toLowerCase()}` : 'this file type';
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  compatible: 'Custom',
};

export function attachmentProviderLabel(provider: string): string {
  return PROVIDER_LABEL[provider] || provider || 'Custom';
}

/**
 * Per-provider native attachment map. Shapes verified 2026-10-15:
 * Anthropic Messages base64 `document` blocks (PDF; 32MB request, 100 pages
 * under 1M context / 600 above; plain text also accepted; .docx/.xlsx not
 * supported); OpenAI/compatible Chat Completions `image_url` data URLs and
 * the Chat Completions `file` content part for PDFs (Nexio uses the Chat
 * Completions endpoint — Responses API file shape not used here);
 * Gemini rides the OpenAI-compat endpoint, so it mirrors the OpenAI shape.
 * Compatible (Ollama and others) takes images only, when vision-capable.
 */
export function getAttachmentCapabilities(provider: string, model: string, vision: ProviderCapabilities): AttachmentCapabilities {
  const images = vision.supportsVision
    ? { maxCount: vision.maxImages, maxBytes: vision.maxBytes, maxSide: vision.maxSide, types: [...vision.supportedTypes] }
    : null;
  switch (provider) {
    case 'anthropic':
      return {
        provider,
        images,
        documents: images ? [{ mime: 'application/pdf', maxBytes: 20 * 1024 * 1024, maxPages: 100 }] : [],
        maxRequestBytes: 32 * 1024 * 1024,
      };
    case 'openai':
    case 'gemini':
      return {
        provider,
        images,
        documents: images ? [{ mime: 'application/pdf', maxBytes: 20 * 1024 * 1024 }] : [],
        maxRequestBytes: 50 * 1024 * 1024,
      };
    default:
      // Compatible: images only, when the model is vision-capable; all files unsupported.
      void model;
      return { provider, images, documents: [], maxRequestBytes: 50 * 1024 * 1024 };
  }
}

function collectParts(req: NormalizedRequest): Array<{ type?: string; mimeType?: string; bytes?: number; size?: number; dataBase64?: string }> {
  const out: Array<{ type?: string; mimeType?: string; bytes?: number; size?: number; dataBase64?: string }> = [];
  for (const m of req.messages) {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c)) for (const p of c as Array<{ type?: string }>) out.push(p as { type?: string });
  }
  return out;
}

/**
 * Enforce native attachment caps before building a request. Throws
 * UnsupportedAttachmentError for non-native types (caller shows the notice +
 * Switch model flow, bytes never sent) or a plain Error naming which limit
 * (per-file, count, request size with base64 inflation) was hit.
 */
export function assertAttachments(req: NormalizedRequest, caps: AttachmentCapabilities): void {
  const parts = collectParts(req);
  const docs = parts.filter((p) => p?.type === 'document');
  if (!docs.length) return;
  const label = attachmentProviderLabel(caps.provider);
  const byMime = new Map(caps.documents.map((d) => [d.mime, d]));
  let encodedTotal = 0;
  for (const d of docs) {
    const mime = d.mimeType || 'application/octet-stream';
    const cap = byMime.get(mime);
    if (!cap) throw new UnsupportedAttachmentError(label, mime, (d as { name?: string }).name || 'file');
    const raw = typeof d.size === 'number' ? d.size : typeof d.bytes === 'number' ? d.bytes : 0;
    if (raw > cap.maxBytes) throw new Error(`oversize: ${(d as { name?: string }).name || 'file'} exceeds the ${label} per-file cap`);
    encodedTotal += Math.ceil(raw * 4 / 3);
  }
  if (encodedTotal > caps.maxRequestBytes) throw new Error(`oversize: attachments exceed the ${label} request size cap`);
}
