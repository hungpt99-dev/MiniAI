import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, AgentLimits, AlwaysRule, ApprovalOutcome, PolicyContext, Tool } from '../agent/types';
import { DEFAULT_LIMITS } from '../agent/types';
import { runAgent, type RunAgentOpts } from '../agent/loop';
import { ALL_TOOLS } from './tools/registry';
import { allowedInAsk } from './mode-policy';
import { makeMemoryTools } from '../memory/tools';
import { makeSubtaskTools, type SubtaskContext } from '../tasks/subtaskTools';
import { TASK_LIMITS, type Task } from '../tasks/taskTypes';
import { TaskParked, type RunControl, type Scheduler } from '../tasks/scheduler';
import type { Settings } from '../../shared/types';
import type { HookRunner } from '../extensions/hooks';
import type { ContentPart } from '../ai/providers/types';
import { scanSecretsText } from '../../shared/attachments';

/** Attachment refs prepared for a task (structural copy of the ipc-side record). */
export interface TaskAttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  kind: 'image' | 'file' | 'text';
}

export interface PreparedTaskAttachment {
  part: ContentPart;
  ref: TaskAttachmentRef;
}

export interface TaskRunEnv {
  db: DatabaseSync;
  settings: Settings;
  apiKey: string;
  scheduler: Scheduler;
  /** Active popup sender for pushes (null when hidden — tasks still pause + notify). */
  sender: Electron.WebContents | null;
  emitAgent: (runId: string, event: AgentEvent) => void;
  registerRun: (runId: string, state: { controller: AbortController; approvals: Map<string, (o: ApprovalOutcome) => void> }) => void;
  unregisterRun: (runId: string) => void;
  approvalWaiter: (state: { controller: AbortController; approvals: Map<string, (o: ApprovalOutcome) => void> }) => (call: { id: string; tool: string; input: unknown; risk: string; summary: string; afterUntrusted?: string }) => Promise<ApprovalOutcome>;
  policyForTask: (task: Task) => PolicyContext;
  taskAttachments: (taskId: string) => PreparedTaskAttachment[];
  userPartsFor: (text: string, prepared: PreparedTaskAttachment[]) => ContentPart[];
  attachMetaFor: (prepared: PreparedTaskAttachment[]) => string | undefined;
  memoryForTask: (task: Task, text: string, cwd: string) => { block?: string; usedIds: string[]; protected: string[] };
  memStatus: (savedText: string | null) => string;
  resolveMemory: (task: Task, text: string, askFn: ((prompt: string) => Promise<string>) | null) => Promise<{ savedText: string | null }>;
  classifyFn: (signal: AbortSignal) => (prompt: string) => Promise<string>;
  extras: () => Promise<{ tools: Tool[]; systemExtra: string }>;
  hooks: (cwd: string, signal: AbortSignal) => HookRunner | null;
  notify: (title: string, body: string, taskId?: string) => void;
  recordRun: (rec: { runId: string; kind: 'agent'; prompt: string; outcome: string; status: 'done' | 'error' | 'stopped'; undoable: boolean; taskId?: string; parentId?: string | null; origin?: string }) => void;
  logLine: (runId: string, rec: Record<string, unknown>) => void;
  createSubtaskRecord: (parent: Task, input: { title?: string; prompt: string; priority?: 'normal' | 'high' }) => { taskId: string } | { error: string };
  markApproval: (taskId: string, runId: string, callId: string, tool: string, summary: string) => void;
  clearApproval: (taskId: string) => void;
  undoAvailableFor: (runId: string) => boolean;
}

/**
 * Execute one scheduler task through the SAME agent loop, tools, permission
 * layer, approvals, limits, run log and undo journal as a normal Do run.
 * Ask mode can never reach here (no subtask tools there, no task entry).
 */
