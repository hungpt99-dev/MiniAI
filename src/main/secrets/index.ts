import type { DatabaseSync } from 'node:sqlite';
import { platform } from '../platform/index';
import { APP_NAME } from '../db/db';
import { AppError, friendlyFor } from '../errors/app-error';

/**
 * ONE secrets module: nothing outside src/main/secrets/ + the platform
 * adapters touches safeStorage (grep-tested). Secrets live in the `secrets`
 * table; ciphertext is never logged, only ids + reason codes + backend names.
 *
 * Envelope v2 (written for every new secret): JSON with base64 ciphertext.
 * Readers also accept legacy rows: raw safeStorage buffers and the old
 * insecure `plain:`+xor fallback (read-only compat, never written).
 * SQLite single-statement writes are atomic; no temp files needed.
 */

export type SecretReason = 'missing' | 'undecryptable' | 'unavailable' | 'corrupt';

export type SecretRead =
  | { ok: true; value: string; session?: boolean }
  | { ok: false; reason: SecretReason };

interface Backend {
  available(): boolean;
  encrypt(s: string): Buffer;
  decrypt(b: Buffer): string;
}

let backendOverride: Backend | null | undefined;
let ready = false;
/** Session-only secrets (secure storage unavailable or user chose session-only). Never persisted. */
const sessionSecrets = new Map<string, string>();
/** Ids whose stored blob cannot be decrypted (re-enter in Settings). */
const reentry = new Set<string>();

/** Test seam: inject (or remove) the crypto backend. */
export function __setBackendForTests(b: Backend | null | undefined): void {
  backendOverride = b;
}
/** Test seam: clear session + reentry state between cases. */
export function __resetSecretsForTests(): void {
  sessionSecrets.clear();
  reentry.clear();
  ready = true;
}
/** Called once from main startup after app.whenReady(). */
export function markSecretsReady(): void {
  ready = true;
}

function backend(): Backend | null {
  // why: crypto ops and availability are separate. Tests inject ops without
  // claiming an OS store; production has both or neither.
  if (backendOverride !== undefined) return backendOverride;
  try {
    return platform().secrets.available() ? platform().secrets : null;
  } catch {
    return null;
  }
}

function backendName(): string {
  try {
    return platform().key;
  } catch {
    return 'unknown';
  }
}

function logWarn(id: string, reason: SecretReason): void {
  // why: ids + reasons only — values and ciphertext never reach logs.
  console.warn(`[Nexio] secret '${id}' unreadable: ${reason} (backend ${backendName()})`);
}

interface EnvelopeV2 {
  v: 2;
  id: string;
  createdAt: number;
  backend: string;
  appId: string;
  cipher: string;
}

function parseStored(id: string, raw: Buffer | Uint8Array | string): { cipher: Buffer } | { reason: SecretReason } {
  let buf: Buffer;
  try {
    if (typeof raw === 'string') buf = Buffer.from(raw, 'utf8');
    else buf = Buffer.from(raw);
  } catch {
    return { reason: 'corrupt' };
  }
  const text = buf.toString('utf8');
  // v2 envelope
  if (text.startsWith('{')) {
    try {
      const env = JSON.parse(text) as Partial<EnvelopeV2>;
      if (env && env.v === 2 && typeof env.cipher === 'string') {
        return { cipher: Buffer.from(env.cipher, 'base64') };
      }
    } catch { /* fall through to legacy */ }
    return { reason: 'corrupt' };
  }
  // legacy insecure fallback (read-only compat, never written anymore)
  if (text.startsWith('plain:')) {
    const b = buf.subarray('plain:'.length);
    for (let i = 0; i < b.length; i++) b[i] ^= 0x5a;
    return { cipher: Buffer.from(`__xorplain__:${b.toString('utf8')}`) };
  }
  // legacy raw safeStorage buffer
  if (buf.length === 0) return { reason: 'corrupt' };
  return { cipher: buf };
}

