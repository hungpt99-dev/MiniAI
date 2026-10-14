import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { ipcMain } from 'electron';
import { IpcChannels } from '../../src/shared/ipc-channels';
import { openTestDb } from '../../src/main/db/db';
import {
  __resetIpcRegistryForTests,
  registerIpc,
} from '../../src/main/ipc';

const handle = vi.mocked(ipcMain.handle);
type Listener = (...args: any[]) => unknown;

function mem(action: unknown): Promise<any> {
  const call = handle.mock.calls.find((c) => c[0] === IpcChannels.memory);
  if (!call) throw new Error('no memory handler');
  return (call[1] as Listener)({}, action) as Promise<any>;
}

beforeAll(() => {
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = openTestDb();
  __resetIpcRegistryForTests();
  handle.mockClear();
  registerIpc();
});

afterAll(() => {
  try { fs.rmSync(path.join(os.tmpdir()), { recursive: false }); } catch { /* noop */ }
});

describe('memory channel: end-to-end over IPC', () => {
  it('saves, lists, gets, updates, pins, forgets', async () => {
    const saved = await mem({ action: 'save', kind: 'preference', text: 'likes strong coffee' });
    expect(saved.status).toBe('saved');
    const id = saved.memory.id as string;
    const list = await mem({ action: 'list' });
    expect(list.map((m: { id: string }) => m.id)).toContain(id);
    const got = await mem({ action: 'get', id });
    expect(got.text).toBe('likes strong coffee');
    const upd = await mem({ action: 'update', id, text: 'likes very strong coffee', pinned: true });
    expect(upd.memory.pinned).toBe(true);
    const f = await mem({ action: 'forget', id });
    expect(f.forgotten).toBe(id);
    expect(await mem({ action: 'get', id })).toMatchObject({ ok: false, code: 'IPC_ERROR' });
  });
  it('blocks secrets and explains why', async () => {
    const r = await mem({ action: 'save', kind: 'fact', text: 'token sk-abc123XYZ456789DEF012345' });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/secret/);
  });
  it('conflict then replace via replaceId', async () => {
    const a = await mem({ action: 'save', kind: 'preference', text: 'prefers PDF reports monthly' });
    expect(a.status).toBe('saved');
    const b = await mem({ action: 'save', kind: 'preference', text: 'prefers Word reports monthly' });
    expect(b.status).toBe('conflict');
    const c = await mem({
      action: 'save', kind: 'preference', text: 'prefers Word reports monthly',
      replaceId: b.conflicts[0].id as string,
    });
    expect(c.status).toBe('saved');
    const list = await mem({ action: 'list', kind: 'preference' });
    expect(list.filter((m: { text: string }) => /reports monthly/.test(m.text))).toHaveLength(1);
  });
  it('exports, previews, imports with dedupe', async () => {
    const exp = await mem({ action: 'export' });
    expect(typeof exp.json).toBe('string');
    expect(exp.json).not.toMatch(/enc:|plain:/);
    const preview = await mem({ action: 'import', json: exp.json, dry: true });
    expect(preview.updated).toBeGreaterThanOrEqual(1);
    expect(preview.imported).toBe(0);
    const bad = await mem({ action: 'import', json: '{}' });
    expect(bad.errors.length).toBeGreaterThan(0);
  });
  it('forget-all needs the exact phrase; dismiss records hashes; info reports plaintext', async () => {
    expect(await mem({ action: 'forgetAll', confirm: 'nope' })).toEqual({ deleted: false });
    expect(await mem({ action: 'dismiss', hash: 'abc123' })).toEqual({ dismissed: 'abc123' });
    const info = await mem({ action: 'info' });
    expect(info.count).toBeGreaterThanOrEqual(1);
    expect(info.encrypted).toBe(false); // no Electron safeStorage in tests
    expect(await mem({ action: 'forgetAll', confirm: 'forget everything' })).toEqual({ deleted: true });
    expect((await mem({ action: 'info' })).count).toBe(0);
  });
  it('rejects bad input and unknown actions', async () => {
    expect(await mem({ action: 'save', kind: 'nope', text: 'x' })).toMatchObject({ ok: false, code: 'IPC_ERROR' });
    expect(await mem({ action: 'nope' })).toMatchObject({ ok: false, code: 'IPC_ERROR' });
  });
});
