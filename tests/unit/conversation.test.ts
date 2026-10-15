import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { ipcMain } from 'electron';
import { IpcChannels } from '../../src/shared/ipc-channels';
import { openTestDb } from '../../src/main/db/db';
import { __resetIpcRegistryForTests, registerIpc } from '../../src/main/ipc';
import { createConversation, addMessage, getMessages } from '../../src/main/db/conversations';
import { getSettings, updateSettings } from '../../src/main/store/settings';
import { setSecret, apiKeyService } from '../../src/main/store/secrets';
import { saveMemory } from '../../src/main/memory/store';
import { buildAgentMessages, MAX_SEED_MESSAGES } from '../../src/main/agent/request';
import { isActionLike } from '../../src/shared/conversation';
import { Scheduler } from '../../src/main/tasks/scheduler';
import type { Task } from '../../src/main/tasks/taskTypes';

const handle = vi.mocked(ipcMain.handle);
type Listener = (...args: any[]) => unknown;
function listenerFor(channel: string): Listener {
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as Listener;
}

function finalTurn(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

const realFetch = globalThis.fetch;
let toolQueue: Response[] = [];
const bodies: unknown[] = [];
function resetFetch() {
  toolQueue = [];
  bodies.length = 0;
  globalThis.fetch = (async (_u: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown }).body || '{}'));
    bodies.push(body);
    if (!toolQueue.length) throw new Error('no scripted tool response left');
    return toolQueue.shift()!;
  }) as unknown as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

interface Push { ch: string; data: any }
let pushes: Push[] = [];
const sender = { send: (ch: string, data: any) => { pushes.push({ ch, data }); } };

beforeAll(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-conv-'));
  process.env.NEXIO_DATA_DIR = dataDir;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-convsandbox-'));
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = openTestDb();
  __resetIpcRegistryForTests();
  handle.mockClear();
  registerIpc();
  const db = (globalThis as unknown as { __nexioDb: Parameters<typeof updateSettings>[0] }).__nexioDb;
  updateSettings(db, {
    memoryEnabled: false, memoryOneTap: false, agentCwd: sandbox,
    model: 'gpt-4o-mini', askReadEnabled: true,
  });
  setSecret(db, apiKeyService('openai'), 'k');
});

function db() {
  return (globalThis as unknown as { __nexioDb: any }).__nexioDb;
}
function send(conv: string, text: string, opts: Record<string, unknown> = {}) {
  pushes = [];
  setSecret(db(), apiKeyService('openai'), 'k');
  return listenerFor(IpcChannels.send)({ sender }, conv, text, { explicit: true, ...opts }) as Promise<string>;
}
const toolTurns = () => bodies.filter((b: any) => !(b as any).stream);
const lastUserOf = (b: any): string => {
  const msgs = (b as any).messages as Array<{ role: string; content: unknown }>;
  const users = msgs.filter((m) => m.role === 'user');
  const last = users[users.length - 1]?.content;
  return typeof last === 'string' ? last : JSON.stringify(last);
};

describe('buildAgentMessages: one builder owns order, dedupe and cap', () => {
  it('three turns keep [u1,a1,u2,a2,u3] with the new message once and last', () => {
    const a1 = [
      { id: 'm-1', role: 'user', content: 'hello', createdAt: 1 },
      { id: 'm-2', role: 'assistant', content: 'hi', createdAt: 2 },
      { id: 'm-3', role: 'user', content: 'list full file', createdAt: 3 },
      { id: 'm-4', role: 'assistant', content: 'files', createdAt: 4 },
      { id: 'm-5', role: 'user', content: 'list full file', createdAt: 5 },
    ] as any;
    const out = buildAgentMessages(a1, 'list full file');
    expect(out.map((m) => (typeof m.content === 'string' ? m.content : '[parts]'))).toEqual([
      'hello', 'hi', 'list full file', 'files', 'list full file',
    ]);
    // the trailing stored copy is dropped, the new text appended: no doubling
    const roles = out.map((m) => m.role);
    expect(roles[roles.length - 1]).toBe('user');
    expect(roles[roles.length - 2]).not.toBe('user');
  });
  it('a repeated prompt still sends (dedupe is not a cache)', () => {
    const h = [{ id: 'm-1', role: 'user', content: 'ping', createdAt: 1 }] as any;
    const out = buildAgentMessages(h, 'ping');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'user', content: 'ping' });
  });
  it('truncation drops the oldest, keeps the newest user message', () => {
    const h: any[] = [];
    for (let i = 0; i < MAX_SEED_MESSAGES + 6; i++) {
      h.push({ id: `m-${i}a`, role: 'user', content: `q${i}`, createdAt: i });
      h.push({ id: `m-${i}b`, role: 'assistant', content: `a${i}`, createdAt: i });
    }
    h.push({ id: 'm-new', role: 'user', content: 'newest', createdAt: 999 });
    const out = buildAgentMessages(h, 'newest');
    expect(out.length).toBeLessThanOrEqual(MAX_SEED_MESSAGES + 1);
    const last = out[out.length - 1] as { content: unknown };
    expect(last.content).toBe('newest');
    expect(JSON.stringify(out)).not.toContain('"q0"');
  });
  it('attachments append rich parts instead of replacing the text', () => {
    const h = [{ id: 'm-1', role: 'user', content: 'see this', createdAt: 1 }] as any;
    const parts = [{ type: 'text', text: 'see this' }, { type: 'file_ref', name: 'n.txt' }] as any;
    const out = buildAgentMessages(h, 'see this', parts);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(parts);
  });
  it('ignores non-chat roles and keeps system-first order to the caller', () => {
    const h = [
      { id: 'm-0', role: 'system', content: 'x', createdAt: 0 },
      { id: 'm-1', role: 'user', content: 'hi', createdAt: 1 },
    ] as any;
    const out = buildAgentMessages(h, 'hi');
    expect(out.map((m) => m.role)).toEqual(['user']);
  });
});

