import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, executeToolCall, type ToolExecState } from '../../src/main/agent/loop';
import type { AgentEvent, ApprovalOutcome, Tool } from '../../src/main/agent/types';
import { DEFAULT_LIMITS } from '../../src/main/agent/types';
import type { PolicyContext } from '../../src/main/agent/permissions';
import { fsWriteTool } from '../../src/main/agent/tools/fs_write';
import { fsReadTool } from '../../src/main/agent/tools/fs_read';
import { fsMoveTool } from '../../src/main/agent/tools/fs_move';
import { fsCopyTool } from '../../src/main/agent/tools/fs_copy';
import { fsTrashTool } from '../../src/main/agent/tools/fs_trash';
import { shellRunTool } from '../../src/main/agent/tools/shell_run';
import { clipboardWriteTool } from '../../src/main/agent/tools/clipboard_write';
import { __setClipboardBackend } from '../../src/main/agent/tools/clipboard';
import { recordRun, listRuns } from '../../src/main/agent/runs';
import { loadJournal, undoAvailable, undoRun } from '../../src/main/agent/undo';
import { resolveDbPath } from '../../src/main/db/db';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-bughunt-'));
const home = os.homedir();
const REAL_TOOLS: Tool[] = [fsWriteTool, fsReadTool, fsMoveTool, fsCopyTool, fsTrashTool, shellRunTool, clipboardWriteTool];
const toolMap = new Map(REAL_TOOLS.map((t) => [t.name, t]));

function toolTurn(calls: Array<{ id: string; name: string; input: unknown }>, text = ''): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: text,
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      },
    }],
  }), { status: 200 });
}
function finalTurn(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}
function scriptFetch(script: Response[]): typeof fetch {
  let i = 0;
  return (async () => script[Math.min(i++, script.length - 1)]) as unknown as typeof fetch;
}

interface RunOpts {
  decisions?: Array<'allow-once' | 'deny' | 'always'>;
  hooks?: ToolExecState['hooks'];
  signal?: AbortSignal;
  undoDir?: string;
  runId?: string;
  requireApprovalForWrites?: boolean;
}

function baseState(dir: string, events: AgentEvent[], o: RunOpts = {}): ToolExecState {
  let n = 0;
  const decisions = o.decisions || [];
  return {
    cwd: dir,
    policy: {
      allowedRoots: [dir], explicitRoots: [], alwaysAllow: [],
      requireApprovalForWrites: o.requireApprovalForWrites ?? true, homeDir: home,
    } as PolicyContext,
    limits: DEFAULT_LIMITS,
    signal: o.signal,
    emit: (e) => events.push(e),
    messages: [],
    waitForApproval: async () => ({ decision: decisions[Math.min(n++, decisions.length - 1)] || 'allow-once' }),
    hooks: o.hooks ?? null,
    checkRunTimeout: () => false,
    toolCalls: 0,
    approvalWaitMs: 0,
    lastUntrusted: null,
  };
}

function runReal(prompt: string, dir: string, script: Response[], o: RunOpts & { events?: AgentEvent[] } = {}) {
  const events: AgentEvent[] = o.events || [];
  const persisted: unknown[] = [];
  const run = runAgent(prompt, {
    provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
    allowedRoots: [dir],
    requireApprovalForWrites: o.requireApprovalForWrites ?? true,
    fetchFn: scriptFetch(script),
    logDir: tmpRoot(),
    emit: (e) => events.push(e),
    waitForApproval: (() => {
      let n = 0;
      const ds = o.decisions || [];
      return async () => ({ decision: ds[Math.min(n++, ds.length - 1)] || 'allow-once' });
    })(),
    onPersistAlwaysRule: (r) => persisted.push(r),
    tools: REAL_TOOLS,
    hooks: o.hooks ?? null,
    signal: o.signal,
    runId: o.runId,
    undoDir: o.undoDir,
  });
  return { events, persisted, run };
}

