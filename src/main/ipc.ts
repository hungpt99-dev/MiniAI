import { dialog, globalShortcut, ipcMain, shell } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IpcChannels } from '../shared/ipc-channels';
import { getSettings, updateSettings } from './store/settings';
import { setSecret, getSecret, apiKeyService, isEncryptionAvailable } from './store/secrets';
import { createConversation, listConversations, addMessage, getMessages, deleteConversation } from './db/conversations';
import { listTemplates, upsertTemplate, listWorkflows, render } from './db/templates';
import { streamChat } from './ai/stream';
import { testConnectivity, resetParamCache } from './ai/providers';
import { getAdapter } from './ai/providers/index';
import { buildRegistry, querySlash, resolveSlash, type SlashEntry } from './slash/registry';
import { runWorkflow } from './workflow/engine';
import { routeRequest, type RouteInput } from './agent/router';
import { runAgent, executeToolCall, DEFAULT_LIMITS, type ToolExecState } from './agent/loop';
import type { AgentEvent, AgentLimits, ApprovalDecision, ApprovalOutcome, AlwaysRule, PolicyContext, Tool } from './agent/types';
import { defaultAllowedRoots } from './agent/permissions';
import { ALL_TOOLS } from './agent/tools/registry';
import type { AgentMsg } from './ai/tools-chat';
import { getLatestLog, createRunLog, appendLog } from './agent/log';
import { classifyIntent, clarifyQuestion } from './agent/intent';
import { undoAvailable, undoFolder, undoRun } from './agent/undo';
import { recordRun, listRuns, oneLineOutcome } from './agent/runs';
import { extService } from './extensions/index';
import { validateHooksJson, hookDisplayCommand, hookCommandKey } from './extensions/hooks';
import { platform } from './platform/index';
import { readInstalledWorkflows } from './extensions/store';
import { parseWorkflowDoc, runExtWorkflow } from './extensions/workflows';
import type { ExtAction, ExtSourceInput } from '../shared/types';
import type { SourceInput } from './extensions/sources';
import { setPopupHeight, togglePopup } from './popup';
import type { ChatMessage, Mode, Settings } from '../shared/types';

const aborters = new Map<string, AbortController>();
let seq = 0;

// Built-in computer-use agent runs (one AbortController per run; approval resolvers per call).
interface AgentRunState {
  controller: AbortController;
  approvals: Map<string, (o: ApprovalOutcome) => void>;
}
const agentRuns = new Map<string, AgentRunState>();

/** Abort every running agent (Stop button, Esc, global hotkey). Also kills MCP children. */
export function stopAllAgentRuns(): void {
  for (const r of agentRuns.values()) {
    try { r.controller.abort(); } catch { /* noop */ }
  }
  try {
    const svc = extService(db());
    void svc.mcp.stopAll();
  } catch { /* db not ready in tests */ }
}

function toAccelerator(hotkey: string): string {
  return hotkey.split('+').map((p) => {
    const t = p.trim().toLowerCase();
    if (t === 'ctrl' || t === 'control') return 'CommandOrControl';
    if (t === 'esc') return 'Escape';
    return p.trim();
  }).join('+');
}

let stopHotkey = '';

/** Register the configurable global stop hotkey (default Ctrl+Alt+Esc). */
export function refreshStopHotkey(): void {
  let want = 'Ctrl+Alt+Esc';
  try {
    want = getSettings(db()).agentStopHotkey || want;
  } catch { /* db not ready in tests */ }
  const accel = toAccelerator(want);
  if (accel === stopHotkey) return;
  if (stopHotkey) {
    try { globalShortcut.unregister(stopHotkey); } catch { /* noop */ }
    stopHotkey = '';
  }
  try {
    if (globalShortcut.register(accel, () => stopAllAgentRuns())) stopHotkey = accel;
    else console.warn(`[Nexio] stop hotkey ${accel} taken`);
  } catch {
    console.warn(`[Nexio] invalid stop hotkey ${want}`);
  }
}

let toggleHotkey = '';
let toggleStatus: { registered: boolean; hotkey: string } = { registered: false, hotkey: '' };

export function getHotkeyStatus(): { registered: boolean; hotkey: string } {
  return { ...toggleStatus };
}

/** Register the toggle hotkey (default Alt+Space / Option+Space). Never fails silently. */
export function refreshToggleHotkey(onToggle: () => void): void {
  const p = platform();
  let want = p.defaultHotkeys().toggle;
  try {
    want = getSettings(db()).hotkey || want;
  } catch { /* db not ready in tests */ }
  if (toggleHotkey) {
    try { globalShortcut.unregister(toggleHotkey); } catch { /* noop */ }
    toggleHotkey = '';
  }
  toggleStatus = { registered: false, hotkey: want };
  const fallback = want === p.defaultHotkeys().toggle ? 'Alt+X' : p.defaultHotkeys().toggle;
  try {
    if (globalShortcut.register(want, onToggle)) {
      toggleHotkey = want;
      toggleStatus.registered = true;
      console.log(`[Nexio] hotkey registered: ${want}`);
      return;
    }
  } catch {
    console.warn(`[Nexio] invalid toggle hotkey ${want}`);
  }
  try {
    if (globalShortcut.register(fallback, onToggle)) {
      toggleHotkey = fallback;
      toggleStatus = { registered: true, hotkey: fallback };
      console.warn(`[Nexio] hotkey ${want} taken, using fallback ${fallback}`);
      return;
    }
  } catch { /* fall through */ }
  console.error(`[Nexio] no hotkey registered (${want}, ${fallback} both taken)`);
}

