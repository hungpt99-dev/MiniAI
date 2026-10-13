import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './migrations';
import { platform } from '../platform/index';

let db: DatabaseSync | null = null;

export const APP_NAME = 'Nexio';
export const DB_FILENAME = 'nexio.db';

/** Old locations from before renames; read in place, never moved or deleted. */
function legacyDbCandidates(): string[] {
  if (platform().key === 'win32') {
    const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
    return [
      path.join(roaming, 'MiniAI', 'nexio.db'),
      path.join(roaming, 'MiniAI', 'miniai.db'),
    ];
  }
  const home = process.env.HOME || '.';
  return [
    path.join(home, '.miniai', 'nexio.db'),
    path.join(home, '.miniai', 'miniai.db'),
    path.join(home, '.nexio', 'miniai.db'),
  ];
}

export function resolveDbPath(userDataPath?: string): string {
  const base =
    userDataPath ||
    process.env.NEXIO_DATA_DIR ||
    platform().defaultDataDir(APP_NAME);
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, DB_FILENAME);
  if (!userDataPath && !fs.existsSync(file)) {
    // Existing installs keep working: use the old folder in place.
    for (const legacy of legacyDbCandidates()) {
      try {
        if (fs.existsSync(legacy)) return legacy;
      } catch { /* ignore */ }
    }
  }
  return file;
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
