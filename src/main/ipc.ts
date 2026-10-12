import { ipcMain, BrowserWindow } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { IpcChannels } from '../shared/ipc-channels';
import { getSettings, updateSettings } from './store/settings';
import { setSecret, getSecret, apiKeyService } from './store/secrets';
import { createConversation, listConversations, addMessage, getMessages, deleteConversation } from './db/conversations';
import { listTemplates, upsertTemplate, listWorkflows, render } from './db/templates';
import { streamChat } from './ai/stream';
import { testConnectivity } from './ai/providers';
import { buildRegistry, querySlash, resolveSlash } from './slash/registry';
import { runWorkflow } from './workflow/engine';
import type { ChatMessage, Settings } from '../shared/types';

let aborter: AbortController | null = null;

function db(): DatabaseSync {
  return (globalThis as unknown as { __miniaiDb: DatabaseSync }).__miniaiDb;
}

export function registerIpc(): void {
  ipcMain.handle(IpcChannels.getSettings, () => getSettings(db()));
  ipcMain.handle(IpcChannels.setSettings, (_e, patch: Partial<Settings>) => updateSettings(db(), patch));
  ipcMain.handle(IpcChannels.setApiKey, (_e, provider: string, key: string) => {
    if (!key) throw new Error('Empty API key');
    setSecret(db(), apiKeyService(provider), key);
    return true;
  });
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

  ipcMain.handle(IpcChannels.slashQuery, (_e, text: string) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    return querySlash(buildRegistry({ prompts: templates, workflows }), text);
  });
  ipcMain.handle(IpcChannels.slashResolve, (_e, trigger: string) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    return resolveSlash(buildRegistry({ prompts: templates, workflows }), trigger);
  });

  ipcMain.handle(IpcChannels.runWorkflow, async (e, trigger: string, vars: Record<string, string>) => {
    const d = db();
    const w = listWorkflows(d).find((x) => x.trigger === trigger || x.id === trigger);
    if (!w) throw new Error(`Unknown workflow: ${trigger}`);
    aborter = new AbortController();
    const sender = e.sender;
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
          signal: signal || aborter?.signal,
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
  });

  ipcMain.on(IpcChannels.chatCancel, () => aborter?.abort());

  // Chat: streams tokens via `chatStream` event, resolves with full text.
  ipcMain.handle('miniai:chat', async (e, conversationId: string, messages: ChatMessage[]) => {
    const d = db();
    const s = getSettings(d);
    const key = getSecret(d, apiKeyService(s.provider)) || process.env[`${s.provider.toUpperCase()}_API_KEY`] || '';
    aborter = new AbortController();
    const sender = e.sender;
    let full = '';
    await streamChat(s.provider, {
      apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: s.temperature,
      messages, signal: aborter.signal,
      onToken: (t) => { full += t; sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId }); },
    });
    addMessage(d, conversationId, 'assistant', full);
    sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId });
    return full;
  });

  ipcMain.handle('miniai:send', async (e, conversationId: string, content: string) => {
    const d = db();
    addMessage(d, conversationId, 'user', content);
    const history = getMessages(d, conversationId);
    const win = BrowserWindow.fromWebContents(e.sender);
    void win;
    // Delegate to chat handler logic via direct call
    const s = getSettings(d);
    const key = getSecret(d, apiKeyService(s.provider)) || '';
    aborter = new AbortController();
    let full = '';
    await streamChat(s.provider, {
      apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: s.temperature,
      messages: history, signal: aborter.signal,
      onToken: (t) => { full += t; e.sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId }); },
    });
    addMessage(d, conversationId, 'assistant', full);
    e.sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId });
    return full;
  });
}
