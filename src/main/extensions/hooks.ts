import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '../agent/log';
import { isAdminCommand } from '../agent/tools/shell_run';
import { platform, type PlatformAdapter } from '../platform/index';
import type { TrustInfo } from './types';

export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'ApprovalRequested'
  | 'RunStopped'
  | 'RunDone';

export const HOOK_EVENTS: HookEventName[] = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'ApprovalRequested', 'RunStopped', 'RunDone',
];

/** Events where a hook may BLOCK. Everywhere else a nonzero exit is just a warning. */
const BLOCKABLE: HookEventName[] = ['UserPromptSubmit', 'PreToolUse'];

export interface HookDef {
  event: HookEventName;
  /** Tool name glob, e.g. "shell_*" (PreToolUse/PostToolUse/ApprovalRequested only). */
  matcher?: string;
  /** Plain string, or per-platform commands (trust dialog shows the current OS one). */
  command: string | { win32?: string; darwin?: string };
  timeoutMs?: number;
  enabled?: boolean;
  /** Extension that owns this entry; undefined = user hook. */
  extId?: string;
}

export type HookVerdict =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'force-approval' };

export interface HookResult {
  verdict: HookVerdict;
  /** Redacted run records; the caller writes them to the action log. */
  records: Array<HookRunRecord & { event: HookEventName }>;
}

export type HookRunner = (event: HookEventName, payload: Record<string, unknown>) => Promise<HookResult>;

export interface HookRunRecord {
  command: string;
  event: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const IO_CAP = 4000;

/** Resolve a plain or per-platform hook command for the current OS. */
export function resolveHookCommand(cmd: string | { win32?: string; darwin?: string }, adapter: PlatformAdapter = platform()): string {
  if (typeof cmd === 'string') return cmd.trim();
  const pick = adapter.key === 'win32' ? (cmd.win32 || cmd.darwin) : (cmd.darwin || cmd.win32);
  if (!pick || !pick.trim()) throw new Error('hook has no command for this platform');
  return pick.trim();
}

/** Stable key for hook identity (string or per-platform object). */
export function hookCommandKey(cmd: string | { win32?: string; darwin?: string }): string {
  return typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
}

export function validateHooksJson(value: unknown): { hooks: HookDef[]; errors: string[] } {
  const errors: string[] = [];
  const list = Array.isArray(value) ? value : (value as { hooks?: unknown })?.hooks;
  if (!Array.isArray(list)) return { hooks: [], errors: ['hooks.json must be an array of hook entries'] };
  const hooks: HookDef[] = [];
  list.forEach((h, i) => {
    const o = h as Record<string, unknown>;
    if (!o || typeof o !== 'object') { errors.push(`hook ${i}: not an object`); return; }
    if (!HOOK_EVENTS.includes(o.event as HookEventName)) { errors.push(`hook ${i}: bad event ${String(o.event)}`); return; }
    const rawCmd = o.command as HookDef['command'];
    let commands: string[];
    if (typeof rawCmd === 'string') {
      if (!rawCmd.trim()) { errors.push(`hook ${i}: command required`); return; }
      commands = [rawCmd.trim()];
    } else if (rawCmd && typeof rawCmd === 'object') {
      commands = [rawCmd.win32, rawCmd.darwin].filter((c): c is string => typeof c === 'string' && !!c.trim());
      if (!commands.length) { errors.push(`hook ${i}: command required`); return; }
    } else {
      errors.push(`hook ${i}: command required`); return;
    }
    for (const c of commands) {
      if (isAdminCommand(c)) { errors.push(`hook ${i}: administrative commands are not allowed`); return; }
    }
    const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(o.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) { errors.push(`hook ${i}: timeoutMs must be 100..120000`); return; }
    hooks.push({
      event: o.event as HookEventName,
      matcher: typeof o.matcher === 'string' ? o.matcher : undefined,
      command: typeof rawCmd === 'string' ? rawCmd.trim() : { ...(rawCmd.win32 ? { win32: rawCmd.win32.trim() } : {}), ...(rawCmd.darwin ? { darwin: rawCmd.darwin.trim() } : {}) },
      timeoutMs,
      enabled: o.enabled !== false,
      // Provenance for uninstall/enable gating; not user-editable via the UI.
      ...(typeof o.extId === 'string' && o.extId ? { extId: o.extId } : {}),
    });
  });
  return { hooks, errors };
}

/** Minimal glob: `*` matches anything (used for tool-name matchers). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

export interface RunHookOpts {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export function runHookCommand(command: string | { win32?: string; darwin?: string }, opts: RunHookOpts): Promise<HookRunRecord> {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  let resolved: string;
  try {
    resolved = resolveHookCommand(command);
  } catch (e) {
    return Promise.resolve({ command: hookCommandKey(command), event: '', exitCode: -1, durationMs: Date.now() - t0, stdout: '', stderr: (e as Error).message });
  }
  const p = platform();
  const { bin, args } = p.shellForCommand(resolved);
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    const finish = (code: number, stdout: string, stderr: string) => {
      resolve({ command: resolved, event: '', exitCode: code, durationMs: Date.now() - t0, stdout: stdout.slice(0, IO_CAP), stderr: stderr.slice(0, IO_CAP) });
    };
    // Login env first (macOS GUI apps start with a minimal PATH), then spawn.
    void p.loginEnv().then((env) => {
      if (Date.now() - t0 > timeoutMs) return finish(-1, '', 'hook timed out before spawn');
      let stdout = '';
      let stderr = '';
      try {
        child = spawn(bin, args, { cwd: opts.cwd, env, windowsHide: true });
      } catch (e) {
        finish(-1, '', (e as Error).message);
        return;
      }
      const proc = child;
      const timer = setTimeout(() => { p.killTree(proc); }, timeoutMs);
      timer.unref?.();
      const done = (code: number) => {
        clearTimeout(timer);
        finish(code, stdout, stderr);
      };
      proc.stdout?.on('data', (d) => { stdout += String(d); });
      proc.stderr?.on('data', (d) => { stderr += String(d); });
      if (opts.stdin !== undefined && proc.stdin) {
        try { proc.stdin.write(opts.stdin); proc.stdin.end(); } catch { /* noop */ }
      }
      opts.signal?.addEventListener('abort', () => { p.killTree(proc); }, { once: true });
      proc.on('error', () => done(-1));
      proc.on('close', (code) => done(code === null ? -1 : code));
    });
  });
}