/** Launch at login, off by default; applied from settings on both OSes. */
export function applyLaunchAtLogin(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    app.setLoginItemSettings({ openAtLogin: getSettings(db()).launchAtLogin === true });
  } catch { /* db or app not ready */ }
}

/** Renderer-safe platform facts: key caps, shell/trash names, secret store label. */
export function platformInfo(): {
  os: 'win32' | 'darwin';
  shellName: string;
  trashWord: string;
  caps: { alt: string; ctrl: string; shift: string; cmd: string; esc: string; space: string };
  secretStore: string;
  toggleLabel: string;
  stopLabel: string;
  toggleKeys: string[];
  stopKeys: string[];
} {
  const p = platform();
  let toggle = p.defaultHotkeys().toggle;
  let stop = 'Ctrl+Alt+Esc';
  try {
    const s = getSettings(db());
    toggle = s.hotkey || toggle;
    stop = s.agentStopHotkey || stop;
  } catch { /* db not ready */ }
  return {
    os: p.key,
    shellName: p.shellName,
    trashWord: p.trashWord,
    caps: p.keyCaps(),
    secretStore: p.key === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI',
    toggleLabel: p.keyLabel(toggle),
    stopLabel: p.keyLabel(stop),
    toggleKeys: p.keyTokens(toggle),
    stopKeys: p.keyTokens(stop),
  };
}

// IPC serializes non-Error rejections as "[object Object]" — normalize at the boundary
// so the real cause (e.g. `auth: ...`) reaches the UI.
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = e as { code?: string; message?: string };
  if (o?.code && o?.message) return new Error(`${o.code}: ${o.message}`);
  try { return new Error(`Unknown error: ${JSON.stringify(e)}`); }
  catch { return new Error(`Unknown error: ${String(e)}`); }
}

function db(): DatabaseSync {
  return (globalThis as unknown as { __nexioDb: DatabaseSync }).__nexioDb;
}

/** Policy context for agent and workflow runs (same layer, same roots). */
function policyFor(s: Settings, cwd: string, grants: AlwaysRule[] = []): PolicyContext {
  const homeDir = os.homedir();
  const roots = s.agentAllowedRoots?.length ? s.agentAllowedRoots : undefined;
  return {
    allowedRoots: roots || defaultAllowedRoots(homeDir, cwd),
    explicitRoots: roots || [],
    alwaysAllow: [...(s.agentAlwaysAllow || []), ...grants] as AlwaysRule[],
    requireApprovalForWrites: s.requireApprovalForWrites !== false,
    homeDir,
  };
}

function approvalWaiter(state: AgentRunState) {
  return (call: { id: string; tool: string; input: unknown; risk: string; summary: string; afterUntrusted?: string }) =>
    new Promise<ApprovalOutcome>((resolve) => {
      state.approvals.set(call.id, resolve);
    }).finally(() => { state.approvals.delete(call.id); });
}

function persistRule(d: DatabaseSync) {
  return (rule: AlwaysRule) => {
    const cur = getSettings(d);
    const list = cur.agentAlwaysAllow || [];
    if (!list.some((r) => JSON.stringify(r) === JSON.stringify(rule))) {
      updateSettings(d, { agentAlwaysAllow: [...list, rule] });
    }
  };
}

function toSourceInput(s: ExtSourceInput): SourceInput {
  if (s.sourceType === 'folder') return { type: 'folder', path: s.path || '' };
  if (s.sourceType === 'zip') return { type: 'zip', path: s.path || '' };
  if (s.sourceType === 'git') return { type: 'git', url: s.url || '' };
  if (s.sourceType === 'file') {
    const p = s.path || '';
    if (/\.zip$/i.test(p)) return { type: 'zip', path: p };
    // Single .md/.json file: read it as a pasted snippet (never executes).
    const text = fs.readFileSync(p, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 200 * 1024) throw new Error('file too large (cap 200KB)');
    return { type: 'paste', kind: s.kind || 'skill', text };
  }
  return { type: 'paste', kind: s.kind || 'skill', text: s.text || '' };
}

/** Extension slash entries; failures never break chat/agent. */
function extSlashEntries(): { skills: SlashEntry[]; workflows: SlashEntry[]; mcp: SlashEntry[] } {
  try {
    const ext = extService(db());
    return { skills: ext.skillEntries(), workflows: ext.workflowEntries(), mcp: ext.mcpPromptEntries() };
  } catch {
    return { skills: [], workflows: [], mcp: [] };
  }
}

export interface SendOpts {
  mode?: Mode;
  sessionId?: string;
  requestId?: string;
  /** True when the user explicitly picked the mode pill (wins over intent routing). */
  explicit?: boolean;
}

/** One cheap model call for uncertain intents (heuristic runs first). */
async function classifyWithModel(
  s: Settings, key: string, prompt: string, signal: AbortSignal,
): Promise<string> {
  let acc = '';
  await streamChat(s.provider, {
    apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: 0,
    messages: [{ id: 'intent', role: 'user', content: prompt, createdAt: 0 }],
    signal, onToken: (t) => { acc += t; },
  });
  return acc;
}

function routeStatus(sender: Electron.WebContents, id: string, status: 'doing' | 'answering'): void {
  try { sender.send(IpcChannels.routeStatus, { id, status }); } catch { /* window gone */ }
}

