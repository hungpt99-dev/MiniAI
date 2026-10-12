import { describe, it, expect, vi } from 'vitest';
import { createOpencodeAdapter } from '../../src/main/agent/opencode';
import { createClaudeAdapter, parseJsonlDelta, type SpawnFn } from '../../src/main/agent/cli';

function sseBody(chunks: string[]) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => enc.encode(c));
  return {
    getReader() {
      let i = 0;
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (i >= queue.length) return { done: true };
          return { done: false, value: queue[i++] };
        },
      };
    },
  };
}

describe('opencode adapter (mock fetch SSE)', () => {
  it('streams deltas and stops at [DONE]', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      body: sseBody(['data: {"delta":"he"}\n', 'data: {"delta":"llo"}\n', 'data: [DONE]\n']),
    })) as unknown as typeof fetch;
    const a = createOpencodeAdapter({ baseUrl: 'http://localhost:4096', fetchFn });
    const tokens: string[] = [];
    const out = await a.run({ prompt: 'hi', requestId: 'r1', onToken: (t) => tokens.push(t) });
    expect(out).toBe('hello');
    expect(tokens.join('')).toBe('hello');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('caps report unavailable without baseUrl', async () => {
    const a = createOpencodeAdapter({ baseUrl: '' });
    expect(await a.caps()).toMatchObject({ available: false });
    await expect(a.run({ prompt: 'x', requestId: 'r', onToken: () => {} })).rejects.toThrow(/runtime-unavailable/);
  });
});

describe('cli adapter (mock spawn JSONL)', () => {
  it('parses JSONL deltas and kills on abort', async () => {
    let killed = false;
    const spawnFn: SpawnFn = (_bin, _args, _opts) => {
      async function* gen() {
        yield '{"delta":"foo"}\n{"text":"bar"}\n';
        yield 'not-json\n{"content":"!"}\n';
      }
      return { stdout: gen() as unknown as NodeJS.ReadableStream, kill: () => { killed = true; }, done: Promise.resolve(0) };
    };
    const a = createClaudeAdapter('claude', spawnFn);
    const tokens: string[] = [];
    const out = await a.run({ prompt: 'do', requestId: 'r', onToken: (t) => tokens.push(t) });
    expect(out).toBe('foobar!');
    expect(killed).toBe(false);
    expect(await a.caps()).toMatchObject({ available: true });
  });

  it('kill is invoked when signal aborts mid-stream', async () => {
    let killFn: () => void = () => {};
    const ctrl = new AbortController();
    const spawnFn: SpawnFn = () => {
      async function* gen() {
        yield '{"delta":"a"}\n';
        ctrl.abort();
        yield '{"delta":"b"}\n';
      }
      return {
        stdout: gen() as unknown as NodeJS.ReadableStream,
        kill: () => { killed = true; killFn(); },
        done: Promise.resolve(0),
      };
    };
    let killed = false;
    killFn = () => {};
    const a = createClaudeAdapter('claude', spawnFn);
    await expect(a.run({ prompt: 'x', requestId: 'r', signal: ctrl.signal, onToken: () => {} })).rejects.toThrow(/Abort/);
    expect(killed).toBe(true);
  });

  it('parseJsonlDelta supports delta/text/content/message', () => {
    expect(parseJsonlDelta('{"delta":"x"}')).toBe('x');
    expect(parseJsonlDelta('{"text":"y"}')).toBe('y');
    expect(parseJsonlDelta('{"content":"z"}')).toBe('z');
    expect(parseJsonlDelta('{"message":"w"}')).toBe('w');
    expect(parseJsonlDelta('garbage')).toBe('');
    expect(parseJsonlDelta('')).toBe('');
  });

  it('caps report unavailable without bin', async () => {
    const a = createClaudeAdapter('');
    expect(await a.caps()).toMatchObject({ available: false });
  });
});
