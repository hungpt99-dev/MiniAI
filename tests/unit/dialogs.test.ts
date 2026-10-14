import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { __setPlatform, adapterFor } from '../../src/main/platform/index';
import { IpcChannels } from '../../src/shared/ipc-channels';
import {
  __resetDialogStateForTests,
  getDialogLockCount,
  getLastUsedDir,
  openExternalUrl,
  openTargetGuarded,
  pickAttachFiles,
  pickFile,
  pickFolder,
  resetDialogLock,
  revealPath,
  shouldSuppressBlur,
  validateFolderSelection,
  withDialogLock,
} from '../../src/main/app/dialogs';

const showOpenDialog = vi.mocked(dialog.showOpenDialog);
const openPath = vi.mocked(shell.openPath);
const openExternal = vi.mocked(shell.openExternal);

function mockWin(over: Record<string, unknown> = {}): BrowserWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    getChildWindows: () => [],
    show: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    webContents: { send: vi.fn(), isDevToolsOpened: () => false },
    ...over,
  } as unknown as BrowserWindow;
}

// showOpenDialog resolves { canceled, filePaths }; parent call passes (win, opts).
function dialogOpts(): Record<string, unknown> {
  const args = showOpenDialog.mock.calls[showOpenDialog.mock.calls.length - 1] as unknown[];
  const o = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>;
  return o;
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  __resetDialogStateForTests();
  vi.clearAllMocks();
  __setPlatform(null);
});

afterEach(() => {
  __setPlatform(null);
});

describe('dialog lock', () => {
  it('counts one lock and releases in finally', async () => {
    let seen = -1;
    await withDialogLock(null, async () => { seen = getDialogLockCount(); });
    expect(seen).toBe(1);
    expect(getDialogLockCount()).toBe(0);
  });
  it('nests and unwinds in order', async () => {
    const order: number[] = [];
    await withDialogLock(null, async () => {
      order.push(getDialogLockCount());
      await withDialogLock(null, async () => { order.push(getDialogLockCount()); });
      order.push(getDialogLockCount());
    });
    expect(order).toEqual([1, 2, 1]);
    expect(getDialogLockCount()).toBe(0);
  });
  it('releases on throw and starts the blur grace window', async () => {
    await expect(withDialogLock(null, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(getDialogLockCount()).toBe(0);
    expect(shouldSuppressBlur(null)).toBe(true);
  });
  it('reset drops a stuck lock (quit/destroy) and never goes negative', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = withDialogLock(null, () => gate);
    expect(getDialogLockCount()).toBe(1);
    resetDialogLock();
    expect(getDialogLockCount()).toBe(0);
    release();
    await p;
    expect(getDialogLockCount()).toBe(0);
  });
});

describe('shouldSuppressBlur', () => {
  it('is false when idle with no children', () => {
    expect(shouldSuppressBlur(mockWin())).toBe(false);
  });
  it('is true for a focused child window', () => {
    const child = { isDestroyed: () => false, isFocused: () => true, isVisible: () => false };
    const win = mockWin({ getChildWindows: () => [child] });
    expect(shouldSuppressBlur(win)).toBe(true);
  });
  it('ignores a merely visible (unfocused) child', () => {
    const child = { isDestroyed: () => false, isFocused: () => false, isVisible: () => true };
    expect(shouldSuppressBlur(mockWin({ getChildWindows: () => [child] }))).toBe(false);
  });
  it('ignores destroyed children', () => {
    const child = { isDestroyed: () => true, isFocused: () => true, isVisible: () => true };
    expect(shouldSuppressBlur(mockWin({ getChildWindows: () => [child] }))).toBe(false);
  });
  it('holds the lock while the dialog is open', async () => {
    let seen = -1;
    showOpenDialog.mockImplementation(async () => {
      seen = getDialogLockCount();
      return { canceled: true, filePaths: [] };
    });
    await pickFile(mockWin());
    expect(seen).toBe(1);
    expect(getDialogLockCount()).toBe(0);
  });
  it('keeps suppressing briefly after close (grace), then releases', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickFolder(mockWin());
    expect(shouldSuppressBlur(mockWin())).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    expect(shouldSuppressBlur(mockWin())).toBe(false);
  });
});