describe('isActionLike: structural chip signal, no verb lists', () => {
  it('write-shaped file mentions qualify; greetings and questions do not', () => {
    expect(isActionLike('create notes.txt')).toBe(true);
    expect(isActionLike('move C:\\a\\b.txt')).toBe(true);
    expect(isActionLike('hello')).toBe(false);
    expect(isActionLike('list full file')).toBe(false);
    expect(isActionLike('what is this?')).toBe(false);
    expect(isActionLike('/spawn x')).toBe(false);
    expect(isActionLike('')).toBe(false);
  });
});

describe('thread contract through the real send handler (echo-shaped fake)', () => {
  it('Ask: three turns, same conversation, provider gets each new text last and once', async () => {
    const conv = createConversation(db(), 't').id;
    resetFetch();
    toolQueue.push(finalTurn('A1'), finalTurn('A2'), finalTurn('A3'));
    const outs: string[] = [];
    for (const prompt of ['hello', 'list full file', 'list full file']) {
      outs.push(await send(conv, prompt, { mode: 'chat' }));
    }
    expect(outs).toEqual(['A1', 'A2', 'A3']);
    const turns = toolTurns();
    expect(turns).toHaveLength(3);
    expect(turns.map(lastUserOf)).toEqual(['hello', 'list full file', 'list full file']);
    // same prompt twice still calls the provider twice (no response cache)
    expect(toolTurns()).toHaveLength(3);
    for (const b of turns) {
      const msgs = (b as any).messages as Array<{ role: string; content: unknown }>;
      const last = msgs[msgs.length - 1];
      const prev = msgs[msgs.length - 2];
      expect(last.role).toBe('user');
      if (prev && prev.role === 'user') {
        expect(JSON.stringify(prev.content)).not.toBe(JSON.stringify(last.content));
      }
    }
    const stored = getMessages(db(), conv);
    expect(stored).toHaveLength(6);
    expect(new Set(stored.map((m) => m.id)).size).toBe(6);
  });
  it('Do: follow-up continues the same thread with intact history', async () => {
    const conv = createConversation(db(), 't-do').id;
    resetFetch();
    toolQueue.push(finalTurn('D1'));
    await send(conv, 'hello', { mode: 'agent' });
    resetFetch();
    toolQueue.push(finalTurn('D2'));
    const out = await send(conv, 'list full file', { mode: 'agent' });
    expect(out).toBe('D2');
    const turns = toolTurns();
    expect(turns).toHaveLength(1);
    const msgs = (turns[0] as any).messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0].role).toBe('system');
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', content: 'list full file' });
    expect(getMessages(db(), conv).map((m) => m.content)).toEqual(['hello', 'D1', 'list full file', 'D2']);
  });
  it('memory and attachments append, never replace the user text', async () => {
    const d = db();
    updateSettings(d, { memoryEnabled: true });
    try {
      saveMemory(d, { kind: 'fact', text: 'user likes tea', scope: { type: 'global' }, source: 'user_approved' });
      const conv = createConversation(d, 't-mem').id;
      resetFetch();
      toolQueue.push(finalTurn('tea noted'));
      await send(conv, 'do I like tea?', { mode: 'chat' });
      const sys = JSON.stringify((toolTurns()[0] as any).messages[0]);
      expect(sys).toMatch(/user_memory/);
      expect(lastUserOf(toolTurns()[0])).toBe('do I like tea?');
      const conv2 = createConversation(d, 't-att').id;
      resetFetch();
      toolQueue.push(finalTurn('saw it'));
      await send(conv2, 'see this', {
        mode: 'chat',
        attachments: [{ name: 'n.txt', mime: 'text/plain', dataBase64: Buffer.from('hi file').toString('base64') }],
      });
      const last = ((toolTurns()[0] as any).messages as Array<{ content: unknown }>).slice(-1)[0].content;
      expect(Array.isArray(last)).toBe(true);
      expect(JSON.stringify(last)).toContain('see this');
    } finally {
      updateSettings(d, { memoryEnabled: false });
    }
  });
  it('spawn/queue create isolated tasks; subtask dedupe stays subtask-scoped', async () => {
    const conv = createConversation(db(), 't-iso').id;
    resetFetch();
    toolQueue.push(finalTurn('bg'));
    await send(conv, 'first', { mode: 'agent', taskAction: 'spawn' });
    const { Scheduler: Sch } = await import('../../src/main/tasks/scheduler');
    const sch = new Sch({
      settings: () => ({ maxParallel: 2, maxQueued: 20, allowSubtasks: true, askBeforeSubtasks: true, notifyOn: false }),
      runTask: async () => ({ status: 'done', summary: 'ok' }),
    });
    const snap = { workingFolder: '/tmp', mode: 'do', provider: 'openai', model: 'm', memorySnapshotIds: [], attachmentIds: [] } as const;
    const a = sch.create({ prompt: 'same', origin: 'user_spawn', snapshot: { ...snap } });
    const b = sch.create({ prompt: 'same', origin: 'user_spawn', snapshot: { ...snap } });
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false); // top-level repeats are new turns, never deduped
    const p = sch.create({ prompt: 'parent', origin: 'user_spawn', snapshot: { ...snap } });
    if ('error' in p) throw new Error('parent failed');
    const s1 = sch.create({ prompt: 'child', origin: 'agent_subtask', parentId: p.task.id, snapshot: { ...snap } });
    const s2 = sch.create({ prompt: 'child', origin: 'agent_subtask', parentId: p.task.id, snapshot: { ...snap } });
    expect('error' in s1).toBe(false);
    expect('error' in s2).toBe(true); // subtask dedupe applies only here
  });
});