/** Persist run history + push the run summary (outcome line, undo, folder). */
function finishRun(
  d: DatabaseSync, sender: Electron.WebContents,
  runId: string, kind: 'agent' | 'workflow', prompt: string,
  outcome: string, status: 'done' | 'error' | 'stopped', cwd: string,
): void {
  const undoable = undoAvailable(runId);
  try {
    recordRun({ runId, kind, prompt, outcome: oneLineOutcome(outcome), ts: Date.now(), status, undoable, engine: 'builtin' });
  } catch { /* history must never break runs */ }
  try {
    sender.send(IpcChannels.runSummary, { runId, undoable, folder: undoable ? undoFolder(runId, cwd) : undefined });
  } catch { /* window gone */ }
}

async function runSend(
  sender: Electron.WebContents,
  conversationId: string,
  content: string,
  opts: SendOpts = {},
): Promise<string> {
  const d = db();
  // Freeze mode/sessionId/requestId at send time.
  const s = getSettings(d);
  const mode: Mode = opts.mode || s.mode || 'agent';
  const sessionId = opts.sessionId || conversationId;
  const requestId = opts.requestId || `req-${Date.now()}-${++seq}`;
  addMessage(d, conversationId, 'user', content);
  const history = getMessages(d, conversationId);
  const key = getSecret(d, apiKeyService(s.provider)) || '';
  const aborter = new AbortController();
  aborters.set(requestId, aborter);
  // Intent routing: an explicit pill selection wins; otherwise classify.
  // act → built-in agent loop, answer/clarify → plain streamed response.
  let effective = mode;
  if (!opts.explicit && !content.trim().startsWith('/')) {
    const intent = await classifyIntent(content, {
      askModel: (prompt) => classifyWithModel(s, key, prompt, aborter.signal),
    });
    if (intent === 'clarify') {
      const q = clarifyQuestion(content);
      routeStatus(sender, requestId, 'answering');
      addMessage(d, conversationId, 'assistant', q);
      sender.send(IpcChannels.chatStream, { token: q, done: false, conversationId, requestId });
      sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
      aborters.delete(requestId);
      return q;
    }
    effective = intent === 'act' ? 'agent' : 'chat';
  }
  routeStatus(sender, requestId, effective === 'agent' ? 'doing' : 'answering');
  if (effective === 'agent') {
    // Routed act: full built-in loop with approvals, bridged onto this request.
    const runId = `agent-${Date.now()}-${++seq}`;
    const state: AgentRunState = { controller: aborter, approvals: new Map() };
    agentRuns.set(runId, state);
    const cwd = s.agentCwd || os.homedir();
    try {
      const full = await runBuiltInAgent({
        sender, d, s, key, content, history, cwd, runId,
        controller: aborter, state, prompt: content,
      });
      if (full) addMessage(d, conversationId, 'assistant', full);
      finishRun(d, sender, runId, 'agent', content, full, aborter.signal.aborted ? 'stopped' : 'done', cwd);
      sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
      return full;
    } catch (e) {
      finishRun(d, sender, runId, 'agent', content, asError(e).message, 'error', cwd);
      throw asError(e);
    } finally {
      agentRuns.delete(runId);
      aborters.delete(requestId);
    }
  }
  const frozen: RouteInput = { mode: effective, sessionId, requestId, prompt: content };
  try {
    const full = await routeRequest(
      { ...frozen, cwd: s.agentCwd, signal: aborter.signal, onToken: (t) => sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId, requestId }) },
      {
        chat: async (input) => {
          let acc = '';
          await streamChat(s.provider, {
            apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: chatTemperature(s),
            messages: history, signal: input.signal,
            onToken: (t) => { acc += t; input.onToken?.(t); },
          });
          return acc;
        },
      },
    );
    addMessage(d, conversationId, 'assistant', full);
    sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
    return full;
  } catch (e) {
    throw asError(e);
  } finally {
    aborters.delete(requestId);
  }
}

/** Shared built-in agent execution (Send routing + explicit agentStart). */
async function runBuiltInAgent(o: {
  sender: Electron.WebContents; d: DatabaseSync; s: Settings; key: string;
  content: string; history: ChatMessage[]; cwd: string; runId: string;
  controller: AbortController; state: AgentRunState; prompt: string;
}): Promise<string> {
  const { sender, d, s, key, content, history, cwd, runId, controller, state, prompt } = o;
  const emit = (event: AgentEvent) => {
    try { sender.send(IpcChannels.agentEvent, { runId, event }); } catch { /* window gone */ }
  };
  const ext = extService(d);
  let extras: { tools: Tool[]; systemExtra: string; needsTrust: { server: string }[] } = { tools: [], systemExtra: '', needsTrust: [] };
  try {
    extras = await ext.agentExtras();
  } catch { /* agent runs without extensions rather than failing */ }
  for (const nt of extras.needsTrust) {
    emit({ type: 'step', id: `${runId}-skip-${nt.server}`, text: `MCP "${nt.server}" needs trust — skipped (see Extensions → MCP).` });
  }
  return runAgent(content, {
    provider: s.provider,
    apiKey: key,
    model: s.model,
    baseUrl: s.baseUrl,
    cwd,
    history,
    allowedRoots: s.agentAllowedRoots?.length ? s.agentAllowedRoots : undefined,
    alwaysAllow: ((s.agentAlwaysAllow || []) as AlwaysRule[]),
    requireApprovalForWrites: s.requireApprovalForWrites !== false,
    limits: { maxToolCalls: s.agentMaxCalls || 25 },
    tools: [...ALL_TOOLS, ...extras.tools],
    systemExtra: extras.systemExtra || undefined,
    hooks: ext.hookRunner(cwd, controller.signal),
    signal: controller.signal,
    emit,
    runId,
    waitForApproval: approvalWaiter(state),
    onPersistAlwaysRule: persistRule(d),
  });
}

