import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { MemoryAction, MemoryPush, Mode, Settings, ExtAction } from '../shared/types';
import type { AgentEvent, ApprovalDecision } from './agent/types';

export interface SendOpts {
  mode?: Mode;
  sessionId?: string;
  requestId?: string;
  /** True when the user explicitly picked the mode pill (wins over intent routing). */
  explicit?: boolean;
  attachments?: Array<{ name: string; mime?: string; size?: number; dataBase64?: string; path?: string }>;
}

// why: raw chat + upsertTemplate stay main-only — the renderer sends via
// send() (intent routing + attachments) and never edits templates, so they
// get no bridge surface; their handlers remain for the startup assert.
function isIpcError(v: unknown): v is { ok: false; code: string; message: string } {
  return (
    !!v && typeof v === 'object' &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { code?: unknown }).code === 'string' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

/** Named-channel invoke only (no string literals): unwraps main envelopes,
 * maps a missing main handler to IPC_NOT_AVAILABLE. */
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  let raw: unknown;
  try {
    raw = await ipcRenderer.invoke(channel, ...args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no handler/i.test(msg)) {
      throw Object.assign(new Error(`IPC not available: ${channel}`), { code: 'IPC_NOT_AVAILABLE' });
    }
    throw e;
  }
  if (isIpcError(raw)) throw Object.assign(new Error(raw.message), { code: raw.code });
  return raw;
}

const api = {
  getSettings: (): Promise<Settings> => invoke(IpcChannels.getSettings),
  setSettings: (patch: Partial<Settings>) => invoke(IpcChannels.setSettings, patch),
  setApiKey: (provider: string, key: string) => invoke(IpcChannels.setApiKey, provider, key),
  isEncryptionAvailable: (): Promise<boolean> => invoke(IpcChannels.isEncryptionAvailable),
  testConnectivity: (provider: string, model: string, baseUrl?: string, apiKey?: string) =>
    invoke(IpcChannels.testConnectivity, provider, model, baseUrl, apiKey),
  listModels: (provider: string, baseUrl?: string) =>
    invoke(IpcChannels.listModels, provider, baseUrl),
  resetProviderFixes: () => invoke(IpcChannels.resetProviderFixes),
  listConversations: () => invoke(IpcChannels.listConversations),
  createConversation: (title?: string) => invoke(IpcChannels.createConversation, title),
  getMessages: (id: string) => invoke(IpcChannels.getMessages, id),
  deleteConversation: (id: string) => invoke(IpcChannels.deleteConversation, id),
  listTemplates: () => invoke(IpcChannels.listTemplates),
  listWorkflows: () => invoke(IpcChannels.listWorkflows),
  slashQuery: (text: string, mode?: Mode) => invoke(IpcChannels.slashQuery, text, mode),
  slashResolve: (trigger: string, mode?: Mode) => invoke(IpcChannels.slashResolve, trigger, mode),
  runWorkflow: (trigger: string, vars: Record<string, string>) =>
    invoke(IpcChannels.runWorkflow, trigger, vars),
  send: (conversationId: string, content: string, opts?: SendOpts) =>
    invoke(IpcChannels.send, conversationId, content, opts || {}),
  agentRun: (conversationId: string, content: string, opts?: SendOpts) =>
    invoke(IpcChannels.agentRun, conversationId, content, opts || {}),
  cancel: (requestId?: string) => ipcRenderer.send(IpcChannels.chatCancel, requestId),
  resize: (contentHeight: number) => ipcRenderer.send(IpcChannels.resize, contentHeight),
  agentStart: (conversationId: string, content: string, opts?: { cwd?: string; attachments?: Array<{ name: string; mime?: string; size?: number; dataBase64?: string; path?: string }> }) =>
    invoke(IpcChannels.agentStart, conversationId, content, opts || {}) as Promise<{ runId: string }>,
  agentApprove: (runId: string, callId: string, decision: ApprovalDecision) =>
    invoke(IpcChannels.agentApprove, runId, callId, decision),
  agentStop: (runId?: string) => ipcRenderer.send(IpcChannels.agentStop, runId),
  agentLog: () => invoke(IpcChannels.agentLog) as Promise<{ path: string; content: string } | null>,
  agentPickFolder: () => invoke(IpcChannels.agentPickFolder) as Promise<string | null>,
  defaultFolders: () => invoke(IpcChannels.defaultFolders) as Promise<string[]>,
  onAgentEvent: (cb: (ev: { runId: string; event: AgentEvent }) => void) => {
    const fn = (_e: unknown, data: { runId: string; event: AgentEvent }) => cb(data);
    ipcRenderer.on(IpcChannels.agentEvent, fn);
    return () => ipcRenderer.removeListener(IpcChannels.agentEvent, fn);
  },
  ext: (a: ExtAction) => invoke(IpcChannels.ext, a),
  memory: (a: MemoryAction) => invoke(IpcChannels.memory, a),
  getLocale: () => invoke(IpcChannels.locale),
  onMemoryEvent: (cb: (ev: { runId?: string; requestId?: string; conversationId?: string; event: MemoryPush }) => void) => {
    const fn = (_e: unknown, data: { runId?: string; requestId?: string; conversationId?: string; event: MemoryPush }) => cb(data);
    ipcRenderer.on(IpcChannels.memoryEvent, fn);
    return () => ipcRenderer.removeListener(IpcChannels.memoryEvent, fn);
  },
  getPlatform: () => invoke(IpcChannels.platform),
  getHotkeyStatus: () => invoke(IpcChannels.hotkeyStatus),
  setHotkey: (hotkey: string) => invoke(IpcChannels.setHotkey, hotkey),
  openPrivacySettings: () => invoke(IpcChannels.openPrivacySettings) as Promise<boolean>,
  onUi: (cb: (ev: { open: 'settings' | 'log' }) => void) => {
    const fn = (_e: unknown, data: { open: 'settings' | 'log' }) => cb(data);
    ipcRenderer.on(IpcChannels.ui, fn);
    return () => ipcRenderer.removeListener(IpcChannels.ui, fn);
  },
  undo: (runId: string) => invoke(IpcChannels.undo, runId) as Promise<{ runId: string }>,
  attachPick: () => invoke(IpcChannels.attachPick) as Promise<Array<{ path: string; name: string; size: number; mime: string; previewDataUrl?: string; verdict: string; reason?: string }>>,
  attachProcess: (input: { runId: string; name: string; dataBase64: string }) =>
    invoke(IpcChannels.attachProcess, input) as Promise<{ id: string; name: string; mime: string; size: number; kind: string; width?: number; height?: number; previewDataUrl?: string; sha256: string; error?: string }>,
  attachClassify: (input: { path: string }) =>
    invoke(IpcChannels.attachClassify, input) as Promise<{ verdict: string; reason?: string }>,
  attachClear: (runId: string) => invoke(IpcChannels.attachClear, runId) as Promise<boolean>,
  reveal: (dir: string) => invoke(IpcChannels.reveal, dir) as Promise<boolean>,
  runs: () => invoke(IpcChannels.runs),
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
