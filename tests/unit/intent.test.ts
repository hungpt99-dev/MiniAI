import { describe, it, expect } from 'vitest';
import {
  heuristicIntent, parseIntentReply, classifyIntent, clarifyQuestion, CLASSIFY_PROMPT,
} from '../../src/main/agent/intent';

describe('intent heuristic', () => {
  it('routes path-like mentions to act in any language', () => {
    expect(heuristicIntent('move report.pdf to Documents')).toBe('act');
    expect(heuristicIntent('mở file report.pdf giúp tôi')).toBe('act');
    expect(heuristicIntent('打开report.pdf文件')).toBe('act');
  });
  it('routes questions to answer in any script', () => {
    expect(heuristicIntent('What is the capital of Peru?')).toBe('answer');
    expect(heuristicIntent('Thủ đô của Pháp là gì?')).toBe('answer');
    expect(heuristicIntent('法国的首都是哪里？')).toBe('answer');
    expect(heuristicIntent('ما هي عاصمة فرنسا؟')).toBe('answer');
  });
  it('returns null when uncertain or for slash input', () => {
    expect(heuristicIntent('/summarize this')).toBeNull();
    expect(heuristicIntent('')).toBeNull();
    expect(heuristicIntent('hmm')).toBeNull();
    // English verbs alone never shortcut: the model decides by meaning.
    expect(heuristicIntent('find files I changed today')).toBeNull();
    expect(heuristicIntent('explain what a mutex is')).toBeNull();
    expect(heuristicIntent('calculate 18% tip on 64')).toBeNull();
  });
});

describe('intent model fallback', () => {
  it('parses ACT/ANSWER/CLARIFY replies, clarifies on garbage', () => {
    expect(parseIntentReply('ACT')).toBe('act');
    expect(parseIntentReply('  answer.')).toBe('answer');
    expect(parseIntentReply('CLARIFY')).toBe('clarify');
    expect(parseIntentReply('banana')).toBe('clarify');
    expect(parseIntentReply('')).toBe('clarify');
  });
  it('prefers heuristic, calls model only when uncertain', async () => {
    let calls = 0;
    const askModel = async (p: string) => {
      calls++;
      expect(p).toContain(CLASSIFY_PROMPT.slice(0, 20));
      return 'ANSWER';
    };
    expect(await classifyIntent('What is the capital of Peru?', { askModel })).toBe('answer');
    expect(calls).toBe(0);
    expect(await classifyIntent('hmm', { askModel })).toBe('answer');
    expect(calls).toBe(1);
  });
  it('clarifies when the model call fails', async () => {
    const askModel = async (): Promise<string> => { throw new Error('no key'); };
    expect(await classifyIntent('hmm', { askModel })).toBe('clarify');
    expect(await classifyIntent('hmm')).toBe('clarify');
  });
  it('asks one concise clarifying question', () => {
    const q = clarifyQuestion('do the thing with stuff');
    expect(q.length).toBeLessThan(220);
    expect(q).toMatch(/do it|just answer/i);
  });
  it('prompt carries multilingual few-shots (meaning, not English verbs)', () => {
    expect(CLASSIFY_PROMPT).toMatch(/abre mi archivo/);
    expect(CLASSIFY_PROMPT).toMatch(/打开我的文件/);
    expect(CLASSIFY_PROMPT).toMatch(/mở file của tôi/);
    expect(CLASSIFY_PROMPT).toMatch(/افتح الملف/);
    expect(CLASSIFY_PROMPT).toMatch(/मेरी फ़ाइल खोलो/);
    expect(CLASSIFY_PROMPT).toMatch(/in any language/);
  });
  it('non-English requests fall through to the model call', async () => {
    // Heuristic has no Spanish/Chinese verbs: uncertain -> exactly one model call.
    const seen: string[] = [];
    const askModel = async (p: string) => { seen.push(p); return 'ACT'; };
    expect(await classifyIntent('abre mi archivo', { askModel })).toBe('act');
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('abre mi archivo');
    const askModel2 = async () => 'ANSWER';
    expect(await classifyIntent('法国的首都是哪里？', { askModel: askModel2 })).toBe('answer');
    const seenHi: string[] = [];
    const askHi = async (p: string) => { seenHi.push(p); return 'ACT'; };
    expect(await classifyIntent('मेरी फ़ाइल खोलो', { askModel: askHi })).toBe('act');
    expect(seenHi.length).toBe(1);
    const askAr = async () => 'ANSWER';
    expect(await classifyIntent('ما هي عاصمة فرنسا؟', { askModel: askAr })).toBe('answer');
  });
});
