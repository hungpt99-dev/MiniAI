import type { DatabaseSync } from 'node:sqlite';

// safeStorage is only available in Electron main; lazy-require so unit tests (plain node) still run.
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

function loadSafeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as { safeStorage: SafeStorageLike };
    return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}

// Fallback obfuscation for tests / machines without DPAPI (NOT secure, only dev).
const FALLBACK_PREFIX = 'plain:';
const XOR_KEY = 0x5a;

function xorBuf(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  for (let i = 0; i < b.length; i++) b[i] ^= XOR_KEY;
  return b;
}
function unxorBuf(b: Buffer): string {
  const c = Buffer.from(b);
  for (let i = 0; i < c.length; i++) c[i] ^= XOR_KEY;
  return c.toString('utf8');
}

export function setSecret(db: DatabaseSync, service: string, value: string): void {
  const ss = loadSafeStorage();
  const enc: Buffer = ss ? ss.encryptString(value) : Buffer.concat([Buffer.from(FALLBACK_PREFIX), xorBuf(value)]);
  db.prepare('INSERT INTO secrets (service, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(service) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt').run(service, enc, Date.now());
}

export function getSecret(db: DatabaseSync, service: string): string | undefined {
  const row = db.prepare('SELECT value FROM secrets WHERE service = ?').get(service) as { value: Buffer | Uint8Array } | undefined;
  if (!row) return undefined;
  const buf = Buffer.from(row.value as Uint8Array);
  if (buf.subarray(0, FALLBACK_PREFIX.length).toString() === FALLBACK_PREFIX) {
    return unxorBuf(buf.subarray(FALLBACK_PREFIX.length));
  }
  const ss = loadSafeStorage();
  if (!ss) throw new Error('No decryption backend available for this secret');
  return ss.decryptString(buf);
}

export function deleteSecret(db: DatabaseSync, service: string): void {
  db.prepare('DELETE FROM secrets WHERE service = ?').run(service);
}

/** Redact anything that looks like an API key / bearer token. Safe to log the result. */
export function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9-_]{4})[A-Za-z0-9-_]+/g, '$1***')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/-]+=*)(?=[\s'"]|$)/gi, '$1***')
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9._-]+)/gi, '$1***');
}

export function apiKeyService(provider: string): string {
  return `apikey:${provider}`;
}
