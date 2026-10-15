import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations, SCHEMA_VERSION } from './migrations';
import { platform } from '../platform/index';

let db: DatabaseSync | null = null;

export const APP_NAME = 'Nexio';
export const DB_FILENAME = 'nexio.db';

export function resolveDbPath(userDataPath?: string): string {
  const base =
    userDataPath ||
    process.env.NEXIO_DATA_DIR ||
    platform().defaultDataDir(APP_NAME);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, DB_FILENAME);
}

export function getDb(userDataPath?: string): DatabaseSync {
  if (db) return db;
  const file = resolveDbPath(userDataPath);
  // why: CREATE TABLE IF NOT EXISTS never heals a stale file — a version
  // mismatch resets (dev only, app unreleased), never migrates.
  const existed = fs.existsSync(file) && fs.statSync(file).size > 0;
  db = createDatabase(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0;
  if (existed && ver !== SCHEMA_VERSION) {
    const stamp = Date.now();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, `${file}.old-${stamp}${suffix}`);
      } catch { /* best-effort aside */ }
    }
    console.warn(`[Nexio] schema v${ver} != v${SCHEMA_VERSION}; moved stale DB aside (nexio.db.old-${stamp})`);
    db = createDatabase(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Test helper: in-memory isolated DB with migrations applied. */
export function openTestDb(): DatabaseSync {
  const t = createDatabase(':memory:');
  runMigrations(t);
  return t;
}
