import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterFor, platform, __setPlatform } from '../../src/main/platform/index';
import { win32Adapter } from '../../src/main/platform/win32';
import { darwinAdapter } from '../../src/main/platform/darwin';
import { parseAppList, parseLoginEnv, keyLabelFor } from '../../src/main/platform/shared';
import {
  normalizeAndResolve,
  isInsideRoots,
  isPathAllowed,
  decidePolicy,
  type PolicyContext,
} from '../../src/main/agent/permissions';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-plat-'));

const ctxFor = (roots: string[], home?: string): PolicyContext => ({
  allowedRoots: roots,
  explicitRoots: [],
  alwaysAllow: [],
  requireApprovalForWrites: true,
  homeDir: home || roots[0] || '/tmp/fake-home',
});

describe('adapter selection', () => {
  it('picks win32/darwin explicitly and defaults to the host', () => {
    expect(adapterFor('win32').key).toBe('win32');
    expect(adapterFor('darwin').key).toBe('darwin');
    expect(platform().key).toBe(process.platform === 'win32' ? 'win32' : 'darwin');
    __setPlatform(win32Adapter);
    expect(platform().key).toBe('win32');
    __setPlatform(null);
    expect(platform().key).toBe(process.platform === 'win32' ? 'win32' : 'darwin');
  });
  it('exposes shell names, trash words and default hotkeys', () => {
    expect(win32Adapter.shellName).toBe('PowerShell');
    expect(darwinAdapter.shellName).toBe('zsh');
    expect(win32Adapter.trashWord).toBe('Recycle Bin');
    expect(darwinAdapter.trashWord).toBe('Trash');
    // Same Electron syntax on both (Alt == Option); never Spotlight/Force-Quit keys.
    expect(win32Adapter.defaultHotkeys()).toEqual({ toggle: 'Alt+Space', stop: 'Ctrl+Alt+Esc' });
    expect(darwinAdapter.defaultHotkeys()).toEqual({ toggle: 'Alt+Space', stop: 'Ctrl+Alt+Esc' });
  });
});

describe('key labels', () => {
  it('renders Windows caps with + separators', () => {
    expect(win32Adapter.keyLabel('Alt+Space')).toBe('Alt+Space');
    expect(win32Adapter.keyLabel('Ctrl+Alt+Esc')).toBe('Ctrl+Alt+Esc');
  });
  it('renders macOS glyphs without separators', () => {
    expect(darwinAdapter.keyLabel('Alt+Space')).toBe('⌥Space');
    expect(darwinAdapter.keyLabel('Ctrl+Alt+Esc')).toBe('⌃⌥Esc');
    expect(darwinAdapter.keyLabel('CommandOrControl+Shift+X')).toBe('⌘⇧X');
  });
  it('keyLabelFor maps case-insensitively and keeps unknowns', () => {
    expect(keyLabelFor('alt+space', { Alt: '⌥', Space: 'Space' }, '')).toBe('⌥Space');
    expect(keyLabelFor('Ctrl+F13', { Ctrl: '⌃' }, '')).toBe('⌃F13');
  });
});

describe('path normalization per adapter', () => {
  it('NFC-normalizes on darwin, preserves bytes for the FS', () => {
    const nfd = 'Café.txt'.normalize('NFD');
    const out = normalizeAndResolve(nfd, '/tmp', darwinAdapter);
    expect(out).toBe('/tmp/' + 'Café.txt'.normalize('NFC'));
    const nfd2 = 'báo cáo 2026.txt'.normalize('NFD');
    expect(normalizeAndResolve(nfd2, '/tmp', darwinAdapter)).toBe('/tmp/báo cáo 2026.txt');
  });
  it('expands ~ on darwin; literal dirname on win32', () => {
    // ~ reads the host home dir, so the darwin half needs a POSIX host.
    if (process.platform !== 'win32') {
      const home = process.env.HOME || '/tmp';
      expect(normalizeAndResolve('~/a.txt', '/tmp', darwinAdapter)).toBe(`${home}/a.txt`.normalize('NFC'));
    }
    expect(normalizeAndResolve('~/a.txt', 'C:\\w', win32Adapter)).toBe('C:\\w\\~\\a.txt');
  });
  it('rejects UNC/device forms on both adapters', () => {
    for (const a of [win32Adapter, darwinAdapter]) {
      expect(() => normalizeAndResolve('\\\\server\\share', '/tmp', a)).toThrow(/path-rejected/);
      expect(() => normalizeAndResolve('/dev/disk0', '/tmp', a)).toThrow(/path-rejected/);
    }
  });
  it('compares case-insensitively on win32 and darwin, sensitively elsewhere', () => {
    expect(isInsideRoots('C:\\USERS\\A\\f.txt', ['c:\\users\\a'], win32Adapter)).toBe(true);
    // Posix fixtures resolve through the host FS, so the darwin half needs a POSIX host.
    if (process.platform !== 'win32') {
      expect(isInsideRoots('/Users/A/F.txt', ['/users/a'], darwinAdapter)).toBe(true);
    }
  });
});

