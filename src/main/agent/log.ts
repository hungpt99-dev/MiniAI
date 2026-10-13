import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../store/secrets';
import { resolveDbPath, APP_NAME } from '../db/db';
import { platform } from '../platform/index';

/** Extra secret shapes beyond redact(): password=..., api_secret, long hex/bearer tokens. */
export function redactSecrets(text: string): string {
  return redact(text)
    .replace(/(password\s*[:=]\s*)([^\s'"]+)/gi, '$1***')
    .replace(/(api[_-]?secret["'\s:=]+)([A-Za-z0-9._-]+)/gi, '$1***')
    .replace(/\b(Bearer\s+[A-Za-z0-9._~+/-]+=*)/gi, 'Bearer ***');
}

export function resolveLogDir(userDataPath?: string): string {
  // Spec: app.getPath('logs'); tests pass an explicit dir and keep local behavior.
  const dir = userDataPath
    ? path.join(path.dirname(resolveDbPath(userDataPath)), 'agent-logs')
    : path.join(platform().defaultLogsDir(APP_NAME, resolveDbPath()), 'agent-logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface RunLog {
  runId: string;
  path: string;
}

/** Create a per-run JSONL log. Every event is redacted before append — never log API keys. */
export function createRunLog(logDir?: string, runId?: string): RunLog {
  const dir = logDir || resolveLogDir();
  const id = runId || `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { runId: id, path: path.join(dir, `${id}.jsonl`) };
}

export function appendLog(logPath: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), ...JSON.parse(redactSecrets(JSON.stringify(event))) });
  fs.appendFileSync(logPath, line + '\n', 'utf8');
}

export function getLatestLog(logDir?: string): { path: string; content: string } | null {
  const dir = logDir || resolveLogDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  files.sort().reverse();
  const p = path.join(dir, files[0]);
  try {
    return { path: p, content: fs.readFileSync(p, 'utf8') };
  } catch {
    return null;
  }
}
