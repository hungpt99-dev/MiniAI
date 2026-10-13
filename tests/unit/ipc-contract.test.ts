import { describe, it, expect } from 'vitest';
import { IpcChannels } from '../../src/shared/ipc-channels';
import { openTestDb } from '../../src/main/db/db';
import { getSettings } from '../../src/main/store/settings';

// Phase 0 characterization: pin the IPC contract and legacy-settings
// pass-through before the external-runtime removal changes them.
describe('ipc contract', () => {
  it('channels share the nexio: prefix with no duplicates', () => {
    const vals = Object.values(IpcChannels);
    expect(vals.length).toBeGreaterThan(10);
    for (const v of vals) expect(v.startsWith('nexio:')).toBe(true);
    expect(new Set(vals).size).toBe(vals.length);
  });
  it('keeps the core chat/agent/data channels', () => {
    for (const k of ['send', 'chat', 'agentStart', 'agentApprove', 'agentStop',
      'getSettings', 'setSettings', 'slashQuery', 'ext', 'undo', 'runs'] as const) {
      expect(IpcChannels[k]).toBe(`nexio:${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  });
});

describe('settings legacy pass-through', () => {
  it('returns unknown/legacy rows as-is (pre-migration behavior)', () => {
    const db = openTestDb();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('agentBackend', JSON.stringify('opencode'));
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('engine', JSON.stringify('codex'));
    const s = getSettings(db) as unknown as Record<string, unknown>;
    expect(s.agentBackend).toBe('opencode');
    expect(s.engine).toBe('codex');
    db.close();
  });
});