describe('pickFolder / pickFile', () => {
  it('cancel resolves null and refocuses (focus input IPC, no reshow when visible)', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const win = mockWin();
    await expect(pickFolder(win)).resolves.toBe(null);
    await flush();
    expect((win.focus as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((win.show as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.popupShown);
  });
  it('reshows a hidden popup on the refocus tick', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const win = mockWin({ isVisible: () => false });
    await pickFolder(win);
    await flush();
    expect((win.show as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((win.focus as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
  it('goes parentless for a null or destroyed window and still resolves null', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(pickFolder(null)).resolves.toBe(null);
    await expect(pickFolder(mockWin({ isDestroyed: () => true }))).resolves.toBe(null);
    for (const call of showOpenDialog.mock.calls) expect(call.length).toBe(1);
    await flush();
  });
  it('returns the realpath and seeds defaultPath from the last pick', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-pick-'));
    const real = fs.realpathSync(dir);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const win = mockWin();
    await expect(pickFolder(win, { allowedRoots: [real] })).resolves.toBe(real);
    expect(getLastUsedDir()).toBe(path.dirname(real));
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickFolder(win);
    expect(dialogOpts().defaultPath).toBe(path.dirname(real));
    await flush();
  });
  it('pickFile returns the file and remembers its dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-pickf-'));
    const f = path.join(dir, 'x.zip');
    fs.writeFileSync(f, 'zip');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [f] });
    await expect(pickFile(mockWin())).resolves.toBe(fs.realpathSync(f));
    expect(getLastUsedDir()).toBe(path.dirname(fs.realpathSync(f)));
    await flush();
  });
  it('lowers and restores alwaysOnTop on macOS', async () => {
    __setPlatform(adapterFor('darwin'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-pickm-'));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });
    const win = mockWin();
    await pickFolder(win, { allowedRoots: [fs.realpathSync(dir)] });
    const setTop = win.setAlwaysOnTop as unknown as ReturnType<typeof vi.fn>;
    expect(setTop.mock.calls[0]).toEqual([false]);
    expect(setTop.mock.calls[setTop.mock.calls.length - 1]).toEqual([true]);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    await flush();
  });
});

describe('pickAttachFiles', () => {
  it('cancel resolves [] and never rejects (stubbed none)', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(pickAttachFiles(mockWin())).resolves.toEqual([]);
    await expect(pickAttachFiles(null)).resolves.toEqual([]);
    await flush();
  });
  it('returns every pick (multi) under one dialog lock', async () => {
    const files = ['C:\\pics\\a.png', 'C:\\pics\\b.pdf', 'C:\\pics\\c.txt'];
    let seen = -1;
    showOpenDialog.mockImplementation(async () => {
      seen = getDialogLockCount();
      return { canceled: false, filePaths: files };
    });
    await expect(pickAttachFiles(mockWin())).resolves.toEqual(files);
    expect(dialogOpts().properties).toContain('multiSelections');
    expect(seen).toBe(1);
    expect(getDialogLockCount()).toBe(0);
  });
  it('remembers metadata (lastUsedDir) and seeds the next open', async () => {
    // why: forward slashes round-trip through path.dirname on every host
    // (a win32-shaped fixture would only pass on Windows).
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/pics/a.png'] });
    await pickAttachFiles(mockWin());
    expect(getLastUsedDir()).toBe('/pics');
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await pickAttachFiles(mockWin());
    expect(dialogOpts().defaultPath).toBe('/pics');
    await flush();
  });
});

describe('validateFolderSelection', () => {
  it('accepts a real dir, flagging outside-allowed picks', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-val-')));
    expect(validateFolderSelection(dir, { allowedRoots: [dir] })).toEqual({ path: dir, outsideAllowed: false });
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-val-')));
    expect(validateFolderSelection(dir, { allowedRoots: [other] }).outsideAllowed).toBe(true);
  });
  it('rejects missing paths, files and empties', () => {
    expect(() => validateFolderSelection(path.join(os.tmpdir(), 'nexio-nope-xyz'))).toThrow(/not found/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-valf-'));
    const f = path.join(dir, 'f.md');
    fs.writeFileSync(f, 'x');
    expect(() => validateFolderSelection(f)).toThrow(/Not a folder/);
    expect(() => validateFolderSelection('  ')).toThrow(/No folder/);
  });
  it('blocks protected selections (system / sensitive segments)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-valp-'));
    const ssh = path.join(dir, '.ssh');
    fs.mkdirSync(ssh);
    expect(() => validateFolderSelection(ssh)).toThrow(/^blocked path/);
  });
});

