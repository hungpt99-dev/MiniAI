import type {
  ChatMessage,
  Conversation,
  ExtAction,
  MemoryAction,
  MemoryPush,
  Mode,
  PromptTemplate,
  Settings,
  SlashMatch,
  SlashScope,
  Workflow,
} from './types';
export const IpcChannels = {
  chatStream: 'nexio:chat-stream',
  chatCancel: 'nexio:chat-cancel',
  chat: 'nexio:chat',
  send: 'nexio:send',
  agentRun: 'nexio:agent-run',
  getSettings: 'nexio:get-settings',
  setSettings: 'nexio:set-settings',
  setApiKey: 'nexio:set-api-key',
  isEncryptionAvailable: 'nexio:is-encryption-available',
  testConnectivity: 'nexio:test-connectivity',
  listModels: 'nexio:list-models',
  resetProviderFixes: 'nexio:reset-provider-fixes',
  listConversations: 'nexio:list-conversations',
  getMessages: 'nexio:get-messages',
  createConversation: 'nexio:create-conversation',
  deleteConversation: 'nexio:delete-conversation',
  listTemplates: 'nexio:list-templates',
  upsertTemplate: 'nexio:upsert-template',
  listWorkflows: 'nexio:list-workflows',
  runWorkflow: 'nexio:run-workflow',
  slashQuery: 'nexio:slash-query',
  slashResolve: 'nexio:slash-resolve',
  resize: 'nexio:resize',
  agentStart: 'nexio:agent-start',
  agentEvent: 'nexio:agent-event',
  agentApprove: 'nexio:agent-approve',
  agentStop: 'nexio:agent-stop',
  agentLog: 'nexio:agent-log',
  agentPickFolder: 'nexio:agent-pick-folder',
  defaultFolders: 'nexio:default-folders',
  ext: 'nexio:ext',
  platform: 'nexio:platform',
  hotkeyStatus: 'nexio:hotkey-status',
  setHotkey: 'nexio:set-hotkey',
  openPrivacySettings: 'nexio:open-privacy-settings',
  ui: 'nexio:ui',
  routeStatus: 'nexio:route-status',
  runSummary: 'nexio:run-summary',
  popupShown: 'nexio:popup-shown',
  undo: 'nexio:undo',
  reveal: 'nexio:reveal',
  runs: 'nexio:runs',
  memory: 'nexio:memory',
  memoryEvent: 'nexio:memory-event',
  locale: 'nexio:locale',
  attachPick: 'nexio:attach-pick',
  attachProcess: 'nexio:attach-process',
  attachClassify: 'nexio:attach-classify',
  attachClear: 'nexio:attach-clear',
} as const;
/** Channel keys; the wire string is IpcChannels[key]. */
export type IpcChannelKey = keyof typeof IpcChannels;
/** Derived from keys (was the value union). */
export type IpcChannel = IpcChannelKey;
/** Wire-string union, for ipcMain/ipcRenderer call sites. */
export type IpcChannelValue = (typeof IpcChannels)[IpcChannelKey];

/** Fire-and-forget renderer→main (ipcMain.on). Everything else invoke is request/response. */
export const IpcSendKeys = ['chatCancel', 'resize', 'agentStop'] as const satisfies readonly IpcChannelKey[];
/** Main→renderer pushes (sender.send); never handle/on registered. */
export const IpcPushKeys = ['chatStream', 'agentEvent', 'ui', 'routeStatus', 'runSummary', 'popupShown', 'memoryEvent'] as const satisfies readonly IpcChannelKey[];
export const IpcSendChannels = IpcSendKeys.map((k) => IpcChannels[k]);
export const IpcPushChannels = IpcPushKeys.map((k) => IpcChannels[k]);
const sendPush = new Set<string>([...IpcSendKeys, ...IpcPushKeys]);
export const IpcInvokeKeys = (Object.keys(IpcChannels) as IpcChannelKey[]).filter((k) => !sendPush.has(k));
export const IpcInvokeChannels = IpcInvokeKeys.map((k) => IpcChannels[k]);

/** IPC failure envelope: typedHandle returns it, preload rethrows it. */
export interface IpcErrorEnvelope {
  ok: false;
  code: string;
  message: string;
}

export interface StagedAttachment {
  name: string;
  mime?: string;
  size?: number;
  dataBase64?: string;
  path?: string;
}

export interface SendOptions {
  mode?: Mode;
  sessionId?: string;
  requestId?: string;
  explicit?: boolean;
  attachments?: StagedAttachment[];
}

export interface SlashEntryLike extends SlashMatch {
  scope?: SlashScope;
}

