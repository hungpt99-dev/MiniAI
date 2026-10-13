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
  onboarded?: boolean;
  suggestions?: string[];
  /** Launch at login via app.setLoginItemSettings. Off by default. */
  launchAtLogin?: boolean;
}

export interface NexioError {
  code: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model' | 'unknown' | 'validation' | 'aborted';
  message: string;
}

/** Single-channel extension management (nexio:ext). Renderer-safe: plain data only. */
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