function unwrapToolMessage(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.startsWith('<tool_result')) {
    const end = lines[lines.length - 1] === '</tool_result>' ? lines.length - 1 : lines.length;
    return lines.slice(2, end).join('\n');
  }
  return content;
}

/**
 * v1 extension workflow run: same permission layer as the agent loop
 * (executeToolCall), approvals resolve over agentApprove, Stop kills all.
 * Streams step/tool/approval events on the agentEvent channel under runId.
 */
async function runExtWorkflowRun(
  sender: Electron.WebContents,
  trigger: string,
  inputs: Record<string, string>,
): Promise<{ runId: string }> {
  const d = db();
  const s = getSettings(d);
  const ext = extService(d);
  let found: { record: { id: string; grants?: AlwaysRule[] }; doc: ReturnType<typeof parseWorkflowDoc> } | null = null;
  for (const { record, raw } of readInstalledWorkflows(ext.store)) {
    const doc = parseWorkflowDoc(raw);
    if (doc.workflow.trigger === trigger || doc.workflow.id === trigger) {
      found = { record, doc };
      break;
    }
  }
  if (!found) throw new Error(`Unknown workflow: ${trigger}`);
  if (found.doc.kind !== 'ext') throw new Error(`${trigger} is a legacy workflow`);
  const doc = found.doc.workflow;
  const grants = found.record.grants || [];
  const key = getSecret(d, apiKeyService(s.provider)) || process.env[`${s.provider.toUpperCase()}_API_KEY`] || '';
  const cwd = s.agentCwd || os.homedir();
  const controller = new AbortController();
  const runId = `wf-${Date.now()}-${++seq}`;
  const state: AgentRunState = { controller, approvals: new Map() };
  agentRuns.set(runId, state);
  const wlog = createRunLog();
  const emit = (event: AgentEvent) => {
    try {
      appendLog(wlog.path, { runId, event });
    } catch { /* logging never breaks the run */ }
    try { sender.send(IpcChannels.agentEvent, { runId, event }); } catch { /* window gone */ }
  };
  void (async () => {
    const start = Date.now();
    try {
      let extras: { tools: Tool[]; systemExtra: string; needsTrust: { server: string }[] } = { tools: [], systemExtra: '', needsTrust: [] };
      try {
        extras = await ext.agentExtras();
      } catch { /* run without extensions rather than failing */ }
      const tools = [...ALL_TOOLS, ...extras.tools];
      const map = new Map(tools.map((t) => [t.name, t]));
      const messages: AgentMsg[] = [];
      const limits = DEFAULT_LIMITS;
      const policy = policyFor(s, cwd, grants);
      const logHook = (rec: Record<string, unknown>) => {
        try {
          appendLog(wlog.path, { runId, ...rec });
        } catch { /* logging never breaks the run */ }
      };
      const st: ToolExecState = {
        cwd,
        policy,
        limits,
        signal: controller.signal,
        emit,
        messages,
        waitForApproval: approvalWaiter(state),
        onPersistAlwaysRule: persistRule(d),
        hooks: ext.hookRunner(cwd, controller.signal),
        logHook,
        undo: { runId, prompt: `${doc.trigger} ${JSON.stringify(inputs)}`.slice(0, 300) },
        checkRunTimeout: () => Date.now() - start - st.approvalWaitMs > limits.runTimeoutMs,
        toolCalls: 0,
        approvalWaitMs: 0,
        lastUntrusted: null,
      };
      const streamPrompt = async (prompt: string): Promise<string> => {
        let acc = '';
        await streamChat(s.provider, {
          apiKey: key, model: s.model, baseUrl: s.baseUrl,
          messages: [{ id: 'w', role: 'user', content: prompt, createdAt: 0 }],
          signal: controller.signal,
          onToken: (t) => { acc += t; },
        });
        return acc;
      };
      emit({ type: 'step', id: `${runId}-begin`, text: `Running workflow ${doc.title}…` });
      const result = await runExtWorkflow(doc, inputs, {
        signal: controller.signal,
        runPrompt: streamPrompt,
        callTool: async (name, args) => {
          const tool = map.get(name);
          if (!tool) return { ok: false, output: `unknown tool: ${name}` };
          const callId = `wf-${Date.now()}-${++seq}`;
          const outcome = await executeToolCall(tool, name, args, callId, st);
          if (outcome === 'timeout') throw new Error('Run limit: exceeded time budget');
          const last = st.messages[st.messages.length - 1];
          const content = last && last.role === 'tool' ? last.content : '';
          return { ok: outcome === 'ran' && !content.startsWith('Error:'), output: unwrapToolMessage(content) };
        },
        loadSkill: async (name) => {
          const t = extras.tools.find((x) => x.name === 'skill_load');
          if (!t) throw new Error(`skill not available: ${name}`);
          const r = await t.run({ name }, { signal: controller.signal, cwd });
          if (!r.ok) throw new Error(r.output);
          return r.output;
        },
        runSubAgent: async (goal, allowTools) => {
          const subTools = allowTools?.length ? tools.filter((t) => allowTools.includes(t.name)) : tools;
          return runAgent(goal, {
            provider: s.provider, apiKey: key, model: s.model, baseUrl: s.baseUrl,
            cwd, history: [],
            allowedRoots: s.agentAllowedRoots?.length ? s.agentAllowedRoots : undefined,
            alwaysAllow: policy.alwaysAllow,
            requireApprovalForWrites: s.requireApprovalForWrites !== false,
            limits: { maxToolCalls: s.agentMaxCalls || 25 },
            tools: subTools,
            systemExtra: extras.systemExtra || undefined,
            hooks: ext.hookRunner(cwd, controller.signal),
            signal: controller.signal,
            emit,
            waitForApproval: approvalWaiter(state),
            onPersistAlwaysRule: persistRule(d),
          });
        },
        confirm: async (text) => {
          const callId = `wf-confirm-${Date.now()}-${++seq}`;
          emit({ type: 'approval_request', id: callId, tool: 'confirm', input: { text }, risk: 'write', summary: text });
          const w0 = Date.now();
          try {
            const outcome = await Promise.race([
              approvalWaiter(state)({ id: callId, tool: 'confirm', input: { text }, risk: 'write', summary: text }),
              new Promise<ApprovalOutcome>((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
              }),
            ]);
            return outcome.decision !== 'deny';
          } finally {
            st.approvalWaitMs += Date.now() - w0;
          }
        },
        onStep: (i, step, output) => {
          void output;
          emit({ type: 'step', id: `${runId}-s${i}`, text: `Step ${i + 1}/${doc.steps.length}: ${step.kind}` });
        },
      });
      const finalText = result.history.length ? result.history[result.history.length - 1].output : '';
      d.prepare('INSERT INTO runs (id, workflowId, status, output, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        `r-${Date.now()}`, doc.id, result.status, finalText.slice(0, 8000), Date.now(),
      );
      if (result.status === 'ok') {
        if (finalText) emit({ type: 'text_delta', text: finalText });
        emit({ type: 'done', summary: finalText.slice(0, 500) });
        finishRun(d, sender, runId, 'workflow', doc.trigger, finalText, 'done', cwd);
      } else if (result.status === 'aborted' || controller.signal.aborted) {
        emit({ type: 'stopped' });
        finishRun(d, sender, runId, 'workflow', doc.trigger, 'Stopped', 'stopped', cwd);
      } else {
        emit({ type: 'error', message: (result.error || 'workflow failed').slice(0, 500) });
        finishRun(d, sender, runId, 'workflow', doc.trigger, result.error || 'workflow failed', 'error', cwd);
      }
    } catch (e2) {
      if (controller.signal.aborted) emit({ type: 'stopped' });
      else emit({ type: 'error', message: asError(e2).message.slice(0, 500) });
    } finally {
      agentRuns.delete(runId);
    }
  })();
  return { runId };
}

