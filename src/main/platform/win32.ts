import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AppInfo, PlatformAdapter, ShellRunOpts, ShellRunResult } from './types';
import { runShellImpl } from './runner';
import { keyLabelFor, keyTokensFor, openFallback, parseAppList } from './shared';

function appDataDir(appName: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  } catch {
    return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), appName);
  }
}

export const win32Adapter: PlatformAdapter = {
  key: 'win32',
  shellName: 'PowerShell',
  trashWord: 'Recycle Bin',
  caseSensitiveFs: false,

  runShell(command: string, opts: ShellRunOpts): Promise<ShellRunResult> {
    return runShellImpl(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { ...opts, env: opts.env || process.env },
      { windowsHide: true },
      (c) => win32Adapter.killTree(c),
    );
  },
  killTree(child: ChildProcess): void {
    try {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch { /* fall through to kill */ }
      child.kill('SIGKILL');
    } catch { /* already dead */ }
  },
  shellForCommand(command: string): { bin: string; args: string[] } {
    // PowerShell -Command maps any native failure to exit 1; forward the real code.
    return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`] };
  },
  async loginEnv(): Promise<NodeJS.ProcessEnv> {
    return process.env;
  },
  loginShellBin(): string {
    return 'powershell';
  },

  listApps(signal: AbortSignal): Promise<AppInfo[]> {
    return new Promise((resolve, reject) => {
      const child = execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
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
      // Outside Electron (dev/tests): fall back to cmd/open.
      if (/^https?:/i.test(target)) throw e;
      await openFallback(target, 'win32');
    }
  },
  async trashItem(p: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    await shell.trashItem(p);
  },

  protectedPaths(_homeDir?: string): string[] {
    return [
      process.env.SystemRoot || 'C:\\Windows',
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env.ProgramData || 'C:\\ProgramData',
    ];
  },
  writeProtectedPaths(): string[] {
    return [];
  },
  fsErrorHint(_op: 'read' | 'write' | 'list' | 'search', _err: unknown): string | null {
    return null;
  },
  normalizeForCompare(p: string): string {
    return path.win32.normalize(p).toLowerCase();
  },
  expandUser(p: string): string {
    return p; // no ~ expansion on Windows
  },

  defaultHotkeys(): { toggle: string; stop: string } {
    return { toggle: 'Alt+Space', stop: 'Ctrl+Alt+Esc' };
  },
  keyCaps(): { alt: string; ctrl: string; shift: string; cmd: string; esc: string; space: string } {
    return { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', cmd: 'Win', esc: 'Esc', space: 'Space' };
  },
  keyLabel(accel: string): string {
    return keyLabelFor(accel, { Alt: 'Alt', Control: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Escape: 'Esc', Esc: 'Esc', Space: 'Space' }, '+');
  },
  keyTokens(accel: string): string[] {
    return keyTokensFor(accel, { Alt: 'Alt', Control: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Escape: 'Esc', Esc: 'Esc', Space: 'Space' });
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