describe('reveal / openExternal / openTarget', () => {
  it('revealPath maps openPath results and never throws', async () => {
    openPath.mockResolvedValue('');
    await expect(revealPath(mockWin(), os.tmpdir())).resolves.toBe(true);
    openPath.mockResolvedValue('nope');
    await expect(revealPath(mockWin(), os.tmpdir())).resolves.toBe(false);
    openPath.mockRejectedValue(new Error('gone'));
    await expect(revealPath(mockWin(), os.tmpdir())).resolves.toBe(false);
    await expect(revealPath(mockWin(), '  ')).resolves.toBe(false);
    await expect(revealPath(mockWin(), null as unknown as string)).resolves.toBe(false);
    expect(openPath).toHaveBeenCalledTimes(3);
  });
  it('openExternalUrl allowlists schemes and never throws', async () => {
    openExternal.mockResolvedValue({} as never);
    await expect(openExternalUrl(mockWin(), 'https://example.com')).resolves.toBe(true);
    await expect(openExternalUrl(mockWin(), 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders')).resolves.toBe(true);
    await expect(openExternalUrl(mockWin(), 'file:///etc/passwd')).resolves.toBe(false);
    await expect(openExternalUrl(mockWin(), 'javascript:alert(1)')).resolves.toBe(false);
    openExternal.mockRejectedValue(new Error('denied'));
    await expect(openExternalUrl(mockWin(), 'https://example.com')).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(3);
  });
  it('trims whitespace before allowlisting and sending', async () => {
    openExternal.mockResolvedValue({} as never);
    await expect(openExternalUrl(mockWin(), '  https://example.com  ')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
    await expect(openExternalUrl(mockWin(), '   file:///etc/passwd  ')).resolves.toBe(false);
  });
  it('holds the lock during shell opens', async () => {
    let seen = -1;
    openPath.mockImplementation(async () => { seen = getDialogLockCount(); return ''; });
    await revealPath(mockWin(), os.tmpdir());
    expect(seen).toBe(1);
  });
  it('openTargetGuarded holds the lock and propagates failures', async () => {
    const { platform } = await import('../../src/main/platform/index');
    const adapter = platform();
    const orig = adapter.openTarget;
    let seen = -1;
    adapter.openTarget = async () => { seen = getDialogLockCount(); };
    await openTargetGuarded(mockWin(), 'https://example.com');
    expect(seen).toBe(1);
    adapter.openTarget = async () => { throw new Error('nope'); };
    await expect(openTargetGuarded(mockWin(), 'x')).rejects.toThrow('nope');
    adapter.openTarget = orig;
  });
});

describe('dialog routing', () => {
  it('has no direct dialog.show* outside app/dialogs', () => {
    const roots = [path.join(process.cwd(), 'src')];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    const re = /dialog\.show[A-Z]\w*|showOpenDialog|showSaveDialog|showMessageBox/;
    const hits = files
      .filter((f) => path.basename(f) !== 'dialogs.ts')
      .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f));
    expect(hits).toEqual([]);
  });
});
