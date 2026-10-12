import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { IpcChannels } from '../shared/ipc-channels';
import { getSettings, updateSettings } from './store/settings';
import { setSecret, getSecret, apiKeyService, isEncryptionAvailable } from './store/secrets';
import { createConversation, listConversations, addMessage, getMessages, deleteConversation } from './db/conversations';
import { listTemplates, upsertTemplate, listWorkflows, render } from './db/templates';
import { streamChat } from './ai/stream';
import { testConnectivity } from './ai/providers';
import { buildRegistry, querySlash, resolveSlash } from './slash/registry';
import { runWorkflow } from './workflow/engine';
import { routeRequest, type RouteInput } from './agent/router';
import { setPopupHeight } from './popup';
import { createOpencodeAdapter } from './agent/opencode';
import { createClaudeAdapter, createCodexAdapter } from './agent/cli';
import type { AgentRuntimeAdapter } from './agent/adapter';
import type { ChatMessage, Mode, RuntimeId, Settings } from '../shared/types';

const aborters = new Map<string, AbortController>();
let seq = 0;

// IPC serializes non-Error rejections as "[object Object]" — normalize at the boundary
// so the real cause (e.g. `auth: ...`, `runtime-unavailable: ...`) reaches the UI.
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = e as { code?: string; message?: string };
  if (o?.code && o?.message) return new Error(`${o.code}: ${o.message}`);
  try { return new Error(`Unknown error: ${JSON.stringify(e)}`); }
  catch { return new Error(`Unknown error: ${String(e)}`); }
}

function db(): DatabaseSync {
  return (globalThis as unknown as { __miniaiDb: DatabaseSync }).__miniaiDb;
}

function buildAgents(s: Settings): Partial<Record<RuntimeId, AgentRuntimeAdapter>> {
  return {
    opencode: createOpencodeAdapter({ baseUrl: s.opencodeBaseUrl || '' }),
    claude: createClaudeAdapter(s.claudeBin || '', undefined, s.agentCwd),
    codex: createCodexAdapter(s.codexBin || '', undefined, s.agentCwd),
  };
}

export interface SendOpts {
  mode?: Mode;
  runtimeId?: RuntimeId;
  sessionId?: string;
  requestId?: string;
}

async function runSend(
  sender: Electron.WebContents,
  conversationId: string,
  content: string,
  opts: SendOpts = {},
): Promise<string> {
  const d = db();
  // Freeze mode/runtime/sessionId/requestId at send time.
  const s = getSettings(d);
  const mode: Mode = opts.mode || s.mode || 'chat';
  const runtimeId: RuntimeId = opts.runtimeId || s.agentRuntime || 'opencode';
  const sessionId = opts.sessionId || conversationId;
  const requestId = opts.requestId || `req-${Date.now()}-${++seq}`;
  addMessage(d, conversationId, 'user', content);
  const history = getMessages(d, conversationId);
  const key = getSecret(d, apiKeyService(s.provider)) || '';
  const aborter = new AbortController();
  aborters.set(requestId, aborter);
  const frozen: RouteInput = { mode, runtimeId, sessionId, requestId, prompt: content };
  try {
    const full = await routeRequest(
      { ...frozen, cwd: s.agentCwd, signal: aborter.signal, onToken: (t) => sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId, requestId }) },
      {
        chat: async (input) => {
          let acc = '';
          await streamChat(s.provider, {
            apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: s.temperature,
            messages: history, signal: input.signal,
            onToken: (t) => { acc += t; input.onToken?.(t); },
          });
          return acc;
        },
        agents: buildAgents(s),
      },
    );
    addMessage(d, conversationId, 'assistant', full);
    sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
    return full;
  } catch (e) {
    throw asError(e);
  } finally {
    aborters.delete(requestId);
  }
}

