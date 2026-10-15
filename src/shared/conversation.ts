// Conversation-thread helpers (renderer-safe, pure logic only).
// Threading rule: a normal next turn continues the same conversation
// (same id, full history); user-spawned/queued tasks start isolated threads.

/** Path/file-shaped mention across scripts — action-plausible, not proof. */
const PATH_LIKE = /([A-Za-z]:\\|\/(Users|home|tmp|etc|var)\/|\.(txt|md|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip|json|ts|js|py)\b)/;

/** Question mark across scripts: ? U+FF1F (CJK) U+061F (Arabic) U+037E (Greek). */
const QUESTION_SHAPE = /[?\uFF1F\u061F\u037E]\s*$/u;

/**
 * Structural "ask for action" signal for the Switch-to-Do chip. Mirrors the
 * intent router's structural pass (main/agent/intent.ts): paths and file
 * mentions only, never English-verb guessing. Questions and greetings return
 * false; the chip additionally requires an Ask zero-tool answer (renderer).
 */
export function isActionLike(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.startsWith('/')) return false;
  if (QUESTION_SHAPE.test(t)) return false;
  return PATH_LIKE.test(t);
}
