/** Lightweight intent router: cheap heuristic first, one small model call otherwise. */

export type Intent = 'act' | 'answer' | 'clarify';

const ACT_VERBS =
  /\b(open|launch|start|find|search|locate|show me|list|move|create|make|new|delete|remove|trash|rename|copy|duplicate|organize|tidy|sort|clean|run|execute|install|uninstall|download|save|change|set|update|configure|backup|compress|zip|extract|print|kill|stop|restart)\b/i;

const MY_STUFF = /\bmy\s+(files?|folders?|downloads?|documents?|desktop|disk|apps?|applications?|photos?|music|videos?|email|calendar)\b/i;

const PATH_LIKE = /([A-Za-z]:\\|\/(Users|home|tmp|etc|var)\/|\.(txt|md|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip|json|ts|js|py)\b)/;

const ANSWER_LEADS =
  /^(what is|what are|what does|what's|who is|who are|why|when|where|which|explain|define|meaning of|how does|how do|tell me about|is it true|difference between|calculate|compute|convert|translate|write|summarize|draft|review this|meaning)\b/i;

const QUESTION_SHAPE = /\?$/;

/**
 * Pure heuristic pass. Returns null when uncertain (caller may try one
 * cheap model call). Slash commands are never routed here.
 */
export function heuristicIntent(text: string): Intent | null {
  const t = text.trim();
  if (!t || t.startsWith('/')) return null;
  const answerLead = ANSWER_LEADS.test(t);
  const actSignal = ACT_VERBS.test(t) || MY_STUFF.test(t) || PATH_LIKE.test(t);
  // "how do I ..." with a computer object is action-ish; pure knowledge stays answer.
  if (answerLead && !actSignal) return 'answer';
  if (actSignal && !answerLead) return 'act';
  if (answerLead && actSignal) {
    // Knowledge-shaped but machine-targeted ("what's using my disk space?").
    return /my\s+(disk|drive|storage|memory|cpu)/i.test(t) ? 'act' : 'answer';
  }
  // Bare question with no action signal → answer; statement otherwise → uncertain.
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
  '"افتح الملف" -> ACT. "What is the capital of France?" -> ANSWER. ' +
  '"Thủ đô của Pháp là gì?" -> ANSWER. "法国的首都是哪里？" -> ANSWER.\nRequest: ';

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