export async function runScheduledTask(
  task: Task,
  ctl: RunControl,
  env: TaskRunEnv,
): Promise<{ status: 'done' | 'failed' | 'stopped' | 'interrupted'; summary: string }> {
  const { settings: s } = env;
  const cwd = task.snapshot.workingFolder;
  const runId = `taskrun-${task.id}-${Date.now().toString(36)}`;
  const state = { controller: new AbortController(), approvals: new Map<string, (o: ApprovalOutcome) => void>() };
  if (ctl.signal.aborted) return { status: 'stopped', summary: 'Stopped' };
  const onCtlAbort = () => { try { state.controller.abort(); } catch { /* noop */ } };
  ctl.signal.addEventListener('abort', onCtlAbort, { once: true });
  try { ctl.onRunId?.(runId); } catch { /* routing hint only */ }
  env.registerRun(runId, state);
  try {
    const prepared = env.taskAttachments(task.id);
    const mem = env.memoryForTask(task, task.prompt, cwd);
    // One combined memory-intent step over the task prompt (same safety
    // as foreground runs: user message only, slash fallback when offline).
    let savedText: string | null = null;
    try {
      const mr = await env.resolveMemory(task, task.prompt, env.apiKey ? env.classifyFn(state.controller.signal) : null);
      savedText = mr.savedText;
    } catch { /* memory never breaks runs */ }
    const memExtra = [mem.block, env.memStatus(savedText)].filter(Boolean).join('\n') || undefined;
    const policy = env.policyForTask(task);
    const { tools: extraTools, systemExtra: extExtra } = await env.extras().catch(() => ({ tools: [] as Tool[], systemExtra: '' }));
    const subCtx = makeSubtaskContext(task, ctl, env, policy);
    const tools = [
      ...ALL_TOOLS,
      ...makeMemoryTools(env.db, { maxItems: s.memoryMaxItems ?? 500 }),
      ...(s.taskAllowSubtasks !== false && task.depth < TASK_LIMITS.maxDepth ? makeSubtaskTools(subCtx) : []),
      ...extraTools,
    ];
    // 429/Retry-After watch: pause the queue instead of failing the task.
    let rateLimitedMs = 0;
    const watchFetch: typeof fetch = (async (url: unknown, init?: unknown) => {
      const res = await fetch(url as string, init as RequestInit);
      try {
        if (res.status === 429) {
          const ra = res.headers.get('retry-after');
          const secs = ra ? Number(ra) : NaN;
          rateLimitedMs = Number.isFinite(secs) ? Math.min(secs * 1000, 300_000) : 30_000;
        }
      } catch { /* never breaks runs */ }
      return res;
    }) as unknown as typeof fetch;
    const emit = (event: AgentEvent) => {
      ctl.heartbeat();
      try {
        env.logLine(runId, {
          runId, mode: 'do', taskId: task.id, parentId: task.parentId, depth: task.depth,
          origin: task.origin, priority: task.priority, event: scrubEvent(event),
        });
      } catch { /* logging never breaks the run */ }
      env.emitAgent(runId, event);
    };
    const waitForApproval = (call: { id: string; tool: string; input: unknown; risk: string; summary: string; afterUntrusted?: string }) => {
      env.markApproval(task.id, runId, call.id, call.tool, call.summary);
      env.scheduler.approvalWait(task.id, runId, call.tool, call.summary);
      return env.approvalWaiter(state)(call).then(
        (o) => { env.clearApproval(task.id); env.scheduler.approvalResolved(task.id); return o; },
        (e) => { env.clearApproval(task.id); env.scheduler.approvalResolved(task.id); throw e; },
      );
    };
    const systemExtra = [extExtra, memExtra].filter(Boolean).join('\n') || undefined;
    const full = await runAgent(task.prompt, {
      provider: task.snapshot.provider as RunAgentOpts['provider'],
      apiKey: env.apiKey,
      model: task.snapshot.model,
      cwd,
      history: [],
      allowedRoots: (policy.allowedRoots as string[]).length ? policy.allowedRoots as string[] : undefined,
      alwaysAllow: (policy.alwaysAllow as AlwaysRule[]) || [],
      requireApprovalForWrites: s.requireApprovalForWrites !== false,
      tools,
      systemExtra,
      hooks: env.hooks(cwd, state.controller.signal),
      signal: state.controller.signal,
      emit,
      runId,
      undoDir: undefined,
      ...(prepared.length ? { userParts: env.userPartsFor(task.prompt, prepared) } : {}),
      ...(prepared.length && env.attachMetaFor(prepared) ? { attachMeta: env.attachMetaFor(prepared) } : {}),
      ...(s.compatibleImages ? { imageMode: s.compatibleImages } : {}),
      ...(mem.protected.length ? { extraProtected: mem.protected } : {}),
      waitForApproval,
      // Task-scoped "always": applies to this run only, expires when it ends.
      onPersistAlwaysRule: undefined,
      taskLock: ctl.locks,
      subtaskAskFirst: s.taskAskBeforeSubtasks !== false,
      fetchFn: watchFetch,
      limits: { maxToolCalls: s.agentMaxCalls || 25 },
    } satisfies RunAgentOpts);
    if (state.controller.signal.aborted || ctl.signal.aborted) return { status: 'stopped', summary: 'Stopped' };
    if (rateLimitedMs > 0 && !full.trim()) {
      const err = new Error(`rate-limit: provider asked to slow down (retry after ${Math.round(rateLimitedMs / 1000)}s)`);
      (err as { code?: string }).code = 'rate-limit';
      throw err;
    }
    const summary = full.trim() || '(no answer)';
    env.recordRun({
      runId, kind: 'agent', prompt: task.prompt, outcome: summary.slice(0, 160),
      status: 'done', undoable: env.undoAvailableFor(runId),
      taskId: task.id, parentId: task.parentId, origin: task.origin,
    });
    return { status: 'done', summary };
  } catch (e) {
    if ((e as { name?: string })?.name === 'TaskParkedError') throw new TaskParked((e as Error).message.replace(/^task-parked:\s*/, ''));
    if (state.controller.signal.aborted || ctl.signal.aborted) return { status: 'stopped', summary: 'Stopped' };
    const msg = (e as Error)?.message || String(e);
    env.recordRun({
      runId, kind: 'agent', prompt: task.prompt, outcome: msg.slice(0, 160),
      status: 'error', undoable: false, taskId: task.id, parentId: task.parentId, origin: task.origin,
    });
    return { status: 'failed', summary: msg.slice(0, 500) };
  } finally {
    ctl.signal.removeEventListener('abort', onCtlAbort);
    env.unregisterRun(runId);
  }
}

