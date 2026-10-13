import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { IpcChannels } from '../../src/shared/ipc-channels';
import { openTestDb, resolveDbPath } from '../../src/main/db/db';
import { getSettings } from '../../src/main/store/settings';

// Phase 1: IPC contract without external runtimes; legacy runtime keys
// migrate to the built-in fallback, MiniAI DB reuse untouched.
describe('ipc contract', () => {
  it('channels share one prefix with no duplicates', () => {
    const vals = Object.values(IpcChannels);
    // Prefix derived from a channel, never a second literal.
    const prefix = IpcChannels.send.slice(0, IpcChannels.send.indexOf(':') + 1);
    expect(vals.length).toBeGreaterThan(10);
    for (const v of vals) expect(v.startsWith(prefix)).toBe(true);
    expect(new Set(vals).size).toBe(vals.length);
  });
  it('keeps the core chat/agent/data channels', () => {
    const prefix = IpcChannels.send.slice(0, IpcChannels.send.indexOf(':') + 1);
    for (const k of ['send', 'chat', 'agentStart', 'agentApprove', 'agentStop',
      'getSettings', 'setSettings', 'slashQuery', 'ext', 'undo', 'runs'] as const) {
      expect(IpcChannels[k]).toBe(`${prefix}${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  });
  it('has no external-runtime channels', () => {
    expect('runtimeList' in IpcChannels).toBe(false);
    expect('runtimeRefresh' in IpcChannels).toBe(false);
    expect(Object.values(IpcChannels).some((v) => v.includes('runtime'))).toBe(false);
  });
});

describe('settings runtime migration', () => {
  it('drops removed runtime keys and purges their rows (builtin fallback)', () => {
    const db = openTestDb();
    for (const [k, v] of [
      ['agentRuntime', 'claude'], ['agentBackend', 'opencode'], ['engine', 'codex'],
      ['opencodeBaseUrl', 'http://localhost:4096'], ['claudeBin', 'claude'], ['codexBin', 'codex'],
    ]) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
    }
    const s = getSettings(db) as unknown as Record<string, unknown>;
    for (const k of ['agentRuntime', 'agentBackend', 'engine', 'opencodeBaseUrl', 'claudeBin', 'codexBin']) {
      expect(s[k]).toBeUndefined();
    }
    const left = db.prepare("SELECT key FROM settings WHERE key IN ('agentRuntime','agentBackend','engine','opencodeBaseUrl','claudeBin','codexBin')").all();
    expect(left).toEqual([]);
    expect(s.mode).toBe('agent');
    db.close();
  });
  it('resolveDbPath honors an explicit data dir (MiniAI reuse path untouched)', () => {
    const dir = path.join(os.tmpdir(), 'nexio-mig');
    expect(resolveDbPath(dir)).toBe(path.join(dir, 'nexio.db'));
  });
});
