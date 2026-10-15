import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

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
import { createConversation, getMessages } from '../../src/main/db/conversations';
import { seedBuiltins } from '../../src/main/db/templates';
import { updateSettings } from '../../src/main/store/settings';
import { setSecret, apiKeyService } from '../../src/main/store/secrets';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

beforeAll(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-slashcmd-'));
  process.env.NEXIO_DATA_DIR = dataDir;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-slashsandbox-'));
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = openTestDb();
  __resetIpcRegistryForTests();
  handle.mockClear();
  registerIpc();
  const db = (globalThis as unknown as { __nexioDb: Parameters<typeof updateSettings>[0] }).__nexioDb;
  updateSettings(db, { memoryEnabled: false, memoryOneTap: false, agentCwd: sandbox, model: 'gpt-4o-mini' });
  setSecret(db, apiKeyService('openai'), 'k');
  seedBuiltins(db);
});

function db() {
  return (globalThis as unknown as { __nexioDb: any }).__nexioDb;
}
let pushes: Array<{ ch: string; data: any }> = [];
const sender = { send: (ch: string, data: any) => { pushes.push({ ch, data }); } };
const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');

describe('prompt commands wrap before send (no language-specific parsing)', () => {
  it('resolve ships the template body; the sent text carries template + user text', async () => {
    const r = await listenerFor(IpcChannels.slashResolve)({ sender }, '/translate', 'chat') as {
      found?: { trigger: string; body?: string; vars?: string[] };
    };
    expect(r.found?.trigger).toBe('/translate');
    expect(r.found?.vars).toEqual(['text']);
    expect(r.found?.body).toMatch(/Translate the following text/);
    // renderer renders {text} then sends: emulate with the main render()
    const { render } = await import('../../src/main/db/templates');
    const rendered = render(r.found!.body!, { text: 'vi: xin chào' });
    expect(rendered).toContain('vi: xin chào');
    expect(rendered).toMatch(/target language/);
    const conv = createConversation(db(), 't-tr').id;
    resetFetch();
    toolQueue.push(finalTurn('TRANSLATED'));
    const out = await listenerFor(IpcChannels.send)({ sender }, conv, rendered, {
      explicit: true, mode: 'chat',
    }) as string;
    expect(out).toBe('TRANSLATED');
    const sent = (bodies.filter((b: any) => !(b as any).stream)[0] as any).messages as Array<{ role: string; content: unknown }>;
    const last = sent[sent.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('vi: xin chào');
    expect(String(last.content)).toMatch(/target language/);
    expect(getMessages(db(), conv).map((m) => m.content).join('\n')).toContain('vi: xin chào');
  });
  it('renderer: template branch renders, chips the trigger, sends the rendered text', () => {
    const src = appJs();
    expect(src).toContain('function renderTemplate(body, vars)');
    expect(src).toContain('r.found.body');
    expect(src).toContain("slash.usageTemplate");
    expect(src).toContain("className = 'slash-chip'");
    // the rendered prompt (never the raw "/cmd ...") goes over send()
    expect(src).toContain('window.nexio.send(id, rendered, sendOpts)');
  });
  it('other builtins wrap the same way (summarize/rewrite/explain)', async () => {
    for (const [trigger, body] of [['/summarize', 'long text here'], ['/rewrite', 'fix this'], ['/explain', 'quarks']]) {
      const r = await listenerFor(IpcChannels.slashResolve)({ sender }, trigger, 'agent') as {
        found?: { body?: string; vars?: string[] };
      };
      expect(r.found?.vars).toEqual(['text']);
      const { render } = await import('../../src/main/db/templates');
      const rendered = render(r.found!.body!, { text: body as string });
      expect(rendered).toContain(body as string);
      const conv = createConversation(db(), `t-${trigger}`).id;
      resetFetch();
      toolQueue.push(finalTurn('DONE'));
      const out = await listenerFor(IpcChannels.send)({ sender }, conv, rendered, { explicit: true, mode: 'chat' }) as string;
      expect(out).toBe('DONE');
    }
  });
});
