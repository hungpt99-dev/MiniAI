import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './migrations';
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
  db = createDatabase(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
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
