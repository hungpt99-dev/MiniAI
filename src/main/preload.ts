import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Mode, Settings, ExtAction } from '../shared/types';
import type { AgentEvent, ApprovalDecision } from './agent/types';

export interface SendOpts {
  mode?: Mode;
  sessionId?: string;
  requestId?: string;
  /** True when the user explicitly picked the mode pill (wins over intent routing). */
  explicit?: boolean;
}

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IpcChannels.getSettings),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IpcChannels.setSettings, patch),
  setApiKey: (provider: string, key: string) => ipcRenderer.invoke(IpcChannels.setApiKey, provider, key),
  isEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.isEncryptionAvailable),
  testConnectivity: (provider: string, model: string, baseUrl?: string, apiKey?: string) =>
    ipcRenderer.invoke(IpcChannels.testConnectivity, provider, model, baseUrl, apiKey),
  listModels: (provider: string, baseUrl?: string) =>
    ipcRenderer.invoke(IpcChannels.listModels, provider, baseUrl),
  resetProviderFixes: () => ipcRenderer.invoke(IpcChannels.resetProviderFixes),
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
  cancel: (requestId?: string) => ipcRenderer.send(IpcChannels.chatCancel, requestId),
  resize: (contentHeight: number) => ipcRenderer.send(IpcChannels.resize, contentHeight),
  agentStart: (conversationId: string, content: string, opts?: { cwd?: string }) =>
    ipcRenderer.invoke(IpcChannels.agentStart, conversationId, content, opts || {}) as Promise<{ runId: string }>,
  agentApprove: (runId: string, callId: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke(IpcChannels.agentApprove, runId, callId, decision),
  agentStop: (runId?: string) => ipcRenderer.send(IpcChannels.agentStop, runId),
  agentLog: () => ipcRenderer.invoke(IpcChannels.agentLog) as Promise<{ path: string; content: string } | null>,
  agentPickFolder: () => ipcRenderer.invoke(IpcChannels.agentPickFolder) as Promise<string | null>,
  defaultFolders: () => ipcRenderer.invoke(IpcChannels.defaultFolders) as Promise<string[]>,
  onAgentEvent: (cb: (ev: { runId: string; event: AgentEvent }) => void) => {
    const fn = (_e: unknown, data: { runId: string; event: AgentEvent }) => cb(data);
    ipcRenderer.on(IpcChannels.agentEvent, fn);
    return () => ipcRenderer.removeListener(IpcChannels.agentEvent, fn);
  },
  ext: (a: ExtAction) => ipcRenderer.invoke(IpcChannels.ext, a),
  getPlatform: () => ipcRenderer.invoke(IpcChannels.platform),
  getHotkeyStatus: () => ipcRenderer.invoke(IpcChannels.hotkeyStatus),
  setHotkey: (hotkey: string) => ipcRenderer.invoke(IpcChannels.setHotkey, hotkey),
  openPrivacySettings: () => ipcRenderer.invoke(IpcChannels.openPrivacySettings) as Promise<boolean>,
  onUi: (cb: (ev: { open: 'settings' | 'log' }) => void) => {
    const fn = (_e: unknown, data: { open: 'settings' | 'log' }) => cb(data);
    ipcRenderer.on(IpcChannels.ui, fn);
    return () => ipcRenderer.removeListener(IpcChannels.ui, fn);
  },
  undo: (runId: string) => ipcRenderer.invoke(IpcChannels.undo, runId) as Promise<{ runId: string }>,
  reveal: (dir: string) => ipcRenderer.invoke(IpcChannels.reveal, dir) as Promise<boolean>,
  runs: () => ipcRenderer.invoke(IpcChannels.runs),
  onRouteStatus: (cb: (ev: { id: string; status: 'doing' | 'answering' }) => void) => {
    const fn = (_e: unknown, data: { id: string; status: 'doing' | 'answering' }) => cb(data);
    ipcRenderer.on(IpcChannels.routeStatus, fn);
    return () => ipcRenderer.removeListener(IpcChannels.routeStatus, fn);
  },
  onRunSummary: (cb: (ev: { runId: string; undoable: boolean; folder?: string }) => void) => {
    const fn = (_e: unknown, data: { runId: string; undoable: boolean; folder?: string }) => cb(data);
    ipcRenderer.on(IpcChannels.runSummary, fn);
    return () => ipcRenderer.removeListener(IpcChannels.runSummary, fn);
  },
  onPopupShown: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on(IpcChannels.popupShown, fn);
    return () => ipcRenderer.removeListener(IpcChannels.popupShown, fn);
  },
  onStream: (cb: (ev: { token: string; done: boolean; conversationId?: string; requestId?: string }) => void) => {
    const fn = (_e: unknown, data: { token: string; done: boolean; conversationId?: string; requestId?: string }) => cb(data);
    ipcRenderer.on(IpcChannels.chatStream, fn);
    return () => ipcRenderer.removeListener(IpcChannels.chatStream, fn);
  },
};

contextBridge.exposeInMainWorld('nexio', api);
export type NexioApi = typeof api;
