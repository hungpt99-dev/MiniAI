import type { NormalizedRequest, ProviderCapabilities } from './types';

/** Thrown when image parts reach a model without vision. Never carries bytes. */
export class VisionNotSupportedError extends Error {
  imageCount: number;
  constructor(imageCount: number) {
    super(`vision-not-supported: this model does not support images (${imageCount} image(s) held back, bytes never sent)`);
    this.name = 'VisionNotSupportedError';
    this.imageCount = imageCount;
  }
}

export function hasImageParts(req: NormalizedRequest): boolean {
  for (const m of req.messages) {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c) && (c as Array<{ type?: string }>).some((p) => p?.type === 'image')) return true;
  }
  return false;
}

export function countImages(req: NormalizedRequest): number {
  let n = 0;
  for (const m of req.messages) {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c)) for (const p of c as Array<{ type?: string }>) if (p?.type === 'image') n++;
  }
  return n;
}

/** Text-only projection of file_ref parts (bytes never cross this boundary). */
export function fileRefText(name: string, mime: string, size: number, sha: string, text: string): string {
  const head = `[attached file: ${name} (${mime}, ${size} bytes, sha256:${sha.slice(0, 12)}…)]`;
  return text ? `${head}\n${text}` : head;
}

/**
 * Enforce vision caps before building a request. Throws VisionNotSupportedError
 * when images meet a non-vision model (caller shows the notice + switch, once),
 * or a plain Error on oversize/overcount (caller surfaces inline, never silent).
 */
export function assertVision(req: NormalizedRequest, caps: ProviderCapabilities): void {
  const images: Array<{ bytes?: number }> = [];
  for (const m of req.messages) {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c)) for (const p of c as Array<{ type?: string; bytes?: number }>) if (p?.type === 'image') images.push(p);
  }
  if (!images.length) return;
  if (!caps.supportsVision) throw new VisionNotSupportedError(images.length);
  if (images.length > caps.maxImages) throw new Error(`oversize: too many images (${images.length} > ${caps.maxImages})`);
  for (const im of images) {
    if (typeof im.bytes === 'number' && im.bytes > caps.maxBytes) throw new Error('oversize: image exceeds per-image byte cap');
  }
}

/** OpenAI-shape content: string stays a string; parts become text/image_url blocks. file_ref is text only. */
export function toOpenAIContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of content as Array<{ type?: string; text?: string; dataUrl?: string; name?: string; mimeType?: string; size?: number; sha256?: string }>) {
    if (p?.type === 'text') blocks.push({ type: 'text', text: p.text || '' });
    else if (p?.type === 'image' && p.dataUrl) blocks.push({ type: 'image_url', image_url: { url: p.dataUrl } });
    else if (p?.type === 'file_ref') blocks.push({ type: 'text', text: fileRefText(p.name || 'file', p.mimeType || 'text/plain', p.size || 0, p.sha256 || '', p.text || '') });
  }
  if (!blocks.length) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return String(blocks[0].text || '');
  return blocks;
}

/** Anthropic-shape content: string stays a string; parts become text/image blocks. file_ref is text only. */
export function toAnthropicContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of content as Array<{ type?: string; text?: string; dataUrl?: string; mimeType?: string; name?: string; size?: number; sha256?: string }>) {
    if (p?.type === 'text') blocks.push({ type: 'text', text: p.text || '' });
    else if (p?.type === 'image' && p.dataUrl) {
      const comma = p.dataUrl.indexOf(',');
      const data = comma >= 0 ? p.dataUrl.slice(comma + 1) : p.dataUrl;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType || 'image/png', data } });
    } else if (p?.type === 'file_ref') blocks.push({ type: 'text', text: fileRefText(p.name || 'file', p.mimeType || 'text/plain', p.size || 0, p.sha256 || '', p.text || '') });
  }
  if (!blocks.length) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return String(blocks[0].text || '');
  return blocks;
}