describe('protected paths per adapter', () => {
  it('win32 blocks Windows dirs, .ssh and browser profiles', () => {
    const ctx = ctxFor(['C:\\Users\\a']);
    expect(isPathAllowed('C:\\Windows\\x', ctx, win32Adapter)).toBe(false);
    expect(isPathAllowed('C:\\Program Files\\x', ctx, win32Adapter)).toBe(false);
    expect(isPathAllowed('C:\\Users\\a\\.ssh\\id', ctx, win32Adapter)).toBe(false);
    expect(isPathAllowed('C:\\Users\\a\\AppData\\Roaming\\Mozilla\\Firefox\\p', ctx, win32Adapter)).toBe(false);
    expect(isPathAllowed('C:\\Users\\a\\doc.txt', ctx, win32Adapter)).toBe(true);
  });
  it('darwin blocks system dirs, keychains, mail, cloud secrets and browser profiles', () => {
    if (process.platform === 'win32') return; // posix protected paths need a POSIX host
    const ctx = ctxFor(['/Users/a']);
    for (const p of ['/System/x', '/Library/x', '/usr/bin/x', '/private/etc/hosts', '/private/tftpboot/x',
      '/private/var/db/x', '/private/var/log/x', '/etc/hosts',
      '/Users/a/Library/Keychains/x', '/Users/a/Library/Mail/x', '/Users/a/Library/Messages/x',
      '/Users/a/.ssh/id', '/Users/a/.aws/x', '/Users/a/.gnupg/x',
      '/Users/a/Library/Application Support/Google/Chrome/x', '/Users/a/Library/Safari/x']) {
      expect(isPathAllowed(p, ctx, darwinAdapter)).toBe(false);
    }
    expect(isPathAllowed('/Users/a/Documents/x', ctx, darwinAdapter)).toBe(true);
  });
  it('darwin /Applications is write-blocked but readable', () => {
    if (process.platform === 'win32') return; // write-protected posix paths need a POSIX host
    const ctx = ctxFor(['/']);
    expect(decidePolicy('fs_read', 'read', { path: '/Applications/App.app' }, ctx, '/', darwinAdapter).action).not.toBe('denied');
    expect(decidePolicy('fs_write', 'write', { path: '/Applications/x' }, ctx, '/', darwinAdapter))
      .toMatchObject({ action: 'denied' });
  });
  it('explicit roots override blocks on both adapters', () => {
    const wctx: PolicyContext = { ...ctxFor(['C:\\x']), explicitRoots: ['C:\\Windows\\Temp'] };
    expect(isPathAllowed('C:\\Windows\\Temp\\f', wctx, win32Adapter)).toBe(true);
    const dctx: PolicyContext = { ...ctxFor(['/x']), explicitRoots: ['/etc'] };
    expect(isPathAllowed('/etc/hosts', dctx, darwinAdapter)).toBe(true);
  });
  it('darwin rejects foreign volumes unless allowed', () => {
    if (process.platform === 'win32') return; // /Volumes fixtures need a POSIX host
    const ctx = ctxFor(['/Users/a']);
    expect(isPathAllowed('/Volumes/USB/x', ctx, darwinAdapter)).toBe(false);
    const allowed: PolicyContext = { ...ctxFor(['/Volumes/USB']), explicitRoots: [] };
    expect(isPathAllowed('/Volumes/USB/x', allowed, darwinAdapter)).toBe(true);
  });
});

