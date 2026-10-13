import { dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IpcChannels } from '../../shared/ipc-channels';
import type { PolicyContext } from '../agent/types';
import {
  defaultAllowedRoots,
  isInsideRoots,
  isPathAllowed,
  normalizeAndResolve,
} from '../agent/permissions';
import { platform } from '../platform/index';

// Native dialogs and shell opens steal focus from the popup, whose blur
// handler hides the window on focus loss. Everything native runs inside
// withDialogLock so blur stands down; refocus hands focus back afterwards.

/** Blur stays suppressed this long after a dialog closes (focus lands late). */
export const DIALOG_BLUR_GRACE_MS = 300;

let lockCount = 0;
let lastClosedAt = 0;
let lastUsedDir = '';

/** Test seam: reset module state between cases. */
export function __resetDialogStateForTests(): void {
  lockCount = 0;
  lastClosedAt = 0;
  lastUsedDir = '';
}

export function getDialogLockCount(): number {
  return lockCount;
}

export function getLastUsedDir(): string {
  return lastUsedDir;
}

export function setLastUsedDir(dir: string): void {
  if (typeof dir === 'string' && dir) lastUsedDir = dir;
}

/** Window gone (quit/destroyed) mid-dialog: drop the lock so blur never sticks. */
export function resetDialogLock(): void {
  lockCount = 0;
}

/** Hold the dialog lock around any native dialog/shell open. Always releases. */
export async function withDialogLock<T>(
  win: BrowserWindow | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  void win;
  lockCount += 1;
  try {
    return await run();
  } finally {
    lockCount = Math.max(0, lockCount - 1);
    lastClosedAt = Date.now();
  }
}

type BlurWindow = Pick<BrowserWindow, 'getChildWindows'> | null | undefined;

/** True while a dialog is open, in the post-close grace window, or a child has focus. */
export function shouldSuppressBlur(win?: BlurWindow): boolean {
  if (lockCount > 0) return true;
  if (Date.now() - lastClosedAt < DIALOG_BLUR_GRACE_MS) return true;
  try {
    const kids = win?.getChildWindows?.() || [];
    for (const c of kids) {
      try {
        if (!c.isDestroyed() && (c.isFocused() || c.isVisible())) return true;
      } catch { /* half-dead child */ }
    }
  } catch { /* window gone */ }
  return false;
}

function alive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  try {
    return !!win && !win.isDestroyed();
  } catch {
    return false;
  }
}

/** macOS: an always-on-top panel pins the native picker behind it — lower first. */
function lowerForDialog(win: BrowserWindow | null | undefined): boolean {
  try {
    if (platform().key === 'darwin' && alive(win)) {
      win.setAlwaysOnTop(false);
      return true;
    }
  } catch { /* best effort */ }
  return false;
}

