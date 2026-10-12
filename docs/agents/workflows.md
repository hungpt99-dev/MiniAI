# Agent workflows

Workflow steps: `prompt` (templateId + inputVar/outputVar) →
`transform` (append/prepend/replace/upper/lower) →
`conditional` (contains → then/else, depth ≤ 2) →
`user-input` → `output` (must be last, max 20 steps).

Engine returns `{ok|failed|aborted}` with per-step history;
abort via Esc/cancel. Keep workflows small and testable;
prefer two steps over branching when possible.
