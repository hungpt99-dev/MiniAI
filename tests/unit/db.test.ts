import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb, getDb, closeDb } from '../../src/main/db/db';
import { createDatabase } from '../../src/main/db/sqlite';
import { SCHEMA_VERSION } from '../../src/main/db/migrations';
import { createConversation, listConversations, addMessage, getMessages, deleteConversation } from '../../src/main/db/conversations';
import { extractVars, render, upsertTemplate, listTemplates, seedBuiltins, listWorkflows } from '../../src/main/db/templates';

describe('db + templates', () => {
  it('conversation CRUD + messages', () => {
    const db = openTestDb();
    const c = createConversation(db, 't');
    addMessage(db, c.id, 'user', 'hi');
    addMessage(db, c.id, 'assistant', 'hello');
    expect(getMessages(db, c.id).length).toBe(2);
    expect(listConversations(db).length).toBe(1);
    deleteConversation(db, c.id);
    expect(listConversations(db).length).toBe(0);
    db.close();
  });
  it('extractVars/render {{var}} validation', () => {
    expect(extractVars('Hi {{name}}, {{name}} + {{x}}')).toEqual(['name', 'x']);
    expect(render('Hi {{name}}', { name: 'Bob' })).toBe('Hi Bob');
    expect(() => render('Hi {{name}}', {})).toThrow(/Missing variables/);
  });
  it('seeds 6 templates + 2 workflows', () => {
    const db = openTestDb();
    seedBuiltins(db);
    const ts = listTemplates(db).map((t) => t.trigger);
    for (const t of ['/translate', '/rewrite', '/summarize', '/explain', '/analyze', '/reply']) {
      expect(ts).toContain(t);
    }
    expect(listWorkflows(db).length).toBe(2);
    upsertTemplate(db, { trigger: '/translate', title: 'T2', body: 'B {{x}}' });
    expect(listTemplates(db).find((t) => t.trigger === '/translate')?.title).toBe('T2');
    db.close();
  });
  it('builtin prompt bodies are self-contained (single {{text}}, model parses the rest)', () => {
    const db = openTestDb();
    seedBuiltins(db);
    for (const t of listTemplates(db)) {
      expect(t.vars).toEqual(['text']);
    }
    const tr = listTemplates(db).find((t) => t.trigger === '/translate')!;
    expect(tr.body).toMatch(/unless the message itself names a different target language/);
    expect(tr.body).toMatch(/Reply with only the translation/);
    db.close();
  });
  it('superseded builtin bodies migrate in place; custom bodies never touched', () => {
    const db = openTestDb();
    seedBuiltins(db);
    // simulate an older install, then reseed
    db.prepare("UPDATE templates SET body = 'Translate the following text to {{lang}}:\n\n{{text}}' WHERE trigger = '/translate'").run();
    upsertTemplate(db, { trigger: '/rewrite', title: 'Mine', body: 'Custom {{tone}} voice:\n\n{{text}}' });
    seedBuiltins(db);
    const tr = listTemplates(db).find((t) => t.trigger === '/translate')!;
    expect(tr.vars).toEqual(['text']);
    expect(tr.body).not.toContain('{{lang}}');
    const rw = listTemplates(db).find((t) => t.trigger === '/rewrite')!;
    expect(rw.body).toContain('Custom {{tone}} voice');
    // idempotent
    seedBuiltins(db);
    expect(listTemplates(db).find((t) => t.trigger === '/translate')?.body).toBe(tr.body);
    db.close();
  });
  it('fresh DB: messages has mode/command/args and user_version = SCHEMA_VERSION', () => {
    const db = openTestDb();
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    for (const c of ['mode', 'command', 'args']) {
      expect(cols.map((x) => x.name)).toContain(c);
    }
    const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(ver).toBe(SCHEMA_VERSION);
    const c = createConversation(db, 't');
    addMessage(db, c.id, 'user', 'hi', { mode: 'ask' });
    expect(getMessages(db, c.id)[0].mode).toBe('ask');
    db.close();
  });
  it('stale-versioned DB file is renamed aside and replaced fresh (reset, never migrate)', () => {
    const prev = process.env.NEXIO_DATA_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-schemaguard-'));
    process.env.NEXIO_DATA_DIR = dir;
    try {
      closeDb();
      // old build schema: no mode column, no user_version stamp
      const stale = createDatabase(path.join(dir, 'nexio.db'));
      stale.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL)');
      stale.close();
      const db = getDb();
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      expect(cols.map((x) => x.name)).toContain('mode');
      const c = createConversation(db, 't');
      addMessage(db, c.id, 'user', 'hello', { mode: 'do' });
      expect(getMessages(db, c.id).length).toBe(1);
      const olds = fs.readdirSync(dir).filter((f) => f.startsWith('nexio.db.old-') && !f.endsWith('-wal') && !f.endsWith('-shm'));
      expect(olds.length).toBe(1);
      // matching version reopens in place — nothing renamed again
      closeDb();
      getDb();
      closeDb();
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('nexio.db.old-') && !f.endsWith('-wal') && !f.endsWith('-shm')).length).toBe(1);
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.NEXIO_DATA_DIR;
      else process.env.NEXIO_DATA_DIR = prev;
    }
  });
});
