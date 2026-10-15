import type { DatabaseSync } from 'node:sqlite';
import {
  readSecret as modRead,
  writeSecret as modWrite,
  deleteSecretRecord as modDelete,
  listSecretIds as modList,
  encryptText as modEncryptText,
  decryptText as modDecryptText,
  secretsStatus as modStatus,
} from '../secrets/index';
import { redact } from '../secrets/redact';

// Compatibility surface: same signatures as before, new semantics — reads
// NEVER throw (unreadable -> undefined + logged id/reason), writes refuse
// loudly without a backend instead of persisting insecure fallbacks.

export function isEncryptionAvailable(): boolean {
  try {
    return modStatus({} as DatabaseSync).available;
  } catch {
    return false;
  }
}

export function setSecret(db: DatabaseSync, service: string, value: string): void {
  modWrite(db, service, value);
}

export function deleteSecret(db: DatabaseSync, service: string): number {
  return modDelete(db, service);
}

export function getSecret(db: DatabaseSync, service: string): string | undefined {
  const r = modRead(db, service);
  return r.ok ? r.value : undefined;
}

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

export { redact };

export function apiKeyService(provider: string): string {
  return `apikey:${provider}`;
}

export function encryptText(s: string): { cipher: string; encrypted: boolean } {
  return modEncryptText(s);
}

export function decryptText(cipher: string): string {
  return modDecryptText(cipher);
}

export function listSecretServices(db: DatabaseSync): string[] {
  return modList(db);
}
