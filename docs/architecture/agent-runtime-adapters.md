# Agent runtime adapters

| Runtime | Transport | Format | Abort | Notes |
|---|---|---|---|---|
| opencode | HTTP | SSE stream | AbortController | Local/remote HTTP endpoint |
| claude CLI | child process | JSONL | process kill | Requires CLI installed |
| codex CLI | child process | JSONL | process kill | Requires CLI installed |

Router freezes runtime per request; no fallback between adapters.
Cancelled runs return `aborted` with per-step history preserved.
Capabilities (model list, tools) are per-runtime; check adapter source
before assuming parity.
