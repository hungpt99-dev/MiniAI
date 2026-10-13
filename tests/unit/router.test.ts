import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeRequest, type RouteInput } from '../../src/main/agent/router';
import { runAgent } from '../../src/main/agent/loop';

const SRC_MAIN = path.join(__dirname, '..', '..', 'src', 'main');

describe('builtin router', () => {
  it('routes chat mode to chat fn', async () => {
    const chat = vi.fn(async () => 'chat-out');
    const out = await routeRequest(
      { mode: 'chat', sessionId: 's', requestId: 'r', prompt: 'hi' },
      { chat },
    );
    expect(out).toBe('chat-out');
    expect(chat).toHaveBeenCalledOnce();
  });

  it('isolates session/prompt from late UI switch', async () => {
    const seen: { prompt?: string; requestId?: string; sessionId?: string } = {};
    const chat = vi.fn(async (input: RouteInput) => {
      await new Promise((r) => setTimeout(r, 10));
      seen.prompt = input.prompt;
      seen.requestId = input.requestId;
      seen.sessionId = input.sessionId;
      return 'chat-out';
    });
    const input: RouteInput = { mode: 'chat', sessionId: 'sess-1', requestId: 'req-1', prompt: 'original' };
    const p = routeRequest(input, { chat });
    input.mode = 'agent';
    input.prompt = 'mutated';
    input.requestId = 'req-2';
    input.sessionId = 'sess-2';
    await p;
    expect(seen.prompt).toBe('original');
    expect(seen.requestId).toBe('req-1');
    expect(seen.sessionId).toBe('sess-1');
  });

  it('sends Do mode to the built-in loop, never an external runtime', async () => {
    await expect(routeRequest(
      { mode: 'agent', sessionId: 's', requestId: 'r', prompt: 'hi' },
      { chat: async () => 'x' },
    )).rejects.toThrow(/agent-direct/);
  });
});

describe('no external agent runtime', () => {
  it('adapter modules are gone and the Do path names no agent binary', () => {
    for (const f of ['adapter.ts', 'opencode.ts', 'cli.ts']) {
      expect(fs.existsSync(path.join(SRC_MAIN, 'agent', f))).toBe(false);
    }
    const hits: string[] = [];
    for (const f of ['ipc.ts', path.join('agent', 'router.ts'), path.join('agent', 'loop.ts')]) {
      const src = fs.readFileSync(path.join(SRC_MAIN, f), 'utf8');
      for (const m of ['claudeBin', 'codexBin', 'opencodeBaseUrl', 'agentRuntime', 'child_process']) {
        if (src.includes(m)) hits.push(`${f}:${m}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('Do mode completes with no binary config (stub provider, no tools spawned)', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'done-by-builtin' } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const events: string[] = [];
    const out = await runAgent('do the thing', {
      provider: 'openai',
      apiKey: 'test',
      model: 'test-model',
      cwd: process.cwd(),
      history: [],
      tools: [],
      fetchFn,
      logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-router-')),
      signal: new AbortController().signal,
      emit: (e) => { events.push(e.type); },
      waitForApproval: async () => ({ decision: 'deny' }),
    });
    expect(out).toBe('done-by-builtin');
    expect(events).toContain('done');
  });
});