/** Custom provider with the temperature toggle off sends no sampling param. */
function chatTemperature(s: Settings): number | undefined {
  if (s.provider === 'compatible' && s.sendTemperature === false) return undefined;
  return s.temperature;
}

export function registerIpc(): void {
  ipcMain.handle(IpcChannels.getSettings, () => getSettings(db()));
  ipcMain.handle(IpcChannels.setSettings, (_e, patch: Partial<Settings>) => {
    const out = updateSettings(db(), patch);
    if (patch.agentStopHotkey !== undefined) refreshStopHotkey();
    if (patch.hotkey !== undefined) refreshToggleHotkey(() => togglePopup());
    if (patch.launchAtLogin !== undefined) applyLaunchAtLogin();
    return out;
  });
  ipcMain.handle(IpcChannels.setApiKey, (_e, provider: string, key: string) => {
    if (!key) throw new Error('Empty API key');
    setSecret(db(), apiKeyService(provider), key);
    return true;
  });
  ipcMain.handle(IpcChannels.isEncryptionAvailable, () => isEncryptionAvailable());
  ipcMain.handle(IpcChannels.testConnectivity, async (_e, provider, model: string, baseUrl?: string, apiKey?: string) => {
    // Unsaved settings-panel values win; stored key is the fallback. Never logged.
    const key = (typeof apiKey === 'string' && apiKey) || getSecret(db(), apiKeyService(provider as string)) || '';
    return testConnectivity(provider, key, model, baseUrl);
  });
  ipcMain.handle(IpcChannels.listModels, async (_e, provider, baseUrl?: string) => {
    const d = db();
    const s = getSettings(d);
    const adapter = getAdapter(provider as Settings['provider']);
    const key = getSecret(d, apiKeyService(provider as string)) || '';
    return adapter.listModels(key, baseUrl || s.baseUrl || adapter.defaultBaseUrl);
  });
  ipcMain.handle(IpcChannels.resetProviderFixes, () => {
    resetParamCache();
    return true;
  });

  ipcMain.handle(IpcChannels.listConversations, () => listConversations(db()));
  ipcMain.handle(IpcChannels.createConversation, (_e, title?: string) => createConversation(db(), title));
  ipcMain.handle(IpcChannels.getMessages, (_e, id: string) => getMessages(db(), id));
  ipcMain.handle(IpcChannels.deleteConversation, (_e, id: string) => { deleteConversation(db(), id); return true; });
  ipcMain.handle(IpcChannels.listTemplates, () => listTemplates(db()));
  ipcMain.handle(IpcChannels.upsertTemplate, (_e, t) => upsertTemplate(db(), t));
  ipcMain.handle(IpcChannels.listWorkflows, () => listWorkflows(db()));

  ipcMain.handle(IpcChannels.slashQuery, (_e, text: string, mode?: Mode) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    const extra = extSlashEntries();
    return querySlash(buildRegistry({ prompts: templates, workflows: [...workflows, ...extra.workflows], skills: extra.skills, mcp: extra.mcp }), text, 8, mode);
  });
  ipcMain.handle(IpcChannels.slashResolve, (_e, trigger: string, mode?: Mode) => {
    const templates = listTemplates(db()).map((t) => ({ trigger: t.trigger, label: t.title, description: t.body.slice(0, 80), source: 'prompt' as const }));
    const workflows = listWorkflows(db()).map((w) => ({ trigger: w.trigger, label: w.title, description: `${w.steps.length} steps`, source: 'workflow' as const }));
    const extra = extSlashEntries();
    return resolveSlash(buildRegistry({ prompts: templates, workflows: [...workflows, ...extra.workflows], skills: extra.skills, mcp: extra.mcp }), trigger, mode);
  });

  ipcMain.handle(IpcChannels.runWorkflow, async (e, trigger: string, vars: Record<string, string>) => {
    const d = db();
    let w = listWorkflows(d).find((x) => x.trigger === trigger || x.id === trigger);
    if (!w) {
      // Extension workflows in legacy file format run on the same engine.
      try {
        const ext = extService(d);
        for (const { raw } of readInstalledWorkflows(ext.store)) {
          const doc = parseWorkflowDoc(raw, {
            templateExists: (t) => !!listTemplates(d).find((x) => x.id === t || x.trigger === t),
          });
          if (doc.kind === 'legacy' && (doc.workflow.trigger === trigger || doc.workflow.id === trigger)) {
            w = doc.workflow;
            break;
          }
        }
      } catch { /* fall through to unknown-workflow error */ }
    }
    if (!w) throw new Error(`Unknown workflow: ${trigger}`);
    const requestId = `wf-${Date.now()}-${++seq}`;
    const aborter = new AbortController();
    aborters.set(requestId, aborter);
    const sender = e.sender;
    try {
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
            signal: signal || aborter.signal,
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
    } catch (e) {
      throw asError(e);
    } finally {
      aborters.delete(requestId);
    }
  });

  ipcMain.on(IpcChannels.chatCancel, (_e, requestId?: string) => {
    if (requestId) aborters.get(requestId)?.abort();
    else for (const a of aborters.values()) a.abort();
  });

  ipcMain.on(IpcChannels.resize, (_e, h: unknown) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return;
    setPopupHeight(h);
  });

  // Chat: streams tokens via `chatStream` event, resolves with full text.
  ipcMain.handle(IpcChannels.chat, async (e, conversationId: string, messages: ChatMessage[], opts: SendOpts = {}) => {
    const d = db();
    const s = getSettings(d);
    const key = getSecret(d, apiKeyService(s.provider)) || process.env[`${s.provider.toUpperCase()}_API_KEY`] || '';
    const requestId = opts.requestId || `req-${Date.now()}-${++seq}`;
    const aborter = new AbortController();
    aborters.set(requestId, aborter);
    const sender = e.sender;
    try {
      let full = '';
      await streamChat(s.provider, {
        apiKey: key, model: s.model, baseUrl: s.baseUrl, temperature: chatTemperature(s),
        messages, signal: aborter.signal,
        onToken: (t) => { full += t; sender.send(IpcChannels.chatStream, { token: t, done: false, conversationId, requestId }); },
      });
      addMessage(d, conversationId, 'assistant', full);
      sender.send(IpcChannels.chatStream, { token: '', done: true, conversationId, requestId });
      return full;
    } catch (e) {
      throw asError(e);
    } finally {
      aborters.delete(requestId);
    }
  });

  ipcMain.handle(IpcChannels.send, (e, conversationId: string, content: string, opts: SendOpts = {}) =>
    runSend(e.sender, conversationId, content, opts),
  );

  ipcMain.handle(IpcChannels.agentRun, (e, conversationId: string, content: string, opts: SendOpts = {}) =>
    runSend(e.sender, conversationId, content, { ...opts, mode: 'agent', explicit: true }),
  );

  // Built-in computer-use agent: start returns a runId immediately; AgentEvents
  // stream back via the agentEvent push channel. Renderer never gets shell access.
  ipcMain.handle(IpcChannels.agentStart, async (e, conversationId: string, content: string, opts: { cwd?: string } = {}) => {
    const d = db();
    const s = getSettings(d);
    addMessage(d, conversationId, 'user', content);
    const history = getMessages(d, conversationId);
    const key = getSecret(d, apiKeyService(s.provider)) || process.env[`${s.provider.toUpperCase()}_API_KEY`] || '';
    const controller = new AbortController();
    const runId = `agent-${Date.now()}-${++seq}`;
    const state: AgentRunState = { controller, approvals: new Map() };
    agentRuns.set(runId, state);
    const sender = e.sender;
    const emit = (event: AgentEvent) => {
      try { sender.send(IpcChannels.agentEvent, { runId, event }); } catch { /* window gone */ }
    };
    void (async () => {
      try {
        const cwd = opts.cwd || s.agentCwd || os.homedir();
        routeStatus(sender, runId, 'doing');
        const full = await runBuiltInAgent({
          sender, d, s, key, content, history, cwd, runId,
          controller, state, prompt: content,
        });
        if (full) addMessage(d, conversationId, 'assistant', full);
        finishRun(d, sender, runId, 'agent', content, full, controller.signal.aborted ? 'stopped' : 'done', cwd);
      } catch (e2) {
        emit({ type: 'error', message: asError(e2).message.slice(0, 500) });
        finishRun(d, sender, runId, 'agent', content, asError(e2).message, 'error', opts.cwd || s.agentCwd || os.homedir());
      } finally {
        agentRuns.delete(runId);
      }
    })();
    return { runId };
  });

  ipcMain.handle(IpcChannels.agentApprove, (_e, runId: string, callId: string, decision: ApprovalDecision) => {
    const resolve = agentRuns.get(runId)?.approvals.get(callId);
    if (!resolve) throw new Error('No pending approval for this action');
    if (decision !== 'allow-once' && decision !== 'deny' && decision !== 'always') throw new Error('Bad decision');
    resolve({ decision });
    return true;
  });

  ipcMain.on(IpcChannels.agentStop, (_e, runId?: string) => {
    if (runId) agentRuns.get(runId)?.controller.abort();
    else stopAllAgentRuns();
  });

  ipcMain.handle(IpcChannels.agentLog, () => getLatestLog());

  ipcMain.handle(IpcChannels.agentPickFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] || null);
  });

  ipcMain.handle(IpcChannels.platform, () => platformInfo());
  ipcMain.handle(IpcChannels.hotkeyStatus, () => getHotkeyStatus());
  ipcMain.handle(IpcChannels.setHotkey, (_e, hotkey: string) => {
    const out = updateSettings(db(), { hotkey });
    refreshToggleHotkey(() => togglePopup());
    return { ...getHotkeyStatus(), hotkey: out.hotkey };
  });
  ipcMain.handle(IpcChannels.openPrivacySettings, async () => {
    // macOS Files and Folders pane; other platforms have no equivalent.
    if (platform().key !== 'darwin') return false;
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IpcChannels.defaultFolders, () => {
    const home = os.homedir();
    return ['Desktop', 'Documents', 'Downloads'].map((d) => {
      try {
        return fs.realpathSync(path.join(home, d));
      } catch {
        return path.join(home, d);
      }
    });
  });

  ipcMain.handle(IpcChannels.runs, () => listRuns(50));

  ipcMain.handle(IpcChannels.reveal, async (_e, dir: string) => {
    try {
      if (typeof dir !== 'string' || !dir.trim()) return false;
      const err = await shell.openPath(dir);
      return !err;
    } catch {
      return false;
    }
  });

  // Undo a run's reversible ops in reverse order, through the normal
  // permission layer (approvals + policy apply to every reversal).
  ipcMain.handle(IpcChannels.undo, async (e, runId: string) => {
    const d = db();
    const s = getSettings(d);
    const cwd = s.agentCwd || os.homedir();
    const controller = new AbortController();
    const undoRunId = `undo-${Date.now()}-${++seq}`;
    const state: AgentRunState = { controller, approvals: new Map() };
    agentRuns.set(undoRunId, state);
    const sender = e.sender;
    const emit = (event: AgentEvent) => {
      try { sender.send(IpcChannels.agentEvent, { runId: undoRunId, event }); } catch { /* window gone */ }
    };
    const wlog = createRunLog();
    const emitLogged = (event: AgentEvent) => {
      try { appendLog(wlog.path, { runId: undoRunId, event }); } catch { /* never break */ }
      emit(event);
    };
    void (async () => {
      try {
        const ext = extService(d);
        let extras: { tools: Tool[] } = { tools: [] };
        try {
          extras = await ext.agentExtras();
        } catch { /* undo with built-ins only */ }
        const tools = [...ALL_TOOLS, ...extras.tools];
        const map = new Map(tools.map((t) => [t.name, t]));
        const messages: AgentMsg[] = [];
        const limits = DEFAULT_LIMITS;
        const start = Date.now();
        const st: ToolExecState = {
          cwd,
          policy: policyFor(s, cwd),
          limits,
          signal: controller.signal,
          emit: emitLogged,
          messages,
          waitForApproval: approvalWaiter(state),
          onPersistAlwaysRule: persistRule(d),
          hooks: ext.hookRunner(cwd, controller.signal),
          logHook: (rec) => {
            try { appendLog(wlog.path, { runId: undoRunId, ...rec }); } catch { /* never break */ }
          },
          checkRunTimeout: () => Date.now() - start - st.approvalWaitMs > limits.runTimeoutMs,
          toolCalls: 0,
          approvalWaitMs: 0,
          lastUntrusted: null,
        };
        emitLogged({ type: 'step', id: `${undoRunId}-begin`, text: 'Undoing…' });
        const report = await undoRun(runId, st, map);
        const lines = [
          ...report.undone.map((u) => `Undone: ${u}`),
          ...report.failed.map((f) => `Not undone: ${f}`),
        ];
        const text = lines.length ? lines.join('\n') : 'Nothing to undo.';
        emitLogged({ type: 'text_delta', text });
        emitLogged({ type: 'done', summary: text.slice(0, 500) });
      } catch (e2) {
        if (controller.signal.aborted) emitLogged({ type: 'stopped' });
        else emitLogged({ type: 'error', message: asError(e2).message.slice(0, 500) });
      } finally {
        agentRuns.delete(undoRunId);
      }
    })();
    return { runId: undoRunId };
  });

  // ---------- Extensions: one typed dispatch channel (main-process only) ----------
  ipcMain.handle(IpcChannels.ext, async (e, a: ExtAction) => {
    const d = db();
    const ext = extService(d);
    try {
      switch (a.action) {
        case 'list':
          return {
            records: ext.store.list(),
            mcp: ext.mcpStatuses(),
            hooks: ext.store.readHooksFile().map((h) => ({ ...h, commandDisplay: hookDisplayCommand(h) })),
          };
        case 'preview':
          return ext.store.preview(toSourceInput(a.source));
        case 'install': {
          const r = await ext.store.install(toSourceInput(a.source), { enable: a.enable });
          return r;
        }
        case 'enable':
          return ext.store.enable(a.id, { trustAccepted: a.trustAccepted });
        case 'trust':
          ext.store.trust(a.id);
          return { trusted: true };
        case 'disable':
          ext.store.disable(a.id);
          // Disabled servers stop immediately; tools vanish on next composition.
          try {
            const rec = ext.store.get(a.id);
            if (rec?.kind === 'mcp') {
              for (const srv of rec.servers || []) await ext.mcp.stop(srv);
            }
          } catch { /* best-effort */ }
          return { disabled: true };
        case 'updatePreview':
          return ext.store.updatePreview(a.id, toSourceInput(a.source));
        case 'update':
          return ext.store.update(a.id, toSourceInput(a.source));
        case 'remove':
          try {
            const rec = ext.store.get(a.id);
            if (rec?.kind === 'mcp') {
              for (const srv of rec.servers || []) await ext.mcp.stop(srv);
            }
          } catch { /* best-effort */ }
          ext.store.remove(a.id);
          return { removed: true };
        case 'source':
          return ext.store.readSource(a.id);
        case 'skillBody': {
          const rec = ext.store.get(`skill:${a.name}`);
          if (!rec || !rec.enabled) throw new Error(`skill not enabled: ${a.name}`);
          const loc = ext.store.location(rec);
          if (!loc) throw new Error(`skill not enabled: ${a.name}`);
          return fs.readFileSync(`${loc}/SKILL.md`, 'utf8');
        }
        case 'mcp': {
          if (a.op === 'info') return ext.mcp.trustInfo(a.server);
          if (a.op === 'restart') await ext.mcp.restart(a.server);
          else if (a.op === 'stop') await ext.mcp.stop(a.server);
          else {
            const owner = ext.store.list().find((r) => r.kind === 'mcp' && (r.servers || []).includes(a.server));
            if (!owner) throw new Error(`unknown MCP server: ${a.server}`);
            ext.store.trust(owner.id); // explicit "Trust and start"
            await ext.mcp.ensure(a.server);
          }
          return ext.mcpStatuses();
        }
        case 'mcpToolPolicy': {
          const owner = ext.store.list().find((r) => r.kind === 'mcp' && (r.servers || []).includes(a.server));
          if (!owner) throw new Error(`unknown MCP server: ${a.server}`);
          const toolPolicy = { ...(owner.toolPolicy || {}) };
          const full = `mcp__${a.server}__${a.tool}`;
          if (a.policy === 'ask') delete toolPolicy[full];
          else toolPolicy[full] = a.policy;
          ext.store.updateRecord(owner.id, { toolPolicy });
          return { ok: true };
        }
        case 'mcpPrompt': {
          let server = a.server || '';
          let prompt = a.prompt || '';
          if (a.trigger && (!server || !prompt)) {
            for (const st of ext.mcp.statuses()) {
              if (st.status !== 'ready') continue;
              for (const p of st.prompts) {
                if (`/mcp-${st.name}-${p.name}` === a.trigger) { server = st.name; prompt = p.name; }
              }
            }
          }
          if (!server || !prompt) throw new Error('MCP prompt not found (start its server first)');
          const client = await ext.mcp.ensure(server);
          return client.getPrompt(prompt);
        }
        case 'workflowInfo': {
          for (const { raw } of readInstalledWorkflows(ext.store)) {
            const doc = parseWorkflowDoc(raw);
            const wf = doc.workflow;
            if (wf.trigger === a.trigger) {
              return doc.kind === 'ext'
                ? { kind: 'ext' as const, inputs: doc.workflow.inputs, title: wf.title }
                : { kind: 'legacy' as const, inputs: [] };
            }
          }
          return null;
        }
        case 'workflowRun':
          return runExtWorkflowRun(e.sender, a.trigger, a.inputs || {});
        case 'hookSet': {
          const hooks = ext.store.readHooksFile();
          const want = typeof a.command === 'string' ? a.command : JSON.stringify(a.command);
          const ix = hooks.findIndex((h) => h.event === a.event && hookCommandKey(h.command) === want && (h.extId || undefined) === a.extId);
          if (ix >= 0) {
            if (a.extId) hooks[ix].enabled = a.enabled; // ext hook commands change only via update
            else if (!a.enabled) hooks.splice(ix, 1);
          } else if (!a.extId && a.enabled) {
            const { hooks: valid, errors } = validateHooksJson([{ event: a.event, command: a.command, matcher: a.matcher, enabled: true }]);
            if (errors.length) throw new Error(errors.join('; '));
            hooks.push(...valid);
          }
          ext.store.writeHooksFile(hooks);
          return ext.store.readHooksFile();
        }
        case 'export': {
          const rec = ext.store.get(a.id);
          if (!rec || rec.kind !== 'workflow') throw new Error('only workflows export as a file');
          const loc = ext.store.location(rec);
          if (!loc) throw new Error('workflow file missing');
          return { filename: `${rec.name}.workflow.json`, content: fs.readFileSync(loc, 'utf8') };
        }
        case 'pickFile': {
          const r = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
              { name: 'Extension files', extensions: ['zip', 'json', 'md'] },
              { name: 'All files', extensions: ['*'] },
            ],
          });
          return r.canceled ? null : (r.filePaths[0] || null);
        }
        default:
          throw new Error(`unknown ext action: ${(a as { action: string }).action}`);
      }
    } catch (err) {
      throw asError(err);
    }
  });

  refreshStopHotkey();
}
