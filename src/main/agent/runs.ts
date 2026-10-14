import fs from 'node:fs';
import path from 'node:path';
import { resolveDbPath } from '../db/db';

export interface RunRecord {
  runId: string;
  kind: 'agent' | 'workflow';
  prompt: string;
  outcome: string;
  ts: number;
  status: 'done' | 'error' | 'stopped';
  undoable: boolean;
  /** Execution engine; only built-in exists (unrelated to the purged settings key). */
  engine?: 'builtin';
  /** Task family (Tasks view groups subtasks under their parent). */
  taskId?: string;
  parentId?: string | null;
  origin?: string;
}

function runsFile(userDataPath?: string): string {
  return path.join(path.dirname(resolveDbPath(userDataPath)), 'runs.jsonl');
}

/** One-line outcome for the Run Log view. Never claims more than happened. */
export function oneLineOutcome(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

export function recordRun(rec: RunRecord, userDataPath?: string): void {
  try {
    fs.appendFileSync(runsFile(userDataPath), JSON.stringify({ ...rec, engine: rec.engine ?? 'builtin' }) + '\n', 'utf8');
  } catch { /* history must never break runs */ }
}

export function listRuns(limit = 50, userDataPath?: string): RunRecord[] {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(runsFile(userDataPath), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const line of lines.slice(-Math.max(limit, 1) * 2)) {
    try {
      const rec = JSON.parse(line) as RunRecord;
      if (!rec.engine) rec.engine = 'builtin'; // history written before the literal
      out.push(rec);
    } catch { /* skip corrupt line */ }
  }
  return out.slice(-limit).reverse();
}
