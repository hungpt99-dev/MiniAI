import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Channel strings live only in shared/ipc-channels. Any other quoted
// literal is a second source of truth (rename drift, missed handler).
// Patterns are concatenated so this file holds no literal itself.
const NEEDLE_A = 'nex' + 'io:';
const NEEDLE_B = 'mini' + 'ai:';
const CANON = `shared${path.sep}ipc-channels.ts`;
const SELF = 'ipc-no-literals.test.ts';

function sources(): string[] {
  const out: string[] = [];
  for (const root of ['src', 'tests']) {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.m?[tj]sx?$/.test(e.name)) out.push(p);
      }
    };
    walk(path.join(process.cwd(), root));
  }
  return out;
}

describe('ipc channel literals', () => {
  it('has no quoted channel literals outside the canonical map', () => {
    const hits: string[] = [];
    for (const f of sources()) {
      if (f.endsWith(CANON) || f.endsWith(SELF)) continue;
      const text = fs.readFileSync(f, 'utf8');
      // Quoted literals only: comments and bridge property names are fine.
      const re = new RegExp(`("|'|\`)(${NEEDLE_A}|${NEEDLE_B})`, 'i');
      if (re.test(text)) hits.push(path.relative(process.cwd(), f));
    }
    expect(hits).toEqual([]);
  });
});