export function parseDecision(stdout: string): { decision?: string; reason?: string } {
  try {
    const j = JSON.parse(stdout) as { decision?: unknown; reason?: unknown };
    if (j.decision === 'block' || j.decision === 'allow' || j.decision === 'require-approval') {
      return { decision: j.decision, reason: typeof j.reason === 'string' ? j.reason : undefined };
    }
  } catch { /* plain text output */ }
  return {};
}

/**
 * Run matching enabled hooks for one event. A hook can only make things
 * stricter: block (blockable events) or force-approval (PreToolUse). It can
 * NEVER auto-approve — an "allow" verdict is just "no objection".
 */
export function makeHookRunner(opts: {
  hooks: () => HookDef[];
  cwd: string;
  signal?: AbortSignal;
  run?: typeof runHookCommand;
}): HookRunner {
  const run = opts.run || runHookCommand;
  return async (event, payload) => {
    const records: HookResult['records'] = [];
    let verdict: HookVerdict = { action: 'continue' };
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    for (const h of opts.hooks()) {
      if (h.enabled === false || h.event !== event) continue;
      if (h.matcher && tool && !globMatch(h.matcher, tool)) continue;
      if (opts.signal?.aborted) break;
      const rec = await run(h.command, {
        cwd: opts.cwd,
        timeoutMs: h.timeoutMs || DEFAULT_TIMEOUT_MS,
        signal: opts.signal,
        stdin: JSON.stringify({ event, ...payload }),
      });
      // Records are redacted here: hook output may echo event secrets.
      records.push({
        ...rec,
        event,
        command: redactSecrets(rec.command),
        stdout: redactSecrets(rec.stdout),
        stderr: redactSecrets(rec.stderr),
      });
      if (!BLOCKABLE.includes(event)) continue; // warnings only elsewhere
      const { decision, reason } = parseDecision(rec.stdout);
      if (rec.exitCode === 2 || decision === 'block') {
        const why = (reason || rec.stderr || rec.stdout || `hook blocked ${event}`).trim().slice(0, 500);
        return { verdict: { action: 'block', reason: why }, records };
      }
      // Explicit escalation only; "allow" is just "no objection" and can
      // never skip an approval the policy requires.
      if (event === 'PreToolUse' && decision === 'require-approval') {
        verdict = { action: 'force-approval' };
      }
    }
    return { verdict, records };
  };
}

/** Explicit JSON {"decision":"..."} handling kept separate for testability. */
export function verdictFromRun(event: HookEventName, rec: { exitCode: number; stdout: string; stderr: string }): HookVerdict {
  if (!BLOCKABLE.includes(event)) return { action: 'continue' };
  const { decision, reason } = parseDecision(rec.stdout);
  if (rec.exitCode === 2 || decision === 'block') {
    return { action: 'block', reason: (reason || rec.stderr || rec.stdout || 'hook blocked').trim().slice(0, 500) };
  }
  if (event === 'PreToolUse' && decision === 'require-approval') return { action: 'force-approval' };
  return { action: 'continue' };
}

/** Command shown on this OS in trust dialogs and capability lists. */
export function hookDisplayCommand(h: HookDef, adapter: PlatformAdapter = platform()): string {
  try {
    return resolveHookCommand(h.command, adapter);
  } catch {
    return hookCommandKey(h.command);
  }
}

export function hookTrustInfo(hooks: HookDef[]): TrustInfo | null {
  const enabled = hooks.filter((h) => h.enabled !== false);
  if (!enabled.length) return null;
  return {
    title: 'These hook commands will run on agent events',
    lines: enabled.map((h) => `${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${hookDisplayCommand(h)}`),
  };
}

export function hookCapabilities(hooks: HookDef[]): string[] {
  return hooks.filter((h) => h.enabled !== false).map((h) =>
    `Runs "${hookDisplayCommand(h)}" on ${h.event}${h.matcher ? ` matching ${h.matcher}` : ''}`);
}
