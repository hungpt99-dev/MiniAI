import type { AppInfo } from './types';
import { spawn } from 'node:child_process';

/** Fallback open when Electron shell is unavailable (dev/tests): cmd/open. */
export function openFallback(target: string, key: 'win32' | 'darwin'): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = key === 'win32' ? 'cmd' : 'open';
    const args = key === 'win32' ? ['/c', 'start', '""', target] : [target];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.unref();
  });
}

/** Split an accelerator on '+' and map known modifier tokens. */
export function keyTokensFor(accel: string, map: Record<string, string>): string[] {
  return accel
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const hit = Object.entries(map).find(([k]) => k.toLowerCase() === p.toLowerCase());
      return hit ? hit[1] : p;
    });
}

/** Join tokens: concatenated glyphs on mac, '+' on Windows. */
export function keyLabelFor(accel: string, map: Record<string, string>, sep: string): string {
  return keyTokensFor(accel, map).join(sep);
}

/** Parse tasklist CSV / ps comm output into a deduped, capped app-name list. */
export function parseAppList(raw: string): AppInfo[] {
  const names = [...new Set(
    raw.split('\n').map((l) => l.trim().replace(/^"|"$/g, '').split(',')[0].trim()).filter(Boolean),
  )].slice(0, 300);
  return names.map((name) => ({ name }));
}

/** Parse `KEY=VALUE` lines (handles quotes like a login shell would print them). */
export function parseLoginEnv(text: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[m[1]] = v;
  }
  return out;
}
