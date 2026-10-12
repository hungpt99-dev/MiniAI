import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, steps TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL,
      status TEXT NOT NULL, output TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      service TEXT PRIMARY KEY, value BLOB NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
}
