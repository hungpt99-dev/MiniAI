import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Settings } from '../shared/types';

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IpcChannels.getSettings),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IpcChannels.setSettings, patch),
  setApiKey: (provider: string, key: string) => ipcRenderer.invoke(IpcChannels.setApiKey, provider, key),
  testConnectivity: (provider: string, model: string, baseUrl?: string) =>
    ipcRenderer.invoke(IpcChannels.testConnectivity, provider, model, baseUrl),
  listConversations: () => ipcRenderer.invoke(IpcChannels.listConversations),
  createConversation: (title?: string) => ipcRenderer.invoke(IpcChannels.createConversation, title),
  getMessages: (id: string) => ipcRenderer.invoke(IpcChannels.getMessages, id),
  deleteConversation: (id: string) => ipcRenderer.invoke(IpcChannels.deleteConversation, id),
  listTemplates: () => ipcRenderer.invoke(IpcChannels.listTemplates),
  listWorkflows: () => ipcRenderer.invoke(IpcChannels.listWorkflows),
  slashQuery: (text: string) => ipcRenderer.invoke(IpcChannels.slashQuery, text),
  slashResolve: (trigger: string) => ipcRenderer.invoke(IpcChannels.slashResolve, trigger),
  runWorkflow: (trigger: string, vars: Record<string, string>) =>
    ipcRenderer.invoke(IpcChannels.runWorkflow, trigger, vars),
  send: (conversationId: string, content: string) => ipcRenderer.invoke('miniai:send', conversationId, content),
  cancel: () => ipcRenderer.send(IpcChannels.chatCancel),
  onStream: (cb: (ev: { token: string; done: boolean; conversationId?: string }) => void) => {
    const fn = (_e: unknown, data: { token: string; done: boolean; conversationId?: string }) => cb(data);
    ipcRenderer.on(IpcChannels.chatStream, fn);
    return () => ipcRenderer.removeListener(IpcChannels.chatStream, fn);
  },
};

contextBridge.exposeInMainWorld('miniAI', api);
export type MiniAIApi = typeof api;
