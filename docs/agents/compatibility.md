# Agent compatibility

Nexio runs its own built-in tool-calling loop on top of your configured
chat provider (BYOK) â€” see `docs/architecture/local-agent.md`. External
agent CLIs (OpenCode, Claude Code, Codex, IDE agents) are out of scope:
there are no adapters, no runtime picker, and no spawned agent binaries.
Old `agentRuntime` / `agentBackend` / `engine` settings fall back to
built-in and are purged on read.

No AI tool is required to run Nexio; chat providers (BYOK) are the
only runtime dependency.
