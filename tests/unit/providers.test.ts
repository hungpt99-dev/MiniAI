import { describe, it, expect } from 'vitest';
import { streamChat, feedSSE } from '../../src/main/ai/stream';
import { mapHttpError, toMiniAIError } from '../../src/main/ai/providers';
import { sseResponse, openAIChunks, mockFetchStatus } from '../mocks/providers.mock';

describe('SSE parser', () => {
  it('feeds data lines and keeps tail', () => {
    const seen: string[] = [];
    const tail = feedSSE('data: {"a":1}\n\ndata: {"b"', (d) => seen.push(d));
    expect(seen).toEqual(['{"a":1}']);
    expect(tail).toContain('{"b"');
  });
});

describe('streamChat', () => {
  it('accumulates OpenAI deltas and calls onToken', async () => {
    const tokens: string[] = [];
    const full = await streamChat('openai', {
      apiKey: 'k', model: 'm',
      messages: [{ id: '1', role: 'user', content: 'hi', createdAt: 0 }],
      onToken: (t) => tokens.push(t),
      fetchFn: (async () => sseResponse(openAIChunks())) as unknown as typeof fetch,
    });
    expect(full).toBe('Hello world');
    expect(tokens.join('')).toBe('Hello world');
  });
  it('maps 401 to auth error', async () => {
    await expect(streamChat('openai', {
      apiKey: 'bad', model: 'm',
      messages: [{ id: '1', role: 'user', content: 'hi', createdAt: 0 }],
      fetchFn: mockFetchStatus(401, 'invalid key'),
    })).rejects.toMatchObject({ code: 'auth' });
  });
  it('maps 429 to rate-limit', () => {
    expect(mapHttpError(429, '')).toMatchObject({ code: 'rate-limit' });
  });
  it('maps AbortError to aborted', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(toMiniAIError(e)).toMatchObject({ code: 'aborted' });
  });
});
