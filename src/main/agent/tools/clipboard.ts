import type { ToolResult } from '../types';

type ClipboardBackend = {
  read(): string;
  write(text: string): void;
};

let injected: ClipboardBackend | null = null;

/** Test seam: inject a fake clipboard so unit tests never touch the OS. */
export function __setClipboardBackend(b: ClipboardBackend | null): void {
  injected = b;
}

function loadBackend(): ClipboardBackend | null {
  if (injected) return injected;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clipboard } = require('electron') as typeof import('electron');
    return { read: () => clipboard.readText(), write: (t: string) => clipboard.writeText(t) };
  } catch {
    return null;
  }
}

export async function clipboardRead(): Promise<ToolResult> {
  const b = loadBackend();
  if (!b) return { ok: false, output: 'clipboard unavailable' };
  try {
    return { ok: true, output: b.read().slice(0, 8000), source: 'clipboard', untrusted: true };
  } catch (e) {
    return { ok: false, output: `clipboard read failed: ${(e as Error).message}` };
  }
}

export async function clipboardWriteText(text: string): Promise<ToolResult> {
  const b = loadBackend();
  if (!b) return { ok: false, output: 'clipboard unavailable' };
  try {
    b.write(text);
    return { ok: true, output: `wrote ${text.length} chars to clipboard` };
  } catch (e) {
    return { ok: false, output: `clipboard write failed: ${(e as Error).message}` };
  }
}
