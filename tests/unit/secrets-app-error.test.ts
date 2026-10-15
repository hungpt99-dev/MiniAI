import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openTestDb } from '../../src/main/db/db';
import {
  AppError, toAppError, friendlyFor, missingKeyError, redactPaths,
} from '../../src/main/errors/app-error';
import {
  readSecret, writeSecret, writeSessionSecret, deleteSecretRecord, listSecretIds,
  requireApiKey, secretsStatus, scanForReentry, clearReentry,
  __setBackendForTests, __resetSecretsForTests,
} from '../../src/main/secrets/index';
import { Scheduler, type RunControl } from '../../src/main/tasks/scheduler';
import type { Task } from '../../src/main/tasks/taskTypes';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const XOR = 0x5a;
function xorBytes(b: Buffer): Buffer {
  const c = Buffer.from(b);
  for (let i = 0; i < c.length; i++) c[i] ^= XOR;
  return c;
}
const xorBackend = {
  available: () => true,
  encrypt: (s: string) => xorBytes(Buffer.from(s, 'utf8')),
  decrypt: (b: Buffer) => xorBytes(Buffer.from(b)).toString('utf8'),
};
const throwingBackend = {
  available: () => true,
  encrypt: (s: string) => xorBytes(Buffer.from(s, 'utf8')),
  decrypt: (_b: Buffer) => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); },
};

beforeEach(() => {
  __setBackendForTests(xorBackend);
  __resetSecretsForTests();
});

describe('app-error mapper: friendly main message, redacted technical', () => {
  it('decrypt failure -> SECRET_UNREADABLE with Open Settings, no raw text', () => {
    const e = new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    const app = toAppError(e);
    expect(app.code).toBe('SECRET_UNREADABLE');
    expect(app.action).toBe('open-settings');
    expect(app.friendly).toBe(friendlyFor('SECRET_UNREADABLE').text);
    expect(app.friendly).not.toContain('decrypt');
    expect(app.friendly).not.toContain('ciphertext');
  });
  it('maps auth/network/timeout/rate-limit/abort/validation codes', () => {
    expect(toAppError(Object.assign(new Error('x'), { code: 'aborted' })).code).toBe('ABORTED');
    expect(toAppError(new Error('Request failed 401 Unauthorized')).code).toBe('PROVIDER_AUTH');
    expect(toAppError(new Error('fetch failed ECONNREFUSED')).code).toBe('NETWORK');
    expect(toAppError(new Error('Request timed out')).code).toBe('TIMEOUT');
    expect(toAppError(Object.assign(new Error('slow'), { code: 'rate-limit' })).code).toBe('PROVIDER_RATE_LIMIT');
    expect(toAppError(Object.assign(new Error('bad'), { code: 'IPC_VALIDATION' })).code).toBe('VALIDATION');
  });
  it('passes AppError through; unknown domain errors keep redacted text', () => {
    const mine = new AppError('NETWORK', 'friendly', 'tech', 'retry');
    expect(toAppError(mine)).toBe(mine);
    const app = toAppError(new Error('queue full (20 waiting tasks)'));
    expect(app.code).toBe('UNKNOWN');
    expect(app.friendly).toContain('queue full');
    expect(missingKeyError('openai').code).toBe('PROVIDER_NOT_CONFIGURED');
  });
  it('redacts secrets and paths in technical text', () => {
    const t = toAppError(new Error('read C:\\Users\\a\\file.txt key=sk-abcdefgh12345678')).technical;
    expect(t).not.toContain('sk-abcdefgh12345678');
    expect(t).not.toContain('C:\\Users\\a\\file.txt');
    expect(redactPaths('open /home/u/x.txt now')).not.toContain('/home/u/x.txt');
  });
});

