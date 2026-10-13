import { execFile, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AppInfo, PlatformAdapter, ShellRunOpts, ShellRunResult } from './types';
import { runShellImpl } from './runner';
import { keyLabelFor, keyTokensFor, openFallback, parseAppList, parseLoginEnv } from './shared';

const LOGIN_ENV_TIMEOUT_MS = 5000;
let loginEnvCache: NodeJS.ProcessEnv | null = null;

function appDataDir(appName: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  } catch {
    return path.join(os.homedir() || '.', 'Library', 'Application Support', appName);
  }
}

async function readLoginEnv(shellBin: string): Promise<NodeJS.ProcessEnv> {
  if (loginEnvCache) return loginEnvCache;
  const out = await new Promise<string>((resolve) => {
    const child = execFile(shellBin, ['-ilc', 'env'], { timeout: LOGIN_ENV_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
    child.on('error', () => resolve(''));
  });
  const parsed = out ? parseLoginEnv(out) : {};
  loginEnvCache = { ...process.env, ...parsed };
  return loginEnvCache;
}

/** Test seam: drop the cached login env between tests. */
export function __resetLoginEnvCache(): void {
  loginEnvCache = null;
}

export const darwinAdapter: PlatformAdapter = {
  key: 'darwin',
  shellName: 'zsh',
  trashWord: 'Trash',
  // APFS is case-insensitive by default; compare case-insensitively.
  caseSensitiveFs: false,

  async runShell(command: string, opts: ShellRunOpts): Promise<ShellRunResult> {
    const bin = darwinAdapter.loginShellBin();
    let env = opts.env;
    if (!env) {
      try {
        env = await readLoginEnv(bin);
      } catch {
        env = process.env;
      }
    }
    return runShellImpl(
      bin, ['-c', command],
      { ...opts, env },
      { detached: true },
      (c) => darwinAdapter.killTree(c),
    );
  },
  killTree(child: ChildProcess): void {
    try {
      // Negative pid kills the whole process group (spawned detached).
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch { /* fall through to single kill */ }
      }
      child.kill('SIGKILL');
    } catch { /* already dead */ }
  },
  shellForCommand(command: string): { bin: string; args: string[] } {
    return { bin: darwinAdapter.loginShellBin(), args: ['-c', command] };
  },
  async loginEnv(): Promise<NodeJS.ProcessEnv> {
    try {
      return await readLoginEnv(darwinAdapter.loginShellBin());
    } catch {
      return process.env;
    }
  },
  loginShellBin(): string {
    const sh = process.env.SHELL || '';
    if (sh.endsWith('/zsh') || sh.endsWith('/bash')) return sh;
    return '/bin/zsh';
  },

  listApps(signal: AbortSignal): Promise<AppInfo[]> {
    // ps needs no Accessibility/Automation permission (no AppleScript by default).
    return new Promise((resolve, reject) => {
      const child = execFile('/bin/ps', ['-axco', 'comm'], { timeout: 10_000 }, (err, stdout) => {
        if (signal.aborted) return reject(new Error('Aborted'));
        if (err && !stdout) return reject(err);
        resolve(parseAppList(String(stdout || '')));
      });
      signal.addEventListener('abort', () => { try { child.kill(); } catch { /* noop */ } }, { once: true });
    });
  },
  async openTarget(target: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require('electron') as typeof import('electron');
      if (/^https?:/i.test(target)) {
        await shell.openExternal(target);
        return;
      }
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
    } catch (e) {
      // Outside Electron (dev/tests): fall back to open(1).
      if (/^https?:/i.test(target)) throw e;
      await openFallback(target, 'darwin');
    }
  },
  async trashItem(p: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    await shell.trashItem(p);
  },

  protectedPaths(homeDir?: string): string[] {
    const home = homeDir || os.homedir() || '~';
    return [
      '/System',
      '/Library',
      '/usr',
      '/bin',
      '/sbin',
      '/private',
      '/etc',
      path.join(home, 'Library', 'Keychains'),
      path.join(home, 'Library', 'Mail'),
      path.join(home, 'Library', 'Messages'),
      path.join(home, '.ssh'),
      path.join(home, '.aws'),
      path.join(home, '.gnupg'),
    ];
  },
  writeProtectedPaths(): string[] {
    return ['/Applications'];
  },
  fsErrorHint(op: 'read' | 'write' | 'list' | 'search', err: unknown): string | null {
    const code = (err as { code?: string })?.code;
    if (code !== 'EPERM' && code !== 'EACCES') return null;
    const what = op === 'list' ? 'list this folder' : op === 'search' ? 'search here' : op === 'write' ? 'write here' : 'read this';
    return (
      `macOS blocked Nexio trying to ${what} (permission denied). ` +
      `Allow Nexio in System Settings > Privacy & Security > Files and Folders, then try again. ` +
      `Open: x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders`
    );
  },
  normalizeForCompare(p: string): string {
    // Decomposed Unicode (NFD) on disk; compare + display in composed (NFC) form.
    return p.normalize('NFC').toLowerCase();
  },
  expandUser(p: string): string {
    if (p === '~' || p.startsWith('~/')) return path.join(os.homedir() || '~', p.slice(p === '~' ? 1 : 2));
    return p;
  },

  defaultHotkeys(): { toggle: string; stop: string } {
    // Electron uses Alt for Option; never Cmd+Space (Spotlight) or Cmd+Option+Esc (Force Quit).
    return { toggle: 'Alt+Space', stop: 'Ctrl+Alt+Esc' };
  },
  keyCaps(): { alt: string; ctrl: string; shift: string; cmd: string; esc: string; space: string } {
    return { alt: '⌥', ctrl: '⌃', shift: '⇧', cmd: '⌘', esc: 'Esc', space: 'Space' };
  },
  keyLabel(accel: string): string {
    return keyLabelFor(
      accel,
      { Alt: '⌥', Option: '⌥', Control: '⌃', Ctrl: '⌃', Shift: '⇧', Command: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Cmd: '⌘', Escape: 'Esc', Esc: 'Esc', Space: 'Space' },
      '',
    );
  },
  keyTokens(accel: string): string[] {
    return keyTokensFor(
      accel,
      { Alt: '⌥', Option: '⌥', Control: '⌃', Ctrl: '⌃', Shift: '⇧', Command: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Cmd: '⌘', Escape: 'Esc', Esc: 'Esc', Space: 'Space' },
    );
  },

  secrets: {
    available(): boolean {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { safeStorage } = require('electron') as typeof import('electron');
        return safeStorage != null && safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt(s: string): Buffer {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { safeStorage } = require('electron') as typeof import('electron');
      return safeStorage.encryptString(s);
    },
    decrypt(b: Buffer): string {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { safeStorage } = require('electron') as typeof import('electron');
      return safeStorage.decryptString(b);
    },
  },

  defaultDataDir(appName: string): string {
    return appDataDir(appName);
  },
  defaultLogsDir(appName: string, dbFile: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron');
      return app.getPath('logs');
    } catch {
      return path.join(path.dirname(dbFile), 'logs');
    }
  },
};

/** Async login-shell env for child processes (cached, short timeout). */
export async function darwinLoginEnv(): Promise<NodeJS.ProcessEnv> {
  return darwinAdapter.loginEnv();
}
