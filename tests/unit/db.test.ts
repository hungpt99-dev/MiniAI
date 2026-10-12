import { describe, it, expect } from 'vitest';
import { openTestDb } from '../../src/main/db/db';
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
});
