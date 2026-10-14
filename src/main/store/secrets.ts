import type { DatabaseSync } from 'node:sqlite';
import { platform } from '../platform/index';

// safeStorage is only available in Electron main; lazy-require so unit tests (plain node) still run.
interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

function loadSafeStorage(): SafeStorageLike | null {
  try {
    return platform().secrets.available() ? {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => platform().secrets.encrypt(s),
      decryptString: (b: Buffer) => platform().secrets.decrypt(b),
    } : null;
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

export function isEncryptionAvailable(): boolean {
  return loadSafeStorage() !== null;
}

export function setSecret(db: DatabaseSync, service: string, value: string): void {
  const ss = loadSafeStorage();
  if (!ss) console.warn('[Nexio] safeStorage unavailable — persisting secret with insecure fallback obfuscation (dev only)');
  const enc: Buffer = ss ? ss.encryptString(value) : Buffer.concat([Buffer.from(FALLBACK_PREFIX), xorBuf(value)]);
  db.prepare('INSERT INTO secrets (service, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(service) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt').run(service, enc, Date.now());
}

/** Remove one secret by exact service name. Returns rows deleted. */
export function deleteSecret(db: DatabaseSync, service: string): number {
  try {
    const r = db.prepare('DELETE FROM secrets WHERE service = ?').run(service) as unknown as { changes?: unknown };
    return typeof r?.changes === 'number' ? r.changes : 0;
  } catch {
    return 0;
  }
}

export function getSecret(db: DatabaseSync, service: string): string | undefined {
  const row = db.prepare('SELECT value FROM secrets WHERE service = ?').get(service) as { value: Buffer | Uint8Array } | undefined;
  if (!row) return undefined;
  const buf = Buffer.from(row.value as Uint8Array);
  if (buf.subarray(0, FALLBACK_PREFIX.length).toString() === FALLBACK_PREFIX) {
    console.warn('[Nexio] safeStorage unavailable — reading secret stored with insecure fallback obfuscation');
    return unxorBuf(buf.subarray(FALLBACK_PREFIX.length));
  }
  const ss = loadSafeStorage();
  if (!ss) throw new Error('No decryption backend available for this secret');
  return ss.decryptString(buf);
}

/** Services owned by one extension (stale-secret cleanup on update). */
export function listSecretsByPrefix(db: DatabaseSync, prefix: string): string[] {
  try {
    const rows = db.prepare('SELECT service FROM secrets WHERE service LIKE ? ESCAPE \'\\\'').all(
      `${prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`,
    ) as Array<{ service: string }>;
    return rows.map((r) => r.service);
  } catch {
    return [];
  }
}

/** Remove every secret owned by one extension (uninstall cleanup). */
export function deleteSecretsByPrefix(db: DatabaseSync, prefix: string): number {
  try {
    const r = db.prepare('DELETE FROM secrets WHERE service LIKE ? ESCAPE \'\\\'').run(
      `${prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`,
    ) as unknown as { changes?: unknown };
    return typeof r?.changes === 'number' ? r.changes : 0;
  } catch {
    return 0;
  }
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

/** Prefix-marked string encryption for at-rest data (memory text). Falls back to plaintext with a marker. */
export function encryptText(s: string): { cipher: string; encrypted: boolean } {
  const ss = loadSafeStorage();
  if (ss) return { cipher: 'enc:' + ss.encryptString(s).toString('base64'), encrypted: true };
  return { cipher: 'plain:' + s, encrypted: false };
}

export function decryptText(cipher: string): string {
  if (cipher.startsWith('enc:')) {
    const ss = loadSafeStorage();
    if (!ss) throw new Error('No decryption backend available for this data');
    return ss.decryptString(Buffer.from(cipher.slice(4), 'base64'));
  }
  if (cipher.startsWith('plain:')) return cipher.slice(6);
  return cipher; // legacy unwrapped row
}