/** Per-channel invoke args + result. Send/push entries carry args with result void. */
export interface IpcChannelMap {
  chatStream: { args: [{ token: string; done: boolean; conversationId?: string; requestId?: string }]; result: void };
  chatCancel: { args: [requestId?: string]; result: void };
  chat: { args: [conversationId: string, messages: ChatMessage[], opts?: SendOptions]; result: string };
  send: { args: [conversationId: string, content: string, opts?: SendOptions]; result: string };
  agentRun: { args: [conversationId: string, content: string, opts?: SendOptions]; result: string };
  getSettings: { args: []; result: Settings };
  setSettings: { args: [patch: Partial<Settings>]; result: Settings };
  setApiKey: { args: [provider: string, key: string]; result: boolean };
  isEncryptionAvailable: { args: []; result: boolean };
  testConnectivity: { args: [provider: string, model: string, baseUrl?: string, apiKey?: string]; result: { ok: boolean; error?: unknown; details?: unknown } };
  listModels: { args: [provider: string, baseUrl?: string]; result: string[] };
  resetProviderFixes: { args: []; result: boolean };
  listConversations: { args: []; result: Conversation[] };
  getMessages: { args: [id: string]; result: ChatMessage[] };
  createConversation: { args: [title?: string]; result: Conversation };
  deleteConversation: { args: [id: string]; result: boolean };
  listTemplates: { args: []; result: PromptTemplate[] };
  upsertTemplate: { args: [t: { id?: string; trigger: string; title: string; body: string }]; result: PromptTemplate };
  listWorkflows: { args: []; result: Workflow[] };
  runWorkflow: { args: [trigger: string, vars: Record<string, string>]; result: { status: string; outputs: Record<string, string> } };
  slashQuery: { args: [text: string, mode?: Mode]; result: SlashEntryLike[] };
  slashResolve: { args: [trigger: string, mode?: Mode]; result: { found?: SlashEntryLike; suggestions: SlashEntryLike[] } };
  resize: { args: [h: number]; result: void };
  agentStart: { args: [conversationId: string, content: string, opts?: { cwd?: string; attachments?: StagedAttachment[] }]; result: { runId: string } };
  agentEvent: { args: [{ runId: string; event: { type: string } & Record<string, unknown> }]; result: void };
  agentApprove: { args: [runId: string, callId: string, decision: 'allow-once' | 'deny' | 'always']; result: boolean };
  agentStop: { args: [runId?: string]; result: void };
  agentLog: { args: []; result: { path: string; content: string } | null };
  agentPickFolder: { args: []; result: string | null };
  defaultFolders: { args: []; result: string[] };
  ext: { args: [a: ExtAction]; result: unknown };
  platform: { args: []; result: { os: 'win32' | 'darwin'; shellName: string; trashWord: string; secretStore: string; toggleLabel: string; stopLabel: string } & Record<string, unknown> };
  hotkeyStatus: { args: []; result: { registered: boolean; hotkey: string } };
  setHotkey: { args: [hotkey: string]; result: { registered: boolean; hotkey: string } };
  openPrivacySettings: { args: []; result: boolean };
  ui: { args: [{ open: 'settings' | 'log' }]; result: void };
  routeStatus: { args: [{ id: string; status: 'doing' | 'answering' }]; result: void };
  runSummary: { args: [{ runId: string; undoable: boolean; folder?: string }]; result: void };
  popupShown: { args: []; result: void };
  undo: { args: [runId: string]; result: { runId: string } };
  reveal: { args: [dir: string]; result: boolean };
  runs: { args: []; result: Array<{ runId: string; kind: 'agent' | 'workflow'; prompt: string; outcome: string; ts: number; status: 'done' | 'error' | 'stopped'; undoable: boolean }> };
  attachPick: { args: []; result: Array<{ path: string; name: string; size: number; mime: string; previewDataUrl?: string; verdict: string; reason?: string }> };
  attachProcess: { args: [input: { runId: string; name: string; dataBase64: string }]; result: { id: string; name: string; mime: string; size: number; kind: string; width?: number; height?: number; previewDataUrl?: string; sha256: string; error?: string } };
  attachClassify: { args: [input: { path: string }]; result: { verdict: string; reason?: string } };
  attachClear: { args: [runId: string]; result: boolean };
  memory: { args: [a: MemoryAction]; result: unknown };
  memoryEvent: { args: [{ runId?: string; requestId?: string; conversationId?: string; event: MemoryPush }]; result: void };
  locale: { args: []; result: { tag: string; dir: 'ltr' | 'rtl'; dict: Record<string, unknown>; fallback: Record<string, unknown>; available: Array<{ tag: string; name: string }> } };
}

// why: every channel key needs payload/result types or the map drifts from IpcChannels.
type AssertMapCoversChannels<T extends Record<IpcChannelKey, { args: unknown[]; result: unknown }>> = T;
const _assertMap: AssertMapCoversChannels<IpcChannelMap> = null as unknown as AssertMapCoversChannels<IpcChannelMap>;
void _assertMap;