function restoreAfterDialog(win: BrowserWindow | null | undefined, lowered: boolean): void {
  if (!lowered || !alive(win)) return;
  try {
    win.setAlwaysOnTop(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch { /* older Electron */ }
}

/** Next tick: reshow + focus the popup and tell the renderer to focus the input. */
function refocusPopup(win: BrowserWindow | null | undefined): void {
  if (!alive(win)) return;
  const w = win;
  setImmediate(() => {
    try {
      if (w.isDestroyed()) return;
      if (!w.isVisible()) w.show();
      w.focus();
      w.webContents.send(IpcChannels.popupShown);
    } catch { /* window gone mid-refocus */ }
  });
}

/** Parent-modal dialogs need a live window; destroyed/null goes parentless (Esc still cancels). */
function dialogParent(win: BrowserWindow | null | undefined): BrowserWindow | undefined {
  return alive(win) ? win : undefined;
}

export interface PickFolderOpts {
  defaultPath?: string;
  cwd?: string;
  allowedRoots?: string[];
  explicitRoots?: string[];
  homeDir?: string;
}

export interface FolderSelection {
  /** Realpath of the picked folder. */
  path: string;
  /** True when outside every allowed root (renderer inline-confirms adding it). */
  outsideAllowed: boolean;
}

// Exists + is-dir + realpath + protected/allowed policy. Throws a UI-safe Error.
export function validateFolderSelection(raw: string, opts: PickFolderOpts = {}): FolderSelection {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('No folder selected');
  let st: fs.Stats;
  try {
    st = fs.statSync(raw);
  } catch {
    throw new Error(`Folder not found: ${raw}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${raw}`);
  let real = raw;
  try {
    real = fs.realpathSync(raw);
  } catch { /* keep as-is */ }
  const home = opts.homeDir || os.homedir();
  const cwd = opts.cwd || home;
  const explicit = opts.explicitRoots || [];
  const allowed = opts.allowedRoots?.length ? opts.allowedRoots : defaultAllowedRoots(home, cwd);
  const ctx: PolicyContext = {
    allowedRoots: allowed,
    explicitRoots: explicit,
    alwaysAllow: [],
    requireApprovalForWrites: true,
    homeDir: home,
  };
  const resolved = normalizeAndResolve(real, cwd);
  if (!isPathAllowed(resolved, ctx)) throw new Error(`blocked path: ${resolved}`);
  return { path: real, outsideAllowed: !isInsideRoots(resolved, allowed) };
}

/** Parent-modal folder picker. Cancel (or a gone window) resolves null, never rejects. */
export async function pickFolder(
  win: BrowserWindow | null | undefined,
  opts: PickFolderOpts = {},
): Promise<string | null> {
  return withDialogLock(win, async () => {
    const lowered = lowerForDialog(win);
    try {
      const start = opts.defaultPath || lastUsedDir || undefined; // last-used seeds next open
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...(start ? { defaultPath: start } : {}),
      };
      const parent = dialogParent(win);
      const r = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (r.canceled || !r.filePaths[0]) return null;
      const sel = validateFolderSelection(r.filePaths[0], opts);
      try {
        lastUsedDir = path.dirname(sel.path);
      } catch { /* keep previous */ }
      return sel.path;
    } catch (e) {
      if ((e as Error)?.message?.startsWith('blocked path')) throw e; // surfaces in the UI
      return null; // dialog errors / gone window: cancel, never an unhandled rejection
    } finally {
      restoreAfterDialog(win, lowered);
      refocusPopup(win);
    }
  });
}

/** Parent-modal file picker for extension files. Cancel resolves null, never rejects. */
export async function pickFile(win: BrowserWindow | null | undefined): Promise<string | null> {
  return withDialogLock(win, async () => {
    const lowered = lowerForDialog(win);
    try {
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [
          { name: 'Extension files', extensions: ['zip', 'json', 'md'] },
          { name: 'All files', extensions: ['*'] },
        ],
        ...(lastUsedDir ? { defaultPath: lastUsedDir } : {}),
      };
      const parent = dialogParent(win);
      const r = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (r.canceled || !r.filePaths[0]) return null;
      const p = r.filePaths[0];
      try {
        if (!fs.statSync(p).isFile()) return null;
      } catch {
        return null;
      }
      let real = p;
      try {
        real = fs.realpathSync(p);
      } catch { /* keep as-is */ }
      try {
        lastUsedDir = path.dirname(real);
      } catch { /* keep previous */ }
      return real;
    } catch {
      return null;
    } finally {
      restoreAfterDialog(win, lowered);
      refocusPopup(win);
    }
  });
}

/** Reveal a folder in the OS file manager. Never throws. */
export async function revealPath(win: BrowserWindow | null | undefined, dir: string): Promise<boolean> {
  if (typeof dir !== 'string' || !dir.trim()) return false;
  return withDialogLock(win, async () => {
    try {
      const err = await shell.openPath(dir);
      return !err;
    } catch {
      return false;
    }
  });
}

const EXTERNAL_ALLOW = /^(https?:|x-apple\.systempreferences:)/i;

/** Open a URL with the OS handler. Only http(s) + the macOS settings scheme. Never throws. */
export async function openExternalUrl(win: BrowserWindow | null | undefined, url: string): Promise<boolean> {
  if (typeof url !== 'string' || !EXTERNAL_ALLOW.test(url.trim())) return false;
  return withDialogLock(win, async () => {
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
}

/** Agent app_open through the lock so the popup doesn't hide mid-open. Rejects on failure. */
export async function openTargetGuarded(
  win: BrowserWindow | null | undefined,
  target: string,
): Promise<void> {
  await withDialogLock(win, async () => {
    await platform().openTarget(target);
  });
}
