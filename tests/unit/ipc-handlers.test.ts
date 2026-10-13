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
import {
  IpcChannels,
  IpcInvokeChannels,
  IpcPushChannels,
  IpcSendChannels,
} from '../../src/shared/ipc-channels';
import { openTestDb } from '../../src/main/db/db';
import {
  __ipcRegistryForTests,
  __resetIpcRegistryForTests,
  registerIpc,
} from '../../src/main/ipc';

const handle = vi.mocked(ipcMain.handle);
const on = vi.mocked(ipcMain.on);
type Listener = (...args: any[]) => unknown;
function listenerFor(channel: string): Listener {
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as Listener;
}

let dataDir = '';
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.NEXIO_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-ipc-'));
  process.env.NEXIO_DATA_DIR = dataDir;
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = openTestDb();
  __resetIpcRegistryForTests();
  handle.mockClear();
  on.mockClear();
  registerIpc();
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.NEXIO_DATA_DIR;
  else process.env.NEXIO_DATA_DIR = prevDataDir;
});

describe('ipc registration', () => {
  it('registers every invoke channel exactly once', () => {
    expect(IpcInvokeChannels.length).toBeGreaterThan(10);
    for (const c of IpcInvokeChannels) {
      expect(handle.mock.calls.filter((x) => x[0] === c).length).toBe(1);
    }
    expect(handle.mock.calls.length).toBe(IpcInvokeChannels.length);
  });
  it('registers every send channel exactly once as a listener', () => {
    for (const c of IpcSendChannels) {
      expect(on.mock.calls.filter((x) => x[0] === c).length).toBe(1);
    }
  });
  it('leaves push channels handler-free', () => {
    for (const c of IpcPushChannels) {
      expect(handle.mock.calls.some((x) => x[0] === c)).toBe(false);
      expect(on.mock.calls.some((x) => x[0] === c)).toBe(false);
    }
  });
  it('tracks handle vs on kinds in the registry', () => {
    const reg = __ipcRegistryForTests();
    expect(reg.get(IpcChannels.send)).toBe('handle');
    expect(reg.get(IpcChannels.chatCancel)).toBe('on');
    expect(reg.has(IpcChannels.chatStream)).toBe(false);
  });
  it('double register throws in tests', () => {
    expect(() => registerIpc()).toThrow(/Duplicate IPC/);
  });
});

describe('typedHandle envelope', () => {
  it('rejects a bad approval decision with {ok:false,code,message}', async () => {
    const out = await listenerFor(IpcChannels.agentApprove)({}, 'r1', 'c1', 'bogus');
    expect(out).toMatchObject({ ok: false, code: 'IPC_VALIDATION' });
    expect(typeof (out as { message: string }).message).toBe('string');
  });
  it('rejects wrong arity with a validation code', async () => {
    const out = await listenerFor(IpcChannels.getMessages)({});
    expect(out).toMatchObject({ ok: false, code: 'IPC_VALIDATION' });
  });
  it('passes valid calls through unwrapped', async () => {
    const out = await listenerFor(IpcChannels.getSettings)({});
    expect(out).toMatchObject({ mode: 'agent' });
    expect((out as { ok?: unknown }).ok).toBeUndefined();
  });
});
