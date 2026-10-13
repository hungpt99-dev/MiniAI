import type { Tool } from '../types';
import { platform } from '../../platform/index';

// Never elevate, never touch accounts/privileges. Rejected before approval.
const ADMIN_PATTERNS = [
  /\brunas\b/i,
  /-verb\s+runas/i,
  /\bsudo\b/i,
  /\bsu\b\s/i,
  /\bdoas\b/i,
  /net\s+(user|localgroup)/i,
  /New-LocalUser/i,
  /Set-ExecutionPolicy/i,
  /Disable-.*Defender/i,
  /bcdedit/i,
  /reg\s+(add|delete)/i,
  /takeown\b/i,
  /icacls\b/i,
];

export function isAdminCommand(command: string): boolean {
  return ADMIN_PATTERNS.some((re) => re.test(command));
}

export const shellRunTool: Tool = {
  name: 'shell_run',
  description: 'Run a shell command (PowerShell on Windows, login zsh/bash on macOS). Never runs as admin. Timeout 30s, output capped. ALWAYS needs approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Exact command line to run' },
      cwd: { type: 'string', description: 'Working directory (defaults to the run cwd)' },
    },
    required: ['command'],
  },
  risk: 'destructive',
  describe: (input) => `Run with ${platform().shellName}: ${String(input.command || '')}${input.cwd ? ` (cwd: ${String(input.cwd)})` : ''}`,
  run: async (input, ctx) => {
    const command = String(input.command || '').trim();
    if (!command) return { ok: false, output: 'command is required' };
    if (isAdminCommand(command)) return { ok: false, output: 'rejected: command looks administrative (never run as admin)' };
    const cwd = (typeof input.cwd === 'string' && input.cwd) ? input.cwd : ctx.cwd;
    const p = platform();
    const t0 = Date.now();
    const res = await p.runShell(command, { cwd, signal: ctx.signal, timeoutMs: 30_000 });
    const dur = Date.now() - t0;
    if (res.aborted) return { ok: false, output: (res.output ? res.output + '\n' : '') + '[stopped by user]' };
    if (res.timedOut) return { ok: false, output: res.output };
    const tail = res.output.length >= 8000 ? '\n…[output capped]' : '';
    return { ok: res.exitCode === 0, output: `${res.output}${tail}\n[exit ${res.exitCode} in ${dur}ms]` };
  },
};
