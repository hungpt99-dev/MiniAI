export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'compatible';

export type Mode = 'chat' | 'agent';
export type SlashScope = 'chat' | 'agent' | 'all';

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export type SlashSource = 'builtin' | 'prompt' | 'workflow' | 'user' | 'skill' | 'mcp';

export interface SlashMatch {
  trigger: string;
  label: string;
  description: string;
  source: SlashSource;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplate {
  id: string;
  trigger: string;
  title: string;
  body: string;
  vars: string[];
}

export type WorkflowStep =
  | { kind: 'prompt'; templateId: string; inputVar?: string; outputVar: string }
  | { kind: 'transform'; op: 'append' | 'prepend' | 'replace' | 'uppercase' | 'lowercase'; from: string; to: string; text?: string }
  | { kind: 'conditional'; varName: string; contains: string; thenOutput: string; elseOutput: string; inputVar: string; outputVar: string }
  | { kind: 'user-input'; outputVar: string; prompt: string; defaultValue?: string }
  | { kind: 'output'; inputVar: string };

export interface Workflow {
  id: string;
  trigger: string;
  title: string;
  steps: WorkflowStep[];
}

export interface AgentAlwaysRule {
  scope: 'tool-dir' | 'exact-command';
  tool?: string;
  dir?: string;
  command?: string;
}

export interface Settings {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  temperature?: number;
  /** Custom provider only: send temperature. Default true. */
  sendTemperature?: boolean;
  /** Compatible-only: image support Auto (probe) / On / Off. Default Auto. */
  compatibleImages?: 'auto' | 'on' | 'off';
  theme: 'light' | 'dark';
  hotkey: string;
  mode: Mode;
  modeHotkey: string;
  agentCwd?: string;
  agentAllowedRoots?: string[];
  agentAlwaysAllow?: AgentAlwaysRule[];
  agentStopHotkey?: string;
  agentMaxCalls?: number;
  requireApprovalForWrites?: boolean;
  /** Ask mode may read files and the system (read-only). Default true; off = plain chat. */
  askReadEnabled?: boolean;
  /** MCP full tool names (mcp__server__tool) allowed in Ask. Default []. */
  askMcpTools?: string[];
  onboarded?: boolean;
  suggestions?: string[];
  /** Attachment notice dismissed, keyed by provider id. Absent = show. */
  attachNoticeDismissed?: Record<string, boolean>;
  /** Ask read notice dismissed, keyed by provider id. Absent = show once. */
  askReadNoticeDismissed?: Record<string, boolean>;
  /** Launch at login via app.setLoginItemSettings. Off by default. */
  launchAtLogin?: boolean;
  /** Master switch for long-term memory. Default false until onboarding asks. */
  memoryEnabled?: boolean;
  /** Per-kind opt-ins. Default all true once the master switch is on. */
  memoryKinds?: Record<MemoryKind, boolean>;
  /** Suggest memories after runs (one cheap call, user messages only). Default false. */
  memorySuggest?: boolean;
  /** Semantic search (provider embeddings). Default false; retrieval stays FTS until wired. */
  memorySemantic?: boolean;
  /** Use memory in Ask mode. Default true. */
  memoryUseInAsk?: boolean;
  /** Max stored memories. Default 500. */
  memoryMaxItems?: number;
  /** Episode expiry in days. Default 30. */
  memoryEpisodeDays?: number;
  /** Days until an unused non-pinned item is marked stale. Default 180. */
  memoryStaleDays?: number;
  /** Dismissed suggestion hashes (never propose again). */
  memoryDismissed?: string[];
  /** Memory privacy notice dismissed, keyed by provider id. Absent = show once. */
  memoryNoticeDismissed?: Record<string, boolean>;
  /** Approved folder-rule file lines: path -> line hash. */
  memoryRuleApprovals?: Record<string, string>;
  /** Incognito: no history, no memory reads/writes, minimal run log. Default false. */
  incognito?: boolean;
}

/** Long-term memory kinds (main + renderer safe). */
export type MemoryKind = 'preference' | 'fact' | 'folder_rule' | 'procedure' | 'episode';

/** Memory scope: global, one folder, one app, or one project. */
export type MemoryScope =
  | { type: 'global' }
  | { type: 'folder'; path: string }
  | { type: 'app'; name: string }
  | { type: 'project'; id: string };

export type MemorySource = 'user_said' | 'user_approved' | 'import' | 'system';

/** Renderer-safe memory row (text already capped at save time). */
export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  text: string;
  scope: MemoryScope;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
  pinned: boolean;
  confidence: number;
  expiresAt?: number;
  link?: string;
  enforced?: boolean;
  stale?: boolean;
}

/** Push events for memory rows/cards (memory-event channel). */
export type MemoryPush =
  | { type: 'saved'; id: string; kind: MemoryKind; text: string }
  | { type: 'suggest'; candidates: Array<{ text: string; hash: string }> }
  | { type: 'conflict'; text: string; conflicts: Array<{ id: string; text: string }> }
  | { type: 'blocked'; reason: string };

/** Single-channel memory management (the memory dispatch channel). */
export type MemoryAction =
  | { action: 'list'; kind?: MemoryKind; q?: string }
  | { action: 'get'; id: string }
  | { action: 'save'; kind: MemoryKind; text: string; scope?: MemoryScope; pinned?: boolean; source?: MemorySource; replaceId?: string }
  | { action: 'update'; id: string; text: string; pinned?: boolean }
  | { action: 'forget'; id: string }
  | { action: 'forgetQuery'; q: string }
  | { action: 'search'; q: string; limit?: number }
  | { action: 'export' }
  | { action: 'import'; json: string; dry?: boolean }
  | { action: 'forgetAll'; confirm: string }
  | { action: 'dismiss'; hash: string }
  | { action: 'info' };

export interface NexioError {
  code: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model' | 'unknown' | 'validation' | 'aborted';
  message: string;
}

/** Single-channel extension management (the ext dispatch channel). Renderer-safe: plain data only. */
export interface ExtSourceInput {
  sourceType: 'folder' | 'zip' | 'git' | 'paste' | 'file';
  path?: string;
  url?: string;
  kind?: 'skill' | 'mcp' | 'hook' | 'workflow';
  text?: string;
}

export type ExtAction =
  | { action: 'list' }
  | { action: 'preview'; source: ExtSourceInput }
  | { action: 'install'; source: ExtSourceInput; enable?: boolean }
  | { action: 'enable'; id: string; trustAccepted?: boolean }
  | { action: 'trust'; id: string }
  | { action: 'disable'; id: string }
  | { action: 'updatePreview'; id: string; source: ExtSourceInput }
  | { action: 'update'; id: string; source: ExtSourceInput }
  | { action: 'remove'; id: string }
  | { action: 'source'; id: string }
  | { action: 'skillBody'; name: string }
  | { action: 'mcp'; op: 'restart' | 'stop' | 'trust-start' | 'info'; server: string }
  | { action: 'mcpToolPolicy'; server: string; tool: string; policy: 'ask' | 'allow' | 'block' }
  | { action: 'mcpPrompt'; server?: string; prompt?: string; trigger?: string }
  | { action: 'workflowInfo'; trigger: string }
  | { action: 'workflowRun'; trigger: string; inputs: Record<string, string> }
  | { action: 'hookSet'; event: string; command: string | { win32?: string; darwin?: string }; matcher?: string; extId?: string; enabled: boolean }
  | { action: 'export'; id: string }
  | { action: 'pickFile' };