describe('integration: real fs write/read roundtrip with approval', () => {
  it('writes a file after allow-once and journals it', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const p = path.join(dir, 'hello.txt');
    const { events, run } = runReal('write hi', dir, [
      toolTurn([{ id: 'c1', name: 'fs_write', input: { path: p, content: 'hi there' } }]),
      finalTurn('wrote it'),
    ], { decisions: ['allow-once'], runId: 'bh-write-1', undoDir: udir });
    await expect(run).resolves.toBe('wrote it');
    expect(fs.readFileSync(p, 'utf8')).toBe('hi there');
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    const j = loadJournal('bh-write-1', udir);
    expect(j?.entries).toHaveLength(1);
    expect(j?.entries[0]).toMatchObject({ tool: 'fs_write', undoable: true });
  });

  it('denied write leaves no file and no journal', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const p = path.join(dir, 'nope.txt');
    const { events, run } = runReal('write it', dir, [
      toolTurn([{ id: 'c1', name: 'fs_write', input: { path: p, content: 'x' } }]),
      finalTurn('ok, skipped'),
    ], { decisions: ['deny'], runId: 'bh-write-2', undoDir: udir });
    await expect(run).resolves.toBe('ok, skipped');
    expect(fs.existsSync(p)).toBe(false);
    expect(loadJournal('bh-write-2', udir)).toBeNull();
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
  });
});

describe('integration: unicode filenames end to end', () => {
  it('writes, reads, moves and trashes "báo cáo 2026.txt" and "Café.txt"', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const a = path.join(dir, 'báo cáo 2026.txt');
    const b = path.join(dir, 'Café.txt');
    const moved = path.join(dir, 'moved-cafe.txt');
    const st = baseState(dir, [], { decisions: ['allow-once'], requireApprovalForWrites: false });
    expect(await executeToolCall(fsWriteTool, 'fs_write', { path: a, content: 'nội dung' }, 'u1', st)).toBe('ran');
    expect(await executeToolCall(fsWriteTool, 'fs_write', { path: b, content: 'x' }, 'u2', st)).toBe('ran');
    const r = await fsReadTool.run({ path: a }, { signal: new AbortController().signal, cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('nội dung');
    expect(await executeToolCall(fsMoveTool, 'fs_move', { from: b, to: moved }, 'u3', st)).toBe('ran');
    expect(fs.existsSync(moved)).toBe(true);
    expect(await executeToolCall(fsTrashTool, 'fs_trash', { path: moved }, 'u4', st)).toBe('ran');
    expect(fs.existsSync(moved)).toBe(false);
  });
});

describe('integration: symlink escape is denied at the boundary', () => {
  it('refuses to read through a link pointing outside roots', async () => {
    const dir = tmpRoot();
    const outside = tmpRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'shh');
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'));
    } catch {
      return; // no symlink privilege; platform matrix covers the rule
    }
    const st = baseState(dir, []);
    const out = await executeToolCall(
      fsReadTool, 'fs_read', { path: path.join(dir, 'link', 'secret.txt') }, 'u1', st);
    expect(out).toBe('denied');
    expect(st.messages.at(-1)?.content).toMatch(/blocked path/);
  });
});

describe('integration: abort during approval cancels the run', () => {
  it('aborted wait rejects and nothing executes', async () => {
    const dir = tmpRoot();
    const ctrl = new AbortController();
    const p = path.join(dir, 'x.txt');
    const events: AgentEvent[] = [];
    const run = runAgent('write it', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir],
      fetchFn: scriptFetch([
        toolTurn([{ id: 'c1', name: 'fs_write', input: { path: p, content: 'x' } }]),
        finalTurn('never'),
      ]),
      logDir: tmpRoot(),
      emit: (e) => events.push(e),
      // Hanging approval: only the abort can resolve it.
      waitForApproval: () => new Promise<ApprovalOutcome>(() => {}),
      tools: REAL_TOOLS,
      signal: ctrl.signal,
      runId: 'bh-abort-1',
      undoDir: tmpRoot(),
    });
    setTimeout(() => ctrl.abort(), 300);
    await expect(run).resolves.toBe('');
    expect(fs.existsSync(p)).toBe(false);
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
  });
});

describe('integration: unknown model tool calls do not break the loop', () => {
  it('reports unknown tool and still returns the final text', async () => {
    const dir = tmpRoot();
    const { events, run } = runReal('do stuff', dir, [
      toolTurn([{ id: 'c1', name: 'nope_not_real', input: {} }]),
      finalTurn('all done'),
    ], { runId: 'bh-unknown-1', undoDir: tmpRoot() });
    await expect(run).resolves.toBe('all done');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
  });
});

