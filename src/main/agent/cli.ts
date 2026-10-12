import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentCaps, AgentReq, AgentRuntimeAdapter } from './adapter';
import type { RuntimeId } from '../../shared/types';

export interface CliConfig {
  id: RuntimeId;
  label: string;
  bin: string;
  buildArgs: (prompt: string, sessionId?: string) => string[];
}

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => {
  stdout: AsyncIterable<string> | NodeJS.ReadableStream;
  kill: () => void;
  done: Promise<number | null>;
};

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const child: ChildProcess = spawn(bin, args, { cwd: opts.cwd, shell: false });
  if (opts.signal) {
    if (opts.signal.aborted) child.kill();
    else opts.signal.addEventListener('abort', () => child.kill(), { once: true });
  }
  const stdout = child.stdout || (async function* () {})();
  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { stdout: stdout as NodeJS.ReadableStream, kill: () => child.kill(), done };
};

/** Parse one JSONL line into a text delta. Supports {delta|text|content|message}. */
export function parseJsonlDelta(line: string): string {
  const t = line.trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    for (const k of ['delta', 'text', 'content', 'message']) {
      if (typeof j[k] === 'string') return j[k] as string;
    }
    return '';
  } catch {
    return '';
  }
}

export function createCliAdapter(cfg: CliConfig, spawnFn: SpawnFn = defaultSpawn, cwd?: string): AgentRuntimeAdapter {
  return {
    id: cfg.id,
    caps(): AgentCaps {
      if (!cfg.bin) return { id: cfg.id, label: cfg.label, available: false, reason: `${cfg.id} bin not set` };
      return { id: cfg.id, label: cfg.label, available: true };
    },
    async run(req: AgentReq): Promise<string> {
      if (!cfg.bin) throw new Error(`runtime-unavailable: ${cfg.id} bin not set`);
      const proc = spawnFn(cfg.bin, cfg.buildArgs(req.prompt, req.sessionId), { cwd: req.cwd || cwd, signal: req.signal });
      let full = '';
      const onAbort = () => proc.kill();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let leftover = '';
        const stream = proc.stdout as NodeJS.ReadableStream & AsyncIterable<Buffer | string>;
        for await (const chunk of stream) {
          if (req.signal?.aborted) { proc.kill(); throw new Error('Aborted'); }
          leftover += String(chunk);
          const lines = leftover.split('\n');
          leftover = lines.pop() || '';
          for (const line of lines) {
            const d = parseJsonlDelta(line);
            if (d) { full += d; req.onToken(d); }
          }
        }
        if (leftover.trim()) {
          const d = parseJsonlDelta(leftover);
          if (d) { full += d; req.onToken(d); }
        }
        await proc.done;
        if (req.signal?.aborted) throw new Error('Aborted');
        return full;
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export function createClaudeAdapter(bin: string, spawnFn?: SpawnFn, cwd?: string): AgentRuntimeAdapter {
  return createCliAdapter(
    { id: 'claude', label: 'Claude Code', bin, buildArgs: (p) => ['-p', '--output-format', 'stream-json', p] },
    spawnFn, cwd,
  );
}

export function createCodexAdapter(bin: string, spawnFn?: SpawnFn, cwd?: string): AgentRuntimeAdapter {
  return createCliAdapter(
    { id: 'codex', label: 'Codex CLI', bin, buildArgs: (p) => ['exec', '--json', p] },
    spawnFn, cwd,
  );
}