describe('secrets module: envelope, never-throw reads, loud writes', () => {
  it('round trips through the v2 envelope', () => {
    const db = openTestDb();
    writeSecret(db, 'apikey:openai', 'sk-test-123');
    const row = db.prepare('SELECT value FROM secrets WHERE service = ?').get('apikey:openai') as { value: string };
    const env = JSON.parse(Buffer.from(row.value as unknown as Uint8Array).toString('utf8'));
    expect(env.v).toBe(2);
    expect(typeof env.cipher).toBe('string');
    expect(Buffer.from(env.cipher, 'base64').length).toBeGreaterThan(0);
    expect(readSecret(db, 'apikey:openai')).toMatchObject({ ok: true, value: 'sk-test-123' });
    db.close();
  });
  it('missing -> missing; getSecret-style read never throws on undecryptable', () => {
    const db = openTestDb();
    expect(readSecret(db, 'apikey:nope')).toEqual({ ok: false, reason: 'missing' });
    writeSecret(db, 'apikey:openai', 'sk-test-123');
    __setBackendForTests(throwingBackend);
    expect(readSecret(db, 'apikey:openai')).toEqual({ ok: false, reason: 'undecryptable' });
    expect(scanForReentry(db)).toContain('apikey:openai');
    db.close();
  });
  it('reads legacy raw-buffer and legacy plain blobs (compat, never written)', () => {
    const db = openTestDb();
    db.prepare('INSERT INTO secrets (service, value, updatedAt) VALUES (?, ?, ?)').run(
      'apikey:legacy', xorBytes(Buffer.from('sk-legacy', 'utf8')), Date.now());
    expect(readSecret(db, 'apikey:legacy')).toMatchObject({ ok: true, value: 'sk-legacy' });
    const xored = xorBytes(Buffer.from('sk-old', 'utf8'));
    db.prepare('INSERT INTO secrets (service, value, updatedAt) VALUES (?, ?, ?)').run(
      'apikey:plain', Buffer.concat([Buffer.from('plain:'), xored]), Date.now());
    expect(readSecret(db, 'apikey:plain')).toMatchObject({ ok: true, value: 'sk-old' });
    // new writes are always v2, never legacy shapes
    writeSecret(db, 'apikey:new', 'sk-new');
    const row = db.prepare('SELECT value FROM secrets WHERE service = ?').get('apikey:new') as { value: Uint8Array };
    expect(Buffer.from(row.value).toString('utf8')).toContain('"v":2');
    db.close();
  });
  it('unavailable backend: writes refuse loudly, nothing persisted; reads report unavailable', () => {
    const db = openTestDb();
    __setBackendForTests(null);
    expect(() => writeSecret(db, 'apikey:openai', 'sk-x')).toThrowError(/Secure storage/);
    expect(listSecretIds(db)).not.toContain('apikey:openai');
    // session-only path keeps working without persistence
    writeSessionSecret('apikey:openai', 'sk-session');
    expect(readSecret(db, 'apikey:openai')).toMatchObject({ ok: true, value: 'sk-session', session: true });
    expect(listSecretIds(db)).not.toContain('apikey:openai');
    db.close();
  });
  it('requireApiKey: missing/unreadable/ok', () => {
    const db = openTestDb();
    expect(() => requireApiKey(db, 'openai')).toThrowError(/No API key/);
    writeSecret(db, 'apikey:openai', 'sk-ok');
    expect(requireApiKey(db, 'openai')).toBe('sk-ok');
    __setBackendForTests(throwingBackend);
    try {
      requireApiKey(db, 'openai');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('SECRET_UNREADABLE');
    }
    db.close();
  });
  it('logs ids and reasons only, never values or ciphertext', () => {
    const db = openTestDb();
    writeSecret(db, 'apikey:openai', 'sk-super-secret-value-999');
    __setBackendForTests(throwingBackend);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readSecret(db, 'apikey:openai');
    secretsStatus(db);
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('sk-super-secret-value-999');
    expect(logged).toContain('apikey:openai');
    spy.mockRestore();
    db.close();
  });
  it('status self-check round trip ok; delete clears', () => {
    const db = openTestDb();
    writeSecret(db, 'apikey:openai', 'sk-ok');
    const st = secretsStatus(db);
    expect(st.roundTrip).toBe('ok');
    expect(deleteSecretRecord(db, 'apikey:openai')).toBe(1);
    expect(readSecret(db, 'apikey:openai')).toEqual({ ok: false, reason: 'missing' });
    clearReentry('apikey:openai');
    db.close();
  });
});

