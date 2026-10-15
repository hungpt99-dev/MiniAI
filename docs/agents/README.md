# Agents

`AGENTS.md` (repo root) is canonical for agent behavior.

- `compatibility.md` — external AI tools are out of scope; Nexio runs its own built-in loop on BYOK providers.
- `workflows.md` — 2-step workflow authoring notes.

## Slash commands

Builtins (see `src/main/slash/registry.ts`): `/help` `/new` `/clear` `/model`
`/history` `/settings` `/log` `/extensions` `/memory` `/remember` `/forget`
`/incognito` `/spawn` `/queue` `/tasks` `/cancel` `/clear-queue` `/pin`, plus
prompt templates, workflows and skills. `/queue <text>` (Do mode) appends to
the task queue; `/tasks` opens the Tasks view (pending/running rows with
cancel); `/clear-queue` clears the waiting queue after asking first.

No AI tool is required to use or contribute to Nexio.
