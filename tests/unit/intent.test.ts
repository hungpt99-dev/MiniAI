import { describe, it, expect } from 'vitest';
import {
  heuristicIntent, parseIntentReply, classifyIntent, clarifyQuestion, CLASSIFY_PROMPT,
} from '../../src/main/agent/intent';

describe('intent heuristic', () => {
  it('routes computer actions to act', () => {
    expect(heuristicIntent('find files I changed today')).toBe('act');
    expect(heuristicIntent('Open my last downloaded file')).toBe('act');
    expect(heuristicIntent('Organize Downloads by type')).toBe('act');
    expect(heuristicIntent('move report.pdf to Documents')).toBe('act');
    expect(heuristicIntent('run npm test')).toBe('act');
    expect(heuristicIntent('create notes.txt on my desktop')).toBe('act');
  });
  it('routes knowledge questions to answer', () => {
    expect(heuristicIntent('explain what a mutex is')).toBe('answer');
    expect(heuristicIntent('What is the capital of Peru?')).toBe('answer');
    expect(heuristicIntent('calculate 18% tip on 64')).toBe('answer');
    expect(heuristicIntent('write a haiku about rain')).toBe('answer');
  });
  it('treats machine-targeted analysis as act', () => {
    expect(heuristicIntent("What's using my disk space?")).toBe('act');
  });
  it('returns null when uncertain or for slash input', () => {
    expect(heuristicIntent('/summarize this')).toBeNull();
    expect(heuristicIntent('')).toBeNull();
    expect(heuristicIntent('hmm')).toBeNull();
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
    expect(await classifyIntent('explain mutexes', { askModel })).toBe('answer');
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
});
