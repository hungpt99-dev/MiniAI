import type { AgentCaps, AgentReq, AgentRuntimeAdapter } from './adapter';

export interface OpencodeOpts {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

function sseDeltas(buf: string, onData: (data: string) => void): string {
  const parts = buf.split('\n');
  const tail = parts.pop() || '';
  for (const line of parts) {
    const t = line.trim();
    if (t.startsWith('data:')) onData(t.slice(5).trim());
  }
  return tail;
}

export function createOpencodeAdapter(opts: OpencodeOpts): AgentRuntimeAdapter {
  const base = (opts.baseUrl || '').replace(/\/$/, '');
  return {
    id: 'opencode',
    caps(): AgentCaps {
      if (!base) return { id: 'opencode', label: 'OpenCode', available: false, reason: 'opencodeBaseUrl not set' };
      return { id: 'opencode', label: 'OpenCode', available: true };
    },
    async run(req: AgentReq): Promise<string> {
      if (!base) throw new Error('runtime-unavailable: opencode opencodeBaseUrl not set');
      const fetchFn = opts.fetchFn || fetch;
      const res = await fetchFn(`${base}/session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: req.sessionId, prompt: req.prompt }),
        signal: req.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`opencode http ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.body) {
        const json = await res.json().catch(() => undefined) as { text?: string; delta?: string } | undefined;
        const msg = json?.text || json?.delta || '';
        if (msg) req.onToken(msg);
        return msg;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      for (;;) {
        if (req.signal?.aborted) throw new Error('Aborted');
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = sseDeltas(buf, (data) => {
          if (data === '[DONE]') return;
          try {
            const j = JSON.parse(data) as { delta?: string; text?: string };
            const d = j.delta ?? j.text ?? '';
            if (d) { full += d; req.onToken(d); }
          } catch { /* keep-alive */ }
        });
      }
      return full;
    },
  };
}
