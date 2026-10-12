import { describe, it, expect, vi } from 'vitest';
import { routeRequest, type RouteInput } from '../../src/main/agent/router';
import type { AgentRuntimeAdapter } from '../../src/main/agent/adapter';

function agentStub(id: 'opencode', seen: { prompt?: string; requestId?: string; sessionId?: string }, delay = 0): AgentRuntimeAdapter {
  return {
    id,
    caps: () => ({ id, label: id, available: true }),
    run: async (req) => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      seen.prompt = req.prompt;
      seen.requestId = req.requestId;
      seen.sessionId = req.sessionId;
      req.onToken('tok');
      return 'tok';
    },
  };
}

describe('agent router', () => {
  it('throws unknown-runtime and never falls back to chat', async () => {
    const chat = vi.fn(async () => 'chat-out');
    const input: RouteInput = { mode: 'agent', runtimeId: 'nope' as never, sessionId: 's', requestId: 'r1', prompt: 'hi' };
    await expect(routeRequest(input, { chat, agents: {} })).rejects.toThrow(/unknown-runtime/);
    expect(chat).not.toHaveBeenCalled();
  });

  it('throws when caps report unavailable (no fallback)', async () => {
    const chat = vi.fn(async () => 'chat-out');
    const down: AgentRuntimeAdapter = {
      id: 'opencode',
      caps: () => ({ id: 'opencode', label: 'OpenCode', available: false, reason: 'no url' }),
      run: async () => 'x',
    };
    const input: RouteInput = { mode: 'agent', runtimeId: 'opencode', sessionId: 's', requestId: 'r1', prompt: 'hi' };
    await expect(routeRequest(input, { chat, agents: { opencode: down } })).rejects.toThrow(/runtime-unavailable/);
    expect(chat).not.toHaveBeenCalled();
  });

  it('isolates requestId/session/prompt from late UI switch', async () => {
    const seen: { prompt?: string; requestId?: string; sessionId?: string } = {};
    const chat = vi.fn(async () => 'chat-out');
    const input: RouteInput = { mode: 'agent', runtimeId: 'opencode', sessionId: 'sess-1', requestId: 'req-1', prompt: 'original' };
    const p = routeRequest(input, { chat, agents: { opencode: agentStub('opencode', seen, 10) } });
    // Late switch: user flips tab/runtime and edits input while request in flight.
    input.mode = 'chat';
    input.runtimeId = 'claude';
    input.prompt = 'mutated';
    input.requestId = 'req-2';
    input.sessionId = 'sess-2';
    await p;
    expect(seen.prompt).toBe('original');
    expect(seen.requestId).toBe('req-1');
    expect(seen.sessionId).toBe('sess-1');
    expect(chat).not.toHaveBeenCalled();
  });

  it('routes chat mode to chat fn', async () => {
    const chat = vi.fn(async () => 'chat-out');
    const out = await routeRequest(
      { mode: 'chat', runtimeId: 'opencode', sessionId: 's', requestId: 'r', prompt: 'hi' },
      { chat, agents: {} },
    );
    expect(out).toBe('chat-out');
    expect(chat).toHaveBeenCalledOnce();
  });
});
