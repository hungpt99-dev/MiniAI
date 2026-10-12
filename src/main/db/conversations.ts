import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, Conversation } from '../../shared/types';

export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createConversation(db: DatabaseSync, title = 'New chat'): Conversation {
  const now = Date.now();
  const c: Conversation = { id: uid('c-'), title, createdAt: now, updatedAt: now };
  db.prepare('INSERT INTO conversations (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)').run(
    c.id, c.title, c.createdAt, c.updatedAt,
  );
  return c;
}

export function listConversations(db: DatabaseSync, limit = 50): Conversation[] {
  return db.prepare('SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT ?').all(limit) as unknown as Conversation[];
}

export function addMessage(db: DatabaseSync, conversationId: string, role: ChatMessage['role'], content: string): ChatMessage {
  const m: ChatMessage = { id: uid('m-'), role, content, createdAt: Date.now() };
  db.prepare('INSERT INTO messages (id, conversationId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    m.id, conversationId, m.role, m.content, m.createdAt,
  );
  db.prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?').run(Date.now(), conversationId);
  return m;
}

export function getMessages(db: DatabaseSync, conversationId: string): ChatMessage[] {
  return db.prepare('SELECT id, role, content, createdAt FROM messages WHERE conversationId = ? ORDER BY createdAt ASC').all(conversationId) as unknown as ChatMessage[];
}

export function deleteConversation(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM messages WHERE conversationId = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}
