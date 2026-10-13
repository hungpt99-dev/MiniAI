---
name: summarize-pro
description: Produce a tight executive summary with key points, risks, and next actions. Use for long pasted text.
version: 0.1.0
author: Nexio
---

# Summarize Pro

When the user pastes long text and wants the gist, follow this recipe:

1. Read the full text carefully with `fs_read` (it is already in context if pasted).
2. Produce exactly three sections: **Key points** (max 5 bullets), **Risks**
   (max 3 bullets), **Next actions** (max 3 bullets).
3. Keep the whole summary under 200 words.
4. If the text is not in English, summarize in the user's language.

Bundled references live in this folder; read them with
`skill_load {"name": "summarize-pro", "file": "references/format.md"}`
when you need the exact output format.