/** Read a secret. NEVER throws and never logs values. */
export function readSecret(db: DatabaseSync, id: string): SecretRead {
  let row: { value: Buffer | Uint8Array | string } | undefined;
  try {
    row = db.prepare('SELECT value FROM secrets WHERE service = ?').get(id) as
      | { value: Buffer | Uint8Array | string }
      | undefined;
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const sess = sessionSecrets.get(id);
  if (!row) {
    if (sess !== undefined) return { ok: true, value: sess, session: true };
    return { ok: false, reason: 'missing' };
  }
  const parsed = parseStored(id, row.value);
  if ('reason' in parsed) {
    logWarn(id, parsed.reason);
    if (parsed.reason === 'undecryptable' || parsed.reason === 'corrupt') reentry.add(id);
    return { ok: false, reason: parsed.reason };
  }
  // compat fallback blobs decode without a backend
  if (parsed.cipher.toString('utf8').startsWith('__xorplain__:')) {
    return { ok: true, value: parsed.cipher.toString('utf8').slice('__xorplain__:'.length) };
  }
  const be = backend();
  if (!be) {
    logWarn(id, 'unavailable');
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const value = be.decrypt(parsed.cipher);
    if (sess !== undefined) return { ok: true, value: sess, session: true };
    return { ok: true, value };
  } catch {
    logWarn(id, 'undecryptable');
    reentry.add(id);
    return { ok: false, reason: 'undecryptable' };
  }
}

/** Write a secret (v2 envelope, atomic single statement). Refuses LOUDLY when
 * there is no backend — never persists plaintext silently. */
export function writeSecret(db: DatabaseSync, id: string, value: string): void {
  const be = backend();
  if (!be || !ready) {
    throw new AppError(
      'SECRET_UNAVAILABLE',
      friendlyFor('SECRET_UNAVAILABLE').text,
      `backend=${backendName()} ready=${ready}`,
      'open-settings',
    );
  }
  const enc = be.encrypt(value);
  const env: EnvelopeV2 = {
    v: 2, id, createdAt: Date.now(), backend: backendName(), appId: APP_NAME,
    cipher: enc.toString('base64'),
  };
  db.prepare(
    'INSERT INTO secrets (service, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(service) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
  ).run(id, JSON.stringify(env), Date.now());
  sessionSecrets.delete(id);
  reentry.delete(id);
}

/** Keep a secret in memory only (secure storage unavailable). */
export function writeSessionSecret(id: string, value: string): void {
  sessionSecrets.set(id, value);
}

export function deleteSecretRecord(db: DatabaseSync, id: string): number {
  sessionSecrets.delete(id);
  reentry.delete(id);
  try {
    const r = db.prepare('DELETE FROM secrets WHERE service = ?').run(id) as unknown as { changes?: unknown };
    return typeof r?.changes === 'number' ? r.changes : 0;
  } catch {
    return 0;
  }
}

export function listSecretIds(db: DatabaseSync): string[] {
  try {
    const rows = db.prepare('SELECT service FROM secrets').all() as Array<{ service: string }>;
    return rows.map((r) => r.service);
  } catch {
    return [];
  }
}

/** Provider keys: missing -> not configured, undecryptable -> re-enter.
 * Throws AppError (friendly by construction). */
export function requireApiKey(db: DatabaseSync, provider: string): string {
  const r = readSecret(db, `apikey:${provider}`);
  if (r.ok) {
    if (!r.value) throw new AppError('PROVIDER_NOT_CONFIGURED', friendlyFor('PROVIDER_NOT_CONFIGURED').text, '', 'open-settings');
    return r.value;
  }
  if (r.reason === 'missing') {
    throw new AppError('PROVIDER_NOT_CONFIGURED', friendlyFor('PROVIDER_NOT_CONFIGURED').text, '', 'open-settings');
  }
  if (r.reason === 'unavailable') {
    throw new AppError('SECRET_UNAVAILABLE', friendlyFor('SECRET_UNAVAILABLE').text, `id=apikey:${provider}`, 'open-settings');
  }
  throw new AppError('SECRET_UNREADABLE', friendlyFor('SECRET_UNREADABLE').text, `id=apikey:${provider} reason=${r.reason}`, 'open-settings');
}

/** Prefix-marked string encryption for at-rest data (memory text). Throws
 * loudly without a backend — never plaintext silently. */
export function encryptText(s: string): { cipher: string; encrypted: boolean } {
  const be = backend();
  if (!be || !ready) {
    throw new AppError(
      'SECRET_UNAVAILABLE',
      friendlyFor('SECRET_UNAVAILABLE').text,
      `at-rest encrypt refused (backend=${backendName()} ready=${ready})`,
      'open-settings',
    );
  }
  return { cipher: 'enc:' + be.encrypt(s).toString('base64'), encrypted: true };
}

/** Decrypt at-rest data. Throws AppError (friendly) when unreadable. */
export function decryptText(cipher: string): string {
  if (cipher.startsWith('enc:')) {
    const be = backend();
    if (!be) {
      throw new AppError('SECRET_UNAVAILABLE', friendlyFor('SECRET_UNAVAILABLE').text, 'at-rest decrypt: no backend', 'open-settings');
    }
    try {
      return be.decrypt(Buffer.from(cipher.slice(4), 'base64'));
    } catch {
      logWarn('memory-text', 'undecryptable');
      throw new AppError('SECRET_UNREADABLE', friendlyFor('SECRET_UNREADABLE').text, 'at-rest data undecryptable', 'open-settings');
    }
  }
  if (cipher.startsWith('plain:')) return cipher.slice(6);
  return cipher; // legacy unwrapped row
}
/** Startup self-check: encrypt/decrypt round trip + scan stored ids. */
export function secretsStatus(db: DatabaseSync): {
  available: boolean; backend: string; ready: boolean;
  roundTrip: 'ok' | 'failed' | 'skipped'; reentry: string[];
} {
  const be = backend();
  let roundTrip: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (be && ready) {
    try {
      const probe = `probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      roundTrip = be.decrypt(be.encrypt(probe)) === probe ? 'ok' : 'failed';
    } catch {
      roundTrip = 'failed';
    }
  }
  if (roundTrip === 'failed') {
    for (const id of listSecretIds(db)) reentry.add(id);
  }
  return { available: be ? be.available() : false, backend: backendName(), ready, roundTrip, reentry: [...reentry] };
}

/** Mark every stored id that cannot be decrypted (startup scan). */
export function scanForReentry(db: DatabaseSync): string[] {
  for (const id of listSecretIds(db)) {
    const r = readSecret(db, id);
    if (!r.ok && (r.reason === 'undecryptable' || r.reason === 'corrupt')) reentry.add(id);
    if (r.ok) reentry.delete(id);
  }
  return [...reentry];
}

export function clearReentry(id: string): void {
  reentry.delete(id);
}
