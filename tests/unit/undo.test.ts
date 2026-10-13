import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  capturePreOp, recordOp, loadJournal, undoAvailable, undoFolder, undoRun,
  UNDOABLE_TOOLS, resolveUndoDir,
} from '../../src/main/agent/undo';
import { DEFAULT_LIMITS, type Tool } from '../../src/main/agent/types';
import type { ToolExecState } from '../../src/main/agent/loop';
import { fsMoveTool } from '../../src/main/agent/tools/fs_move';
import { fsCopyTool } from '../../src/main/agent/tools/fs_copy';
import { fsWriteTool } from '../../src/main/agent/tools/fs_write';
import { fsTrashTool } from '../../src/main/agent/tools/fs_trash';
import { clipboardWriteTool } from '../../src/main/agent/tools/clipboard_write';
import { __setClipboardBackend } from '../../src/main/agent/tools/clipboard';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-undo-'));
const home = os.homedir();

function execState(dir: string, events: unknown[] = []): ToolExecState {
  return {
    cwd: dir,
    policy: { allowedRoots: [dir], explicitRoots: [], alwaysAllow: [], requireApprovalForWrites: false, homeDir: home },
    limits: DEFAULT_LIMITS,
    emit: (e) => events.push(e),
    messages: [],
    waitForApproval: async () => ({ decision: 'allow-once' }),
    checkRunTimeout: () => false,
    toolCalls: 0,
    approvalWaitMs: 0,
    lastUntrusted: null,
  };
}

const ALL = new Map<string, Tool>([
  ['fs_move', fsMoveTool], ['fs_copy', fsCopyTool], ['fs_write', fsWriteTool],
  ['fs_trash', fsTrashTool], ['clipboard_write', clipboardWriteTool],
]);

describe('undo capture', () => {
  it('never journals shell or unknown tools', async () => {
    expect(await capturePreOp('shell_run', { command: 'x' })).toBeNull();
    expect(await capturePreOp('mcp__srv__tool', {})).toBeNull();
    expect(await capturePreOp('fs_read', { path: 'x' })).toBeNull();
    expect(UNDOABLE_TOOLS.has('shell_run')).toBe(false);
  });
  it('refuses copy/write over existing files', async () => {
    const dir = tmpRoot();
    const p = path.join(dir, 'dest.txt');
    fs.writeFileSync(p, 'original');
    expect(await capturePreOp('fs_copy', { from: 'a', to: p })).toMatchObject({ undoable: false });
    expect(await capturePreOp('fs_write', { path: p })).toMatchObject({ undoable: false });
  });
  it('marks trash as manually restorable only', async () => {
    const pre = await capturePreOp('fs_trash', { path: '/tmp/x' });
    expect(pre?.undoable).toBe(false);
    // Platform word: Recycle Bin on Windows, Trash on macOS.
    expect(pre?.reason).toMatch(/Recycle Bin|Trash/);
  });
});

describe('undo move round-trip', () => {
  it('moves back, marks undone, second run is a no-op', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const from = path.join(dir, 'a.txt');
    const to = path.join(dir, 'b.txt');
    fs.writeFileSync(from, 'data');
    const pre = await capturePreOp('fs_move', { from, to });
    expect(pre?.undoable).toBe(true);
    fs.renameSync(from, to); // the op itself
    recordOp('run-1', 'move it', fsMoveTool, { from, to }, pre!, udir);
    expect(undoAvailable('run-1', udir)).toBe(true);
    expect(undoFolder('run-1', dir, udir)).toBe(dir);
    const st = execState(dir);
    const r1 = await undoRun('run-1', st, ALL, udir);
    expect(r1.undone).toHaveLength(1);
    expect(r1.failed).toHaveLength(0);
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(false);
    expect(loadJournal('run-1', udir)?.entries[0].undone).toBe(true);
    expect(undoAvailable('run-1', udir)).toBe(false);
    const r2 = await undoRun('run-1', st, ALL, udir);
    expect(r2.undone).toHaveLength(0);
    expect(r2.failed.join(' ')).toMatch(/already undone/);
  });
  it('reports conflict when the original location is occupied', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const from = path.join(dir, 'a.txt');
    const to = path.join(dir, 'b.txt');
    fs.writeFileSync(from, 'data');
    const pre = await capturePreOp('fs_move', { from, to });
    fs.renameSync(from, to);
    recordOp('run-2', 'move it', fsMoveTool, { from, to }, pre!, udir);
    fs.writeFileSync(from, 'someone else'); // conflict
    const r = await undoRun('run-2', execState(dir), ALL, udir);
    expect(r.undone).toHaveLength(0);
    expect(r.failed.join(' ')).toMatch(/occupied/);
    expect(fs.existsSync(to)).toBe(true); // left in place
  });
});

describe('undo copy and write', () => {
  it('trashes created copies, refuses changed files', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const dest = path.join(dir, 'copy.txt');
    fs.writeFileSync(dest, 'v1');
    recordOp('run-3', 'copy it', fsCopyTool, { from: 'x', to: dest },
      { data: { path: dest }, undoable: true }, udir);
    fs.writeFileSync(dest, 'v2-modified'); // changed since
    const r1 = await undoRun('run-3', execState(dir), ALL, udir);
    expect(r1.undone).toHaveLength(0);
    expect(r1.failed.join(' ')).toMatch(/changed since/);
    expect(fs.existsSync(dest)).toBe(true);
  });
  it('removes created files via trash', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const dest = path.join(dir, 'new.txt');
    fs.writeFileSync(dest, 'new');
    recordOp('run-4', 'write it', fsWriteTool, { path: dest },
      { data: { path: dest }, undoable: true }, udir);
    const r = await undoRun('run-4', execState(dir), ALL, udir);
    expect(r.undone).toHaveLength(1);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('undo clipboard', () => {
  it('restores previous clipboard text', async () => {
    let clip = 'before';
    __setClipboardBackend({ read: () => clip, write: (t: string) => { clip = t; } });
    try {
      const udir = tmpRoot();
      const pre = await capturePreOp('clipboard_write', { text: 'after' });
      expect(pre?.data).toMatchObject({ previous: 'before' });
      clip = 'after'; // the op itself
      recordOp('run-5', 'copy it', clipboardWriteTool, { text: 'after' }, pre!, udir);
      const r = await undoRun('run-5', execState(tmpRoot()), ALL, udir);
      expect(r.undone).toHaveLength(1);
      expect(clip).toBe('before');
    } finally {
      __setClipboardBackend(null);
    }
  });
});

describe('undo edge cases', () => {
  it('reports missing journals and non-undoable entries honestly', async () => {
    const udir = tmpRoot();
    const r = await undoRun('nope', execState(tmpRoot()), ALL, udir);
    expect(r.failed.join(' ')).toMatch(/no journal/);
    recordOp('run-6', 'trash it', fsTrashTool, { path: '/tmp/x' },
      { data: { path: '/tmp/x' }, undoable: false, reason: 'Restore it manually' }, udir);
    expect(undoAvailable('run-6', udir)).toBe(false);
    const r2 = await undoRun('run-6', execState(tmpRoot()), ALL, udir);
    expect(r2.undone).toHaveLength(0);
    expect(r2.failed.join(' ')).toMatch(/manually/);
  });
  it('resolves the undo dir next to the db', () => {
    expect(resolveUndoDir()).toMatch(/undo$/);
  });
});
