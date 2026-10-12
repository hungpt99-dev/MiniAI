export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'compatible';

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export type SlashSource = 'builtin' | 'prompt' | 'workflow' | 'user';

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

export interface Settings {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  temperature?: number;
  theme: 'light' | 'dark';
  hotkey: string;
}

export interface MiniAIError {
  code: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model' | 'unknown' | 'validation' | 'aborted';
  message: string;
}