describe('unknown stored provider ids are not configured, never substituted', () => {
  function storeUnknownProvider() {
    db().prepare("INSERT INTO settings (key, value) VALUES ('provider', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('"echo"');
  }
  function restoreProvider() {
    db().prepare("DELETE FROM settings WHERE key = 'provider'").run();
  }
  it('Ask send with provider=echo ends friendly with no provider call', async () => {
    const conv = createConversation(db(), 't-echo').id;
    storeUnknownProvider();
    try {
      resetFetch();
      const out = await send(conv, 'hello', { mode: 'chat' });
      expect(out).toMatchObject({ ok: false });
      expect(String((out as any).message)).toMatch(/No API key is set|not configured/i);
      expect(String((out as any).message)).not.toMatch(/echo/i);
      expect(bodies).toHaveLength(0); // never loaded, never substituted
      expect(getMessages(db(), conv).filter((m) => m.role === 'assistant')).toHaveLength(0);
    } finally {
      restoreProvider();
    }
  });
  it('Do send with provider=echo ends friendly with no provider call', async () => {
    const conv = createConversation(db(), 't-echo-do').id;
    storeUnknownProvider();
    try {
      resetFetch();
      const out = await send(conv, 'hello', { mode: 'agent' });
      expect(out).toMatchObject({ ok: false });
      expect(String((out as any).message)).toMatch(/No API key is set|not configured/i);
      expect(bodies).toHaveLength(0);
    } finally {
      restoreProvider();
    }
  });
  it('missing key yields the setup message with Open Settings, no answer, no spinner', async () => {
    const conv = createConversation(db(), 't-nokey').id;
    db().prepare("DELETE FROM secrets WHERE service = 'apikey:openai'").run();
    try {
      resetFetch();
      // no stored key and no helper top-up: the run must fail before any fetch
      const out = await listenerFor(IpcChannels.send)({ sender }, conv, 'hello', { explicit: true, mode: 'chat' }) as unknown;
      expect(out).toMatchObject({ ok: false, action: 'open-settings' });
      expect(String((out as any).message)).toMatch(/No API key is set/);
      expect(bodies).toHaveLength(0);
    } finally {
      setSecret(db(), apiKeyService('openai'), 'k');
    }
  });
});
