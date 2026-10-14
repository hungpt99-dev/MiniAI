/** Lightweight intent router: structural signals only, one small model call otherwise.
 * No English-verb lists: non-English requests always fall through to the model,
 * which decides by meaning (multilingual few-shots in CLASSIFY_PROMPT).
 */

export type Intent = 'act' | 'answer' | 'clarify';

const PATH_LIKE = /([A-Za-z]:\\|\/(Users|home|tmp|etc|var)\/|\.(txt|md|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip|json|ts|js|py)\b)/;

// Question shape across scripts: ? U+FF1F (CJK) U+061F (Arabic) U+037E (Greek).
const QUESTION_SHAPE = /[?\uFF1F\u061F\u037E]\s*$/u;

/**
 * Pure structural pass. Returns null when uncertain (caller runs one cheap
 * model call). Slash commands never route here. English-verb guessing was
 * removed: it mis-routed other languages, so only paths and question marks
 * shortcut; everything else asks the model.
 */
export function heuristicIntent(text: string): Intent | null {
  const t = text.trim();
  if (!t || t.startsWith('/')) return null;
  // Path-like mentions are action-ish regardless of language.
  if (PATH_LIKE.test(t) && !QUESTION_SHAPE.test(t)) return 'act';
  // Bare question with no path signal → answer; statement otherwise → uncertain.
  if (QUESTION_SHAPE.test(t)) return 'answer';
  return null;
}

export const CLASSIFY_PROMPT =
  'Classify the user request as exactly one word: ACT if it needs computer interaction ' +
  '(find/open/move/create/organize files, run commands, change settings, use apps), ' +
  'ANSWER if it is knowledge/writing/explanation/calculation with no computer action, ' +
  'CLARIFY if it is ambiguous and could change the machine. Reply with only that word. ' +
  'The request may be in any language — decide by meaning, not by English verbs. ' +
  'Examples: "abre mi archivo" -> ACT. "打开我的文件" -> ACT. "mở file của tôi" -> ACT. ' +
  '"افتح الملف" -> ACT. "मेरी फ़ाइल खोलो" -> ACT. "What is the capital of France?" -> ANSWER. ' +
  '"Thủ đô của Pháp là gì?" -> ANSWER. "法国的首都是哪里？" -> ANSWER. ' +
  '"¿Cuál es la capital de Francia?" -> ANSWER. "फ्रांस की राजधानी क्या है?" -> ANSWER. ' +
  '"ما هي عاصمة فرنسا؟" -> ANSWER.\nRequest: ';

/** Parse a tiny model reply into an Intent; unparseable → clarify (safe). */
export function parseIntentReply(reply: string): Intent {
  const w = reply.trim().toUpperCase().split(/[^A-Z]+/)[0];
  if (w === 'ACT') return 'act';
  if (w === 'ANSWER') return 'answer';
  return 'clarify';
}

export interface IntentDeps {
  /** One cheap model call; rejects/throws on failure. */
  askModel?: (prompt: string) => Promise<string>;
}

/** Heuristic first; one inexpensive model call on uncertainty; clarify on failure. */
export async function classifyIntent(text: string, deps: IntentDeps = {}): Promise<Intent> {
  const h = heuristicIntent(text);
  if (h === 'act' || h === 'answer') return h;
  if (!deps.askModel) return 'clarify';
  try {
    return parseIntentReply(await deps.askModel(CLASSIFY_PROMPT + text.trim().slice(0, 500)));
  } catch {
    return 'clarify';
  }
}

/** Clarifying question for uncertain intent involving potential machine changes. */
export function clarifyQuestion(text: string): string {
  const short = text.trim().slice(0, 120);
  return `Should I take action on your computer for "${short}", or just answer? Reply "do it" or "just answer".`;
}