describe('integration: hook force-approval upgrades auto reads', () => {
  it('emits approval_request even when policy says auto', async () => {
    const dir = tmpRoot();
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'data');
    const { events, run } = runReal('read it', dir, [
      toolTurn([{ id: 'c1', name: 'fs_read', input: { path: p } }]),
      finalTurn('read it'),
    ], {
      decisions: ['allow-once'],
      hooks: (async () => ({ verdict: { action: 'force-approval' }, records: [] })) as ToolExecState['hooks'],
      runId: 'bh-force-1', undoDir: tmpRoot(),
    });
    await expect(run).resolves.toBe('read it');
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
  });
});

describe('integration: always-allow persists and reuses', () => {
  it('second identical shell call auto-runs', async () => {
    const dir = tmpRoot();
    const cmd = `echo ${Date.now()}-exact`;
    const persisted: unknown[] = [];
    const mkWaiter = () => {
      let n = 0;
      const ds: Array<'allow-once' | 'deny' | 'always'> = ['always', 'allow-once'];
      return async () => ({ decision: ds[Math.min(n++, ds.length - 1)] as 'allow-once' | 'deny' | 'always' });
    };
    const events: AgentEvent[] = [];
    const run = runAgent('run twice', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], fetchFn: scriptFetch([
        toolTurn([{ id: 'c1', name: 'shell_run', input: { command: cmd } }]),
        toolTurn([{ id: 'c2', name: 'shell_run', input: { command: cmd } }]),
        finalTurn('twice'),
      ]),
      logDir: tmpRoot(), emit: (e) => events.push(e),
      waitForApproval: mkWaiter(),
      onPersistAlwaysRule: (r) => persisted.push(r),
      tools: REAL_TOOLS, runId: 'bh-always-1', undoDir: tmpRoot(),
    });
    await expect(run).resolves.toBe('twice');
    expect(persisted).toHaveLength(1);
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
  });
});

describe('integration: undo roundtrip through the real layer', () => {
  it('move is journaled and moved back with content intact', async () => {
    const dir = tmpRoot();
    const udir = tmpRoot();
    const from = path.join(dir, 'orig.txt');
    const to = path.join(dir, 'moved.txt');
    fs.writeFileSync(from, 'payload-123');
    const { run } = runReal('move it', dir, [
      toolTurn([{ id: 'c1', name: 'fs_move', input: { from, to } }]),
      finalTurn('moved'),
    ], { decisions: ['allow-once'], runId: 'bh-undo-1', undoDir: udir });
    await expect(run).resolves.toBe('moved');
    expect(fs.existsSync(to)).toBe(true);
    const st = baseState(dir, [], { decisions: ['allow-once'], requireApprovalForWrites: false });
    const report = await undoRun('bh-undo-1', st, toolMap, udir);
    expect(report.failed).toEqual([]);
    expect(report.undone).toHaveLength(1);
    expect(fs.readFileSync(from, 'utf8')).toBe('payload-123');
    expect(fs.existsSync(to)).toBe(false);
    // repeat: idempotent no-op
    const report2 = await undoRun('bh-undo-1', st, toolMap, udir);
    expect(report2.undone).toHaveLength(0);
    expect(report2.failed.join(' ')).toMatch(/already undone/);
  });
});

describe('integration: runs history tolerates corruption', () => {
  it('skips bad lines and returns newest first', () => {
    const userDir = tmpRoot();
    recordRun({ runId: 'r1', kind: 'agent', prompt: 'a', outcome: 'o1', ts: 1, status: 'done', undoable: false }, userDir);
    fs.appendFileSync(`${userDir}/runs.jsonl`, 'not-json{{{\n');
    recordRun({ runId: 'r2', kind: 'agent', prompt: 'b', outcome: 'o2', ts: 2, status: 'error', undoable: false }, userDir);
    const list = listRuns(50, userDir);
    expect(list.map((r) => r.runId)).toEqual(['r2', 'r1']);
  });
  it('resolveDbPath honors the data dir override', () => {
    const userDir = tmpRoot();
    expect(resolveDbPath(userDir)).toBe(path.join(userDir, 'nexio.db'));
  });
});
