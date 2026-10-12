import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Mode, RuntimeId, Settings } from '../shared/types';

export interface SendOpts {
  mode?: Mode;
  runtimeId?: RuntimeId;
  sessionId?: string;
  requestId?: string;
}

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IpcChannels.getSettings),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IpcChannels.setSettings, patch),
  setApiKey: (provider: string, key: string) => ipcRenderer.invoke(IpcChannels.setApiKey, provider, key),
  isEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.isEncryptionAvailable),
  testConnectivity: (provider: string, model: string, baseUrl?: string) =>
    ipcRenderer.invoke(IpcChannels.testConnectivity, provider, model, baseUrl),
  listConversations: () => ipcRenderer.invoke(IpcChannels.listConversations),
  createConversation: (title?: string) => ipcRenderer.invoke(IpcChannels.createConversation, title),
  getMessages: (id: string) => ipcRenderer.invoke(IpcChannels.getMessages, id),
  deleteConversation: (id: string) => ipcRenderer.invoke(IpcChannels.deleteConversation, id),
  listTemplates: () => ipcRenderer.invoke(IpcChannels.listTemplates),
  listWorkflows: () => ipcRenderer.invoke(IpcChannels.listWorkflows),
  slashQuery: (text: string, mode?: Mode) => ipcRenderer.invoke(IpcChannels.slashQuery, text, mode),
  slashResolve: (trigger: string, mode?: Mode) => ipcRenderer.invoke(IpcChannels.slashResolve, trigger, mode),
  runWorkflow: (trigger: string, vars: Record<string, string>) =>
    ipcRenderer.invoke(IpcChannels.runWorkflow, trigger, vars),
  send: (conversationId: string, content: string, opts?: SendOpts) =>
    ipcRenderer.invoke(IpcChannels.send, conversationId, content, opts || {}),
  agentRun: (conversationId: string, content: string, opts?: SendOpts) =>
    ipcRenderer.invoke(IpcChannels.agentRun, conversationId, content, opts || {}),
  runtimeList: () => ipcRenderer.invoke(IpcChannels.runtimeList),
  runtimeRefresh: () => ipcRenderer.invoke(IpcChannels.runtimeRefresh),
  cancel: (requestId?: string) => ipcRenderer.send(IpcChannels.chatCancel, requestId),
  onStream: (cb: (ev: { token: string; done: boolean; conversationId?: string; requestId?: string }) => void) => {
    const fn = (_e: unknown, data: { token: string; done: boolean; conversationId?: string; requestId?: string }) => cb(data);
    ipcRenderer.on(IpcChannels.chatStream, fn);
    return () => ipcRenderer.removeListener(IpcChannels.chatStream, fn);
  },
};

contextBridge.exposeInMainWorld('miniAI', api);
export type MiniAIApi = typeof api;
