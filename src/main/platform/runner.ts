import { spawn, type ChildProcess } from 'node:child_process';
import type { ShellRunOpts, ShellRunResult } from './types';

/**
 * Shared spawn core: timeout, output cap, stdin, abort → tree-kill.
 * Platform files supply bin/args, spawn opts (detached on darwin for
 * process-group kill) and the tree-kill itself.
 */
export function runShellImpl(
  bin: string,
  args: string[],
  opts: ShellRunOpts,
  spawnOpts: { detached?: boolean; windowsHide?: boolean },
  killTree: (child: ChildProcess) => void,
): Promise<ShellRunResult> {
  const maxChars = opts.maxChars ?? 8000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ShellRunResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...spawnOpts,
      });
    } catch (e) {
      finish({ exitCode: null, output: `spawn failed: ${(e as Error).message}`, timedOut: false, aborted: false });
      return;
    }
    let out = '';
    const push = (d: Buffer | string) => {
      out += String(d);
      if (out.length > maxChars) out = out.slice(0, maxChars);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      push(`\n…[timed out after ${Math.round(opts.timeoutMs / 1000)}s]`);
      killTree(child);
      finish({ exitCode: null, output: out, timedOut: true, aborted: false });
    }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      killTree(child);
      finish({ exitCode: null, output: (out ? out + '\n' : '') + '[stopped by user]', timedOut: false, aborted: true });
    };
    if (opts.signal.aborted) return onAbort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.stdin !== undefined && child.stdin) {
      try { child.stdin.write(opts.stdin); child.stdin.end(); } catch { /* noop */ }
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ exitCode: null, output: `spawn failed: ${(e as Error).message}`, timedOut: false, aborted: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      finish({ exitCode: code, output: out, timedOut: false, aborted: false });
    });
  });
}