describe('permission matrix runs on both adapters', () => {
  for (const a of [win32Adapter, darwinAdapter]) {
    it(`write needs approval on ${a.key}`, () => {
      const root = a.key === 'win32' ? 'C:\\work' : '/work';
      const ctx = ctxFor([root]);
      const d = decidePolicy('fs_write', 'write', { path: a.key === 'win32' ? 'C:\\work\\n.txt' : '/work/n.txt' }, ctx, root, a);
      expect(d.action).toBe('approval-required');
    });
    it(`read inside roots is auto on ${a.key}`, () => {
      if (a.key === 'darwin' && process.platform === 'win32') return; // posix fixtures need a POSIX host
      const root = a.key === 'win32' ? 'C:\\work' : '/work';
      const ctx = ctxFor([root]);
      const d = decidePolicy('fs_read', 'read', { path: a.key === 'win32' ? 'C:\\work\\a.txt' : '/work/a.txt' }, ctx, root, a);
      expect(d.action).toBe('auto');
    });
  }
});

describe('symlink escape (both adapters)', () => {
  // FS-dependent: each adapter case runs on its native host family only.
  // Pure-string matrix coverage (protected paths, NFC, case rules) runs everywhere above.
  const cases: Array<{ a: typeof win32Adapter; host: NodeJS.Platform | null }> = [
    { a: win32Adapter, host: 'win32' },
    { a: darwinAdapter, host: null },
  ];
  for (const { a, host } of cases) {
    it(`blocks links resolving outside roots on ${a.key}`, () => {
      if (host && process.platform !== host) return;
      const root = tmpRoot();
      const outside = tmpRoot();
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      try {
        fs.symlinkSync(outside, path.join(root, 'link'));
      } catch {
        return; // no symlink privilege on this host; macOS CI covers it
      }
      const ctx = ctxFor([root]);
      const d = decidePolicy(
        'fs_read', 'read', { path: path.join(root, 'link', 'secret.txt') }, ctx, root, a);
      expect(d.action).toBe('denied');
      fs.writeFileSync(path.join(root, 'real.txt'), 'x');
      expect(decidePolicy('fs_read', 'read', { path: path.join(root, 'real.txt') }, ctx, root, a).action)
        .toBe('auto');
    });
  }
});

describe('integration (native host only)', () => {
  const a = adapterFor(process.platform === 'win32' ? 'win32' : 'darwin');
  const sleep60 = a.key === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';
  it('shell timeout kills at the deadline', async () => {
    const t0 = Date.now();
    const r = await a.runShell(sleep60, { cwd: os.tmpdir(), signal: new AbortController().signal, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);
  it('abort kills the run fast with a stopped marker', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = a.runShell(sleep60, { cwd: os.tmpdir(), signal: ctrl.signal, timeoutMs: 30_000 });
    setTimeout(() => ctrl.abort(), 300);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);
  // Real OS trash needs Electron; plain-node CI skips these (documented).
  const itElectron = (process.versions as { electron?: string }).electron ? it : it.skip;
  itElectron('trash removes the file without deleting it', async () => {
    const dir = tmpRoot();
    const f = path.join(dir, 'gone.txt');
    fs.writeFileSync(f, 'x');
    await a.trashItem(f);
    expect(fs.existsSync(f)).toBe(false);
  });
});
describe('login env parsing', () => {
  it('parses KEY=VALUE lines with quotes', () => {
    const env = parseLoginEnv('PATH="/usr/bin:/bin"\nEMPTY=\n# comment\nFOO=bar\n');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.FOO).toBe('bar');
  });
});

describe('app list parsing', () => {
  it('dedupes and caps tasklist/ps output', () => {
    // Same parsing both OSes use: first CSV field, deduped, capped.
    const apps = parseAppList('"notepad.exe","123"\n"notepad.exe","124"\n');
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toContain('notepad.exe');
    expect(parseAppList('Finder\nSafari\n').map((a) => a.name)).toEqual(['Finder', 'Safari']);
    expect(parseAppList(Array.from({ length: 400 }, (_, i) => `app${i}`).join('\n'))).toHaveLength(300);
  });
});
