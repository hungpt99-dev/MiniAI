# Extensions: skills, MCP servers, hooks, workflows

User data dir (`extensions/`, next to `nexio.db`): `skills/<name>/`,
`mcp/<group>.servers.json`, `hooks/hooks.json` (global list, ext entries carry
`extId`), `workflows/<name>.workflow.json`, `registry.json`.
Everything installs OFF; built-in examples seed disabled on first run.

## Reuse (no parallel systems)

- **Tools**: MCP tools register as `mcp__server__tool` in the same `Tool`
  shape; `skill_load` joins the agent tool list. Agent composes
  `[...ALL_TOOLS, ...extras]` per run.
- **Permissions**: `executeToolCall` (`agent/loop.ts`) is the one layer for
  agent runs AND workflow tool steps: schema check, hooks, normalize,
  `decidePolicy`, approval, timeout. Hooks can block/force-approval, never
  auto-approve. MCP default risk `write`; `readOnlyHint` counts as `read`
  only on trusted servers; `destructiveHint` is `destructive`.
- **Workflows**: `parseWorkflowDoc` accepts v1 (`version: 1`,
  `llm/tool/skill/agent/confirm/condition` steps, `{{input.x}}` /
  `{{steps.id.output}}` templating, `when` conditions) and legacy DB-format
  files (same validator + old engine, unchanged). v1 runs stream step
  events on the agent event channel; `confirm` reuses approval cards.
- **Slash**: skills (`skill` source), ext workflows (`workflow`), MCP
  prompts (`mcp`) merge into the existing registry; palette groups
  PROMPTS / WORKFLOWS / SKILLS / MCP.
- **Secrets**: MCP env/headers that look secret move to the DPAPI secret
  store (`ext:<id>:…`); JSON keeps `{"$secret": service}` refs. Uninstall
  wipes files, secrets, hook entries, grants.

## Safety

- Install reads + validates only (zip-slip/symlink/size caps, https-only
  git, kebab-case skills, 50-step workflows). No postinstall, no auto-start.
- SHA-256 per extension, re-checked on load: modified → disabled + flagged.
- Update diffs capabilities; grown permissions stay disabled until re-enabled.
- stdio servers and hook commands need explicit trust (exact command shown,
  values never shown). `npx`/`uvx`/`docker` never run silently.
- All extension content is UNTRUSTED for prompt-injection purposes.
- MCP over the official `@modelcontextprotocol/sdk` (stdio + Streamable
  HTTP/SSE, 10s health timeout); children die on Stop/quit.
- YAML workflow files are not supported (JSON only).