describe('reentry scan: unreadable blobs marked, readable unmarked, idempotent', () => {
  it('readable secrets stay working, scan is stable', () => {
    const db = openTestDb();
    writeSecret(db, 'apikey:openai', 'sk-ok');
    expect(scanForReentry(db)).toEqual([]);
    expect(requireApiKey(db, 'openai')).toBe('sk-ok');
    expect(scanForReentry(db)).toEqual([]);
    db.close();
  });
  it('unreadable secrets are marked needs_reentry, nothing deleted', () => {
    const db = openTestDb();
    writeSecret(db, 'apikey:openai', 'sk-ok');
    writeSecret(db, 'apikey:gemini', 'sk-g');
    __setBackendForTests(throwingBackend);
    expect(scanForReentry(db).sort()).toEqual(['apikey:gemini', 'apikey:openai']);
    expect(listSecretIds(db).sort()).toEqual(['apikey:gemini', 'apikey:openai']);
    expect(scanForReentry(db).sort()).toEqual(['apikey:gemini', 'apikey:openai']);
    db.close();
  });
});

describe('safeStorage confinement (grep test)', () => {
  it('only the secrets module and platform adapters touch safeStorage', () => {
    const roots = ['src/main', 'src/shared', 'src/renderer'];
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|js)$/.test(p)) continue;
        if (p.includes(`${path.sep}secrets${path.sep}`) || p.includes(`${path.sep}platform${path.sep}`)) continue;
        const s = fs.readFileSync(p, 'utf8');
        if (/safeStorage|decryptString|encryptString/.test(s)) bad.push(p);
      }
    };
    for (const r of roots) walk(path.join(root, r));
    expect(bad).toEqual([]);
  });
});

describe('scheduler: failing task bodies end terminal exactly once', () => {
  const SNAP = {
    workingFolder: '/tmp', mode: 'do' as const, provider: 'openai', model: 'm',
    memorySnapshotIds: [], attachmentIds: [],
  };
  function setup(run: (task: Task, ctl: RunControl) => Promise<{ status: 'done' | 'failed' | 'stopped' | 'interrupted'; summary: string }>) {
    const events: Array<{ type: string; task: Task }> = [];
    const sch = new Scheduler({
      now: () => 1000,
      settings: () => ({ maxParallel: 2, maxQueued: 20, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false }),
      runTask: run,
      onEvent: (ev) => { events.push(ev as { type: string; task: Task }); },
    });
    return { sch, events };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it('a throwing body becomes failed with one terminal task_changed', async () => {
    const { sch, events } = setup(async () => { throw new Error('Error while decrypting the ciphertext'); });
    const r = sch.create({ prompt: 'hi', origin: 'user_spawn', snapshot: SNAP });
    if ('error' in r) throw new Error(r.error);
    await flush(); await flush();
    expect(sch.get(r.task.id)?.state).toBe('failed');
    const terminals = events.filter((e) => e.type === 'task_changed' && ['done', 'failed', 'stopped', 'interrupted'].includes(e.task.state));
    expect(terminals.length).toBe(1);
  });
  it('abort becomes stopped exactly once', async () => {
    const { sch, events } = setup(async () => {
      await new Promise((res) => setTimeout(res, 50));
      return { status: 'done', summary: 'late' };
    });
    const r = sch.create({ prompt: 'hi', origin: 'user_spawn', snapshot: SNAP });
    if ('error' in r) throw new Error(r.error);
    await flush();
    sch.stop(r.task.id);
    await flush(); await new Promise((res) => setTimeout(res, 80));
    expect(sch.get(r.task.id)?.state).toBe('stopped');
    const terminals = events.filter((e) => e.type === 'task_changed' && ['done', 'failed', 'stopped', 'interrupted'].includes(e.task.state));
    expect(terminals.length).toBe(1);
  });
});
