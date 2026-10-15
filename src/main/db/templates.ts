import type { DatabaseSync } from 'node:sqlite';
import type { PromptTemplate, Workflow } from '../../shared/types';
import { uid } from './conversations';

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function extractVars(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

export function render(body: string, vars: Record<string, string>): string {
  const missing = extractVars(body).filter((v) => !(v in vars));
  if (missing.length > 0) throw new Error(`Missing variables: ${missing.join(', ')}`);
  return body.replace(VAR_RE, (_, name: string) => vars[name]);
}

export function listTemplates(db: DatabaseSync): PromptTemplate[] {
  const rows = db.prepare('SELECT * FROM templates ORDER BY trigger ASC').all() as Array<{
    id: string; trigger: string; title: string; body: string;
  }>;
  return rows.map((r) => ({ ...r, vars: extractVars(r.body) }));
}

export function getTemplate(db: DatabaseSync, idOrTrigger: string): PromptTemplate | undefined {
  const row = db.prepare('SELECT * FROM templates WHERE id = ? OR trigger = ?').get(idOrTrigger, idOrTrigger) as
    | { id: string; trigger: string; title: string; body: string } | undefined;
  return row ? { ...row, vars: extractVars(row.body) } : undefined;
}

export function upsertTemplate(db: DatabaseSync, t: { id?: string; trigger: string; title: string; body: string }): PromptTemplate {
  if (!t.trigger.startsWith('/')) throw new Error('Template trigger must start with /');
  if (!t.body.trim()) throw new Error('Template body must not be empty');
  const id = t.id || uid('t-');
  db.prepare(
    'INSERT INTO templates (id, trigger, title, body) VALUES (?, ?, ?, ?) ON CONFLICT(trigger) DO UPDATE SET title=excluded.title, body=excluded.body',
  ).run(id, t.trigger, t.title, t.body);
  return { id, trigger: t.trigger, title: t.title, body: t.body, vars: extractVars(t.body) };
}

export function listWorkflows(db: DatabaseSync): Workflow[] {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY trigger ASC').all() as Array<{
    id: string; trigger: string; title: string; steps: string;
  }>;
  return rows.map((r) => ({ id: r.id, trigger: r.trigger, title: r.title, steps: JSON.parse(r.steps) }));
}

const BUILTIN_TEMPLATES: Array<{ trigger: string; title: string; body: string }> = [
  // why: single {{text}} var everywhere — the model parses target language,
  // tone and length from the message itself (no language-specific parsing).
  { trigger: '/translate', title: 'Translate', body: 'Translate the following text into English, unless the message itself names a different target language (for example "vi:", "en:" or "to Japanese:"). Reply with only the translation, no explanations.\n\nText:\n{{text}}' },
  { trigger: '/rewrite', title: 'Rewrite', body: 'Rewrite the following text with clear, natural wording. Reply with only the rewritten text, no explanations.\n\nText:\n{{text}}' },
  { trigger: '/summarize', title: 'Summarize', body: 'Summarize the following text in 3 sentences. Reply with only the summary, no explanations.\n\nText:\n{{text}}' },
  { trigger: '/explain', title: 'Explain', body: 'Explain the following text simply, as if to a curious reader. Reply with only the explanation, no explanations about the explanation.\n\nText:\n{{text}}' },
  { trigger: '/analyze', title: 'Analyze', body: 'Analyze the following and list key points, risks, and suggestions:\n\n{{text}}' },
  { trigger: '/reply', title: 'Draft reply', body: 'Draft a polite reply to this message. Reply with only the draft, no explanations.\n\nMessage:\n{{text}}' },
];

/** Previous builtin bodies (had unfillable vars like {{lang}}): rows still
 * matching them are upgraded in place; user-edited bodies are never touched. */
const SUPERSEDED_BODIES: Record<string, string> = {
  '/translate': 'Translate the following text to {{lang}}:\n\n{{text}}',
  '/rewrite': 'Rewrite the following text in a {{tone}} tone:\n\n{{text}}',
  '/summarize': 'Summarize the following in {{sentences}} sentences:\n\n{{text}}',
  '/explain': 'Explain the following simply, as if to a {{audience}}:\n\n{{text}}',
  '/reply': 'Draft a polite {{tone}} reply to this message:\n\n{{text}}',
};

const BUILTIN_WORKFLOWS: Array<{ trigger: string; title: string; steps: Workflow }> = [];

export function seedBuiltins(db: DatabaseSync): void {
  for (const t of BUILTIN_TEMPLATES) {
    db.prepare(
      'INSERT INTO templates (id, trigger, title, body) VALUES (?, ?, ?, ?) ON CONFLICT(trigger) DO NOTHING',
    ).run(uid('t-'), t.trigger, t.title, t.body);
    const old = SUPERSEDED_BODIES[t.trigger];
    if (old) {
      db.prepare('UPDATE templates SET body = ? WHERE trigger = ? AND body = ?').run(t.body, t.trigger, old);
    }
  }
  const emailReply: Workflow = {
    id: 'wf-email-reply', trigger: '/email-reply', title: 'Email reply',
    steps: [
      { kind: 'user-input', outputVar: 'text', prompt: 'Paste the email to reply to' },
      { kind: 'prompt', templateId: '/reply', inputVar: 'text', outputVar: 'draft' },
      { kind: 'output', inputVar: 'draft' },
    ],
  };
  const reqReview: Workflow = {
    id: 'wf-req-review', trigger: '/requirement-review', title: 'Requirement review',
    steps: [
      { kind: 'user-input', outputVar: 'text', prompt: 'Paste the requirement' },
      { kind: 'prompt', templateId: '/analyze', inputVar: 'text', outputVar: 'analysis' },
      { kind: 'output', inputVar: 'analysis' },
    ],
  };
  for (const w of [emailReply, reqReview]) {
    db.prepare(
      'INSERT INTO workflows (id, trigger, title, steps) VALUES (?, ?, ?, ?) ON CONFLICT(trigger) DO NOTHING',
    ).run(w.id, w.trigger, w.title, JSON.stringify(w.steps));
  }
  void BUILTIN_WORKFLOWS;
}