export function registerIpc(): void {
  ipcMain.handle(IpcChannels.getSettings, () => getSettings(db()));
  ipcMain.handle(IpcChannels.setSettings, (_e, patch: Partial<Settings>) => updateSettings(db(), patch));
  ipcMain.handle(IpcChannels.setApiKey, (_e, provider: string, key: string) => {
    if (!key) throw new Error('Empty API key');
    setSecret(db(), apiKeyService(provider), key);
    return true;
  });
  ipcMain.handle(IpcChannels.isEncryptionAvailable, () => isEncryptionAvailable());
  ipcMain.handle(IpcChannels.testConnectivity, async (_e, provider, model: string, baseUrl?: string) => {
    const key = getSecret(db(), apiKeyService(provider as string)) || '';
    return testConnectivity(provider, key, model, baseUrl);
  });

  ipcMain.handle(IpcChannels.listConversations, () => listConversations(db()));
  ipcMain.handle(IpcChannels.createConversation, (_e, title?: string) => createConversation(db(), title));
  ipcMain.handle(IpcChannels.getMessages, (_e, id: string) => getMessages(db(), id));
  ipcMain.handle(IpcChannels.deleteConversation, (_e, id: string) => { deleteConversation(db(), id); return true; });
  ipcMain.handle(IpcChannels.listTemplates, () => listTemplates(db()));
  ipcMain.handle(IpcChannels.upsertTemplate, (_e, t) => upsertTemplate(db(), t));
  ipcMain.handle(IpcChannels.listWorkflows, () => listWorkflows(db()));

  ipcMain.handle(IpcChannels.slashQuery, (_e, text: string, mode?: Mode) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    return querySlash(buildRegistry({ prompts: templates, workflows }), text, 8, mode);
  });
  ipcMain.handle(IpcChannels.slashResolve, (_e, trigger: string, mode?: Mode) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    return resolveSlash(buildRegistry({ prompts: templates, workflows }), trigger, mode);
  });

  ipcMain.handle(IpcChannels.runWorkflow, async (e, trigger: string, vars: Record<string, string>) => {
    const d = db();
    const w = listWorkflows(d).find((x) => x.trigger === trigger || x.id === trigger);
    if (!w) throw new Error(`Unknown workflow: ${trigger}`);
    const requestId = `wf-${Date.now()}-${++seq}`;
    const aborter = new AbortController();
    aborters.set(requestId, aborter);
    const sender = e.sender;
    try {
      const result = await runWorkflow(w, vars, {
        vars,
        getTemplateBody: (id) => {
          const t = listTemplates(d).find((x) => x.id === id || x.trigger === id);
          if (!t) return undefined;
          try { return render(t.body, { ...vars, text: vars.text || vars.input || '' }); }
          catch { return t.body; }
        },
        runPrompt: async (prompt: string, signal?: AbortSignal) => {
          const s = getSettings(d);
          const key = getSecret(d, apiKeyService(s.provider)) || '';
          let acc = '';
          await streamChat(s.provider, {
            apiKey: key, model: s.model, baseUrl: s.baseUrl,
            messages: [{ id: 'w', role: 'user', content: prompt, createdAt: 0 }],
            signal: signal || aborter.signal,
            onToken: (t) => { acc += t; sender.send(IpcChannels.chatStream, { token: t, done: false }); },
          });
          return acc;
        },
        askUser: async (p) => vars[p] || vars.text || '',
        signal: aborter.signal,
      });
      d.prepare('INSERT INTO runs (id, workflowId, status, output, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        `r-${Date.now()}`, w.id, result.status, result.outputs['__output'] || '', Date.now(),
      );
      sender.send(IpcChannels.chatStream, { token: '', done: true });
      return result;
    } catch (e) {
      throw asError(e);
    } finally {
      aborters.delete(requestId);
    }
  });

  ipcMain.on(IpcChannels.chatCancel, (_e, requestId?: string) => {
    if (requestId) aborters.get(requestId)?.abort();
    else for (const a of aborters.values()) a.abort();
  });

  ipcMain.on(IpcChannels.resize, (_e, h: unknown) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return;
    setPopupHeight(h);
  });

  // Chat: streams tokens via `chatStream` event, resolves with full text.
  ipcMain.handle(IpcChannels.chat, async (e, conversationId: string, messages: ChatMessage[], opts: SendOpts = {}) => {
    const d = db();
    const s = getSettings(d);
    const key = getSecret(d, apiKeyService(s.provider)) || process.env[`${s.provider.toUpperCase()}_API_KEY`] || '';
    const requestId = opts.requestId || `req-${Date.now()}-${++seq}`;
    const aborter = new AbortController();
    aborters.set(requestId, aborter);
    const sender = e.sender;
    try {
      let full = '';
      await streamChat(s.provider, {
        apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: s.temperature,
        messages, signal: aborter.signal,
        onToken: (t) => { full += t; sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId, requestId }); },
      });
      addMessage(d, conversationId, 'assistant', full);
      sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
      return full;
    } catch (e) {
      throw asError(e);
    } finally {
      aborters.delete(requestId);
    }
  });

  ipcMain.handle(IpcChannels.send, (e, conversationId: string, content: string, opts: SendOpts = {}) =>
    runSend(e.sender, conversationId, content, opts),
  );

  ipcMain.handle(IpcChannels.agentRun, (e, conversationId: string, content: string, opts: SendOpts = {}) =>
    runSend(e.sender, conversationId, content, { ...opts, mode: 'agent' }),
  );

  const capsOf = () => {
    const s = getSettings(db());
    return Promise.all(Object.values(buildAgents(s)).map((a) => a!.caps()));
  };
  ipcMain.handle(IpcChannels.runtimeList, () => capsOf());
  ipcMain.handle(IpcChannels.runtimeRefresh, () => capsOf());
}
