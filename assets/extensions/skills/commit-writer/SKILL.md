---
name: commit-writer
description: Write a conventional-commit message from staged changes. Use when the user asks for a commit message.
version: 0.1.0
author: Nexio
---

# Commit Writer

When the user wants a commit message for their changes:

1. Run `git status --short` and `git diff --stat` with `shell_run`
   (each run needs the user's approval — say so).
2. Pick the type: feat, fix, docs, refactor, test, chore.
3. Keep the subject under 72 chars, imperative mood, no trailing period.
4. Never stage, commit, or push anything yourself — output the message only.
5. Never include secrets or keys that appear in the diff; say `[redacted]`.
