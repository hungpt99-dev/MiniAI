import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './migrations';

let db: DatabaseSync | null = null;

export function resolveDbPath(userDataPath?: string): string {
  const base =
    userDataPath ||
    process.env.MINIAI_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'MiniAI')
      : path.join(process.env.HOME || '.', '.miniai'));
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'miniai.db');
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
