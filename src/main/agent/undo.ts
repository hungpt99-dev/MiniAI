import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath } from '../db/db';
import { clipboardRead } from './tools/clipboard';
import { platform } from '../platform/index';
import { fsMoveTool } from './tools/fs_move';
import { fsTrashTool } from './tools/fs_trash';
import { clipboardWriteTool } from './tools/clipboard_write';
import type { Tool, AgentEvent } from './types';
import type { ToolExecState } from './loop';
import { executeToolCall } from './loop';

/** Tools with reliable compensation. shell_run and MCP tools are never journaled. */
export const UNDOABLE_TOOLS = new Set(['fs_move', 'fs_copy', 'fs_write', 'fs_trash', 'clipboard_write']);

export interface UndoEntry {
  id: string;
  tool: string;
  summary: string;
  ts: number;
  undoable: boolean;
  reason?: string;
  data?: Record<string, unknown>;
  undone?: boolean;
  undoneTs?: number;
  undoNote?: string;
}

export interface UndoJournal {
  runId: string;
  prompt: string;
  entries: UndoEntry[];
}

export function resolveUndoDir(userDataPath?: string): string {
  const dir = path.join(path.dirname(resolveDbPath(userDataPath)), 'undo');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function journalPath(runId: string, dir?: string): string {
  return path.join(dir || resolveUndoDir(), `${runId}.json`);
}

export function loadJournal(runId: string, dir?: string): UndoJournal | null {
  try {
    return JSON.parse(fs.readFileSync(journalPath(runId, dir), 'utf8')) as UndoJournal;
  } catch {
    return null;
  }
}

function saveJournal(j: UndoJournal, dir?: string): void {
  fs.mkdirSync(dir || resolveUndoDir(), { recursive: true });
  fs.writeFileSync(journalPath(j.runId, dir), JSON.stringify(j, null, 1));
}

function fingerprint(p: string): { size: number; mtimeMs: number; isDir: boolean } | null {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

/**
 * Capture recovery info BEFORE the operation runs. Returns null for tools
 * without reliable compensation (shell_run, MCP tools, reads).
 */
export async function capturePreOp(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; undoable: boolean; reason?: string } | null> {
  if (!UNDOABLE_TOOLS.has(toolName)) return null;
  if (toolName === 'fs_move') {
    const from = String(input.from || '');
    const fp = fingerprint(from);
    if (!fp) return { undoable: false, reason: `source is gone: ${from}` };
    return { data: { from, to: String(input.to || '') }, undoable: true };
  }
  if (toolName === 'fs_copy' || toolName === 'fs_write') {
    const p = String(toolName === 'fs_copy' ? input.to : input.path || '');
    if (fingerprint(p)) {
      return { undoable: false, reason: `already existed, refusing to auto-remove: ${p}` };
    }
    return { data: { path: p }, undoable: true };
  }
  if (toolName === 'fs_trash') {
    // OS trash restore is platform UI, not an API: record, report honestly.
    const word = platform().trashWord;
    return {
      data: { path: String(input.path || '') },
      undoable: false,
      reason: `Restore it from the ${word} manually — automatic restore is not supported.`,
    };
  }
  if (toolName === 'clipboard_write') {
    const prev = await clipboardRead();
    if (!prev.ok) return { undoable: false, reason: 'previous clipboard state is unavailable' };
    return { data: { previous: prev.output }, undoable: true };
  }
  return null;
}

/** Append a journal entry after a successful op. Skipped on failure. */
export function recordOp(
  runId: string,
  prompt: string,
  tool: Tool,
  input: Record<string, unknown>,
  pre: { data?: Record<string, unknown>; undoable: boolean; reason?: string },
  dir?: string,
): void {
  // Snapshot created files now, so undo can refuse if they changed later.
  if (pre.undoable && (tool.name === 'fs_copy' || tool.name === 'fs_write') && pre.data) {
    const p = String((pre.data as { path?: string }).path || '');
    const fp = p ? fingerprint(p) : null;
    if (fp) pre.data = { ...pre.data, size: fp.size, mtimeMs: fp.mtimeMs, isDir: fp.isDir };
  }
  const j: UndoJournal = loadJournal(runId, dir) || { runId, prompt, entries: [] };
  j.entries.push({
    id: `u${Date.now()}-${j.entries.length}`,
    tool: tool.name,
    summary: tool.describe(input),
    ts: Date.now(),
    undoable: pre.undoable,
    reason: pre.reason,
    data: pre.data,
  });
  try {
    saveJournal(j, dir);
  } catch { /* journal must never break the run */ }
}

export function undoAvailable(runId: string, dir?: string): boolean {
  const j = loadJournal(runId, dir);
  return !!j && j.entries.some((e) => e.undoable && !e.undone);
}

/** Primary folder touched by a run (for the Open folder chip), else cwd. */
export function undoFolder(runId: string, cwd: string, dir?: string): string {
  const j = loadJournal(runId, dir);
  const p = j?.entries.find((e) => e.undoable && !e.undone && e.data)?.data;
  const file = p && (typeof p.path === 'string' ? p.path : typeof p.to === 'string' ? p.to : undefined);
  if (file) {
    try {
      return path.dirname(path.resolve(file));
    } catch { /* fall through */ }
  }
  return cwd;
}

export interface UndoReport {
  undone: string[];
  failed: string[];
}

function sameFile(fp: { size: number; mtimeMs: number } | null, p: string): boolean {
  const now = fingerprint(p);
  return !!fp && !!now && !now.isDir && now.size === fp.size && now.mtimeMs === fp.mtimeMs;
}

/**
 * Reverse a run's reversible ops in reverse order through the normal
 * permission layer (approvals + policy apply). Idempotent: repeated runs
 * skip already-undone entries.
 */
export async function undoRun(
  runId: string,
  st: ToolExecState,
  tools: Map<string, Tool>,
  dir?: string,
): Promise<UndoReport> {
  const report: UndoReport = { undone: [], failed: [] };
  const j = loadJournal(runId, dir);
  if (!j) return { undone: [], failed: ['no journal for this run'] };
  const emit = st.emit;
  let i = j.entries.length;
  for (const entry of [...j.entries].reverse()) {
    i--;
    const callId = `undo-${runId}-${i}`;
    if (entry.undone) {
      report.failed.push(`${entry.summary}: already undone`);
      continue;
    }
    if (!entry.undoable) {
      report.failed.push(`${entry.summary}: ${entry.reason || 'not reversible'}`);
      continue;
    }
    emit({ type: 'step', id: `${callId}-s`, text: `Undoing: ${entry.summary}` } as AgentEvent);
    try {
      if (entry.tool === 'fs_move' && entry.data) {
        const { from, to } = entry.data as { from: string; to: string };
        if (!fingerprint(to)) throw new Error(`moved file is gone: ${to}`);
        if (fingerprint(from)) throw new Error(`original location is occupied: ${from}`);
        const tool = tools.get('fs_move') || fsMoveTool;
        const out = await executeToolCall(tool, 'fs_move', { from: to, to: from }, callId, st);
        if (out !== 'ran') throw new Error('move-back was denied or failed');
      } else if ((entry.tool === 'fs_copy' || entry.tool === 'fs_write') && entry.data) {
        const d = entry.data as { path: string; size?: number; mtimeMs?: number; isDir?: boolean };
        const p = String(d.path || '');
        const fp = fingerprint(p);
        if (!fp) throw new Error(`file is already gone: ${p}`);
        if (!fp.isDir && (typeof d.size !== 'number' || !sameFile({ size: d.size, mtimeMs: d.mtimeMs ?? -1 }, p))) {
          throw new Error(`changed since the run, left in place: ${p}`);
        }
        const out = await executeToolCall(tools.get('fs_trash') || fsTrashTool, 'fs_trash', { path: p }, callId, st);
        if (out !== 'ran') throw new Error('trash was denied or failed');
      } else if (entry.tool === 'clipboard_write' && entry.data) {
        const out = await executeToolCall(
          tools.get('clipboard_write') || clipboardWriteTool,
          'clipboard_write', { text: String((entry.data as { previous: string }).previous || '') }, callId, st);
        if (out !== 'ran') throw new Error('clipboard restore was denied or failed');
      } else {
        throw new Error('unsupported entry');
      }
      entry.undone = true;
      entry.undoneTs = Date.now();
      report.undone.push(entry.summary);
    } catch (e) {
      const msg = (e as Error).message;
      entry.undoNote = msg;
      report.failed.push(`${entry.summary}: ${msg}`);
    }
    try {
      saveJournal(j, dir);
    } catch { /* keep going */ }
  }
  return report;
}