/** Log-safe copy: memory text never reaches the run log (ids only). */
function scrubEvent(event: AgentEvent): Record<string, unknown> {
  if ((event.type === 'tool_call' || event.type === 'approval_request') &&
    typeof (event as { tool?: unknown }).tool === 'string' && (event as { tool: string }).tool.startsWith('memory_')) {
    const { id, tool, risk } = event as { id: string; tool: string; risk: string };
    return { type: event.type, id, tool, risk };
  }
  if (event.type === 'tool_result') {
    const { output, ...rest } = event;
    void output;
    return { ...rest, outputSize: (event.output || '').length };
  }
  return event as unknown as Record<string, unknown>;
}

function makeSubtaskContext(task: Task, ctl: RunControl, env: TaskRunEnv, policy: PolicyContext): SubtaskContext {
  return {
    parentId: task.id,
    runId: `subctx-${task.id}`,
    allowedRoots: [...(policy.allowedRoots as string[] || [])],
    alwaysAllow: [...(policy.alwaysAllow as unknown[] || [])],
    attachmentIds: [...task.snapshot.attachmentIds],
    provider: task.snapshot.provider,
    model: task.snapshot.model,
    cwd: task.snapshot.workingFolder,
    createSubtask: async (input) => {
      if (env.settings.taskAllowSubtasks === false) return { error: 'agent subtasks are off (Settings > Agent > Tasks)' };
      // Provenance is enforced by the caller passing only user messages;
      // the sanitized prompt cap + injection wrap happen here.
      const prompt = String(input.prompt || '').trim().slice(0, TASK_LIMITS.subtaskPromptChars);
      if (!prompt) return { error: 'empty prompt' };
      if (scanSecretsText(prompt)) return { error: 'prompt looks like a secret' };
      return env.createSubtaskRecord(task, { ...(input.title ? { title: input.title } : {}), prompt, priority: input.priority });
    },
    listSubtasks: (state) => env.scheduler.list().filter((t) => t.parentId === task.id && (!state || t.state === state)),
    resultOf: (taskId) => {
      const t = env.scheduler.get(taskId);
      if (!t || t.parentId !== task.id) return null;
      return t;
    },
    cancelSubtask: (taskId) => {
      const t = env.scheduler.get(taskId);
      if (!t || t.parentId !== task.id) return false;
      return env.scheduler.stop(taskId);
    },
    waitFor: (taskId, signal) => {
      const t = env.scheduler.get(taskId);
      if (!t || t.parentId !== task.id) return Promise.reject(new Error('unknown subtask'));
      env.scheduler.releaseSlotForWait(task.id);
      ctl.setDetail('Waiting for subtasks');
      return env.scheduler.waitForTask(taskId, signal).finally(() => {
        env.scheduler.reclaimSlot(task.id);
        ctl.setDetail('');
      });
    },
  };
}

/** Ask mode can never see subtask tools (same layer as the model filter). */
export function taskToolsForMode(mode: 'ask' | 'do', tools: Tool[]): Tool[] {
  if (mode === 'ask') return tools.filter((t) => allowedInAsk(t));
  return tools;
}

export const TASK_RUN_LIMITS: AgentLimits = { ...DEFAULT_LIMITS };
