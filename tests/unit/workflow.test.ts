import { describe, it, expect } from 'vitest';
import { runWorkflow, validateWorkflow } from '../../src/main/workflow/engine';
import type { Workflow } from '../../src/shared/types';

const tpl = { '/reply': 'Reply to: {{text}}' };
const ctx = (vars: Record<string, string> = {}) => ({
  vars,
  getTemplateBody: (id: string) => tpl[id as keyof typeof tpl],
  runPrompt: async (p: string) => `AI(${p})`,
  askUser: async (prompt: string, dflt?: string) => varsForPrompt(prompt, dflt),
});
function varsForPrompt(_p: string, dflt?: string): string { return dflt || 'user-text'; }

describe('workflow engine', () => {
  it('runs prompt->output sequentially', async () => {
    const w: Workflow = {
      id: 'w1', trigger: '/t', title: 't',
      steps: [
        { kind: 'user-input', outputVar: 'text', prompt: 'p' },
        { kind: 'prompt', templateId: '/reply', inputVar: 'text', outputVar: 'draft' },
        { kind: 'output', inputVar: 'draft' },
      ],
    };
    const r = await runWorkflow(w, {}, ctx());
    expect(r.status).toBe('ok');
    expect(r.outputs.__output).toContain('AI(');
    expect(r.history.length).toBe(3);
  });
  it('fails on unknown template', async () => {
    const w: Workflow = {
      id: 'w', trigger: '/t', title: 't',
      steps: [{ kind: 'prompt', templateId: '/nope', outputVar: 'o' }, { kind: 'output', inputVar: 'o' }],
    };
    const r = await runWorkflow(w, {}, ctx());
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Unknown template/);
  });
  it('validates empty / >20 steps / missing output', () => {
    expect(validateWorkflow({ id: 'x', trigger: '/x', title: 'x', steps: [] }, () => true).length).toBeGreaterThan(0);
    const many: Workflow = { id: 'x', trigger: '/x', title: 'x', steps: Array.from({ length: 21 }, () => ({ kind: 'output' as const, inputVar: 'a' })) };
    expect(validateWorkflow(many, () => true).join()).toMatch(/20/);
  });
  it('supports abort', async () => {
    const c = new AbortController();
    c.abort();
    const w: Workflow = {
      id: 'w', trigger: '/t', title: 't',
      steps: [{ kind: 'user-input', outputVar: 'a', prompt: 'p' }, { kind: 'output', inputVar: 'a' }],
    };
    const r = await runWorkflow(w, {}, { ...ctx(), signal: c.signal });
    expect(r.status).toBe('aborted');
  });
  it('transform + conditional work', async () => {
    const w: Workflow = {
      id: 'w', trigger: '/t', title: 't',
      steps: [
        { kind: 'user-input', outputVar: 'text', prompt: 'p', defaultValue: 'hello urgent' },
        { kind: 'conditional', varName: 'text', contains: 'urgent', thenOutput: 'FAST', elseOutput: 'SLOW', inputVar: 'text', outputVar: 'prio' },
        { kind: 'transform', op: 'uppercase', from: 'prio', to: 'prio2' },
        { kind: 'output', inputVar: 'prio2' },
      ],
    };
    const r = await runWorkflow(w, {}, ctx());
    expect(r.outputs.__output).toBe('FAST');
  });
});
