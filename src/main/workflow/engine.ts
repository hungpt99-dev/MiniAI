import type { Workflow, WorkflowStep } from '../../shared/types';

export interface EngineContext {
  vars: Record<string, string>;
  /** Resolve a prompt template body by id or trigger. */
  getTemplateBody: (idOrTrigger: string) => string | undefined;
  /** Run one LLM prompt; must respect abort signal. */
  runPrompt: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Supply user input for `user-input` steps (UI or prefilled). */
  askUser?: (prompt: string, defaultValue?: string) => Promise<string>;
  signal?: AbortSignal;
  onStep?: (index: number, step: WorkflowStep, output: string) => void;
}

export type RunStatus = 'ok' | 'failed' | 'aborted';
export interface RunResult {
  status: RunStatus;
  outputs: Record<string, string>;
  history: Array<{ index: number; kind: string; output: string }>;
  error?: string;
}

export function validateWorkflow(w: Workflow, templateExists: (id: string) => boolean): string[] {
  const errors: string[] = [];
  if (!w.steps || w.steps.length === 0) errors.push('Workflow has no steps');
  if (w.steps.length > 20) errors.push('Workflow has more than 20 steps');
  if (w.steps.length > 0 && w.steps[w.steps.length - 1].kind !== 'output') errors.push('Last step must be output');
  let depth = 0;
  for (const s of w.steps) {
    if (s.kind === 'conditional') depth++;
    if (depth > 2) { errors.push('Conditional nesting depth > 2'); break; }
    if (s.kind === 'prompt' && !templateExists(s.templateId)) errors.push(`Unknown template: ${s.templateId}`);
    if (s.kind === 'prompt' && !s.outputVar) errors.push('Prompt step needs outputVar');
  }
  return errors;
}

function applyTransform(op: string, base: string, text?: string): string {
  switch (op) {
    case 'append': return base + (text || '');
    case 'prepend': return (text || '') + base;
    case 'replace': return text ?? base;
    case 'uppercase': return base.toUpperCase();
    case 'lowercase': return base.toLowerCase();
    default: return base;
  }
}

export async function runWorkflow(w: Workflow, initialVars: Record<string, string>, ctx: EngineContext): Promise<RunResult> {
  const templateExists = (id: string) => !!ctx.getTemplateBody(id);
  const errors = validateWorkflow(w, templateExists);
  if (errors.length > 0) return { status: 'failed', outputs: {}, history: [], error: errors.join('; ') };
  const outputs: Record<string, string> = { ...initialVars };
  const history: RunResult['history'] = [];
  for (let i = 0; i < w.steps.length; i++) {
    if (ctx.signal?.aborted) return { status: 'aborted', outputs, history, error: 'Aborted' };
    const step = w.steps[i];
    try {
      let out = '';
      switch (step.kind) {
        case 'user-input':
          out = ctx.askUser ? await ctx.askUser(step.prompt, step.defaultValue) : (initialVars[step.outputVar] || step.defaultValue || '');
          outputs[step.outputVar] = out;
          break;
        case 'prompt': {
          const body = ctx.getTemplateBody(step.templateId);
          if (!body) throw new Error(`Unknown template: ${step.templateId}`);
          const input = step.inputVar ? (outputs[step.inputVar] || '') : (outputs['text'] || '');
          // Fill {{text}}/{{input}} then pass through leftover vars literally
          const prompt = body.replace(/\{\{\s*(text|input)\s*\}\}/g, input);
          out = await ctx.runPrompt(prompt, ctx.signal);
          outputs[step.outputVar] = out;
          break;
        }
        case 'transform':
          out = applyTransform(step.op, outputs[step.from] || '', step.text);
          outputs[step.to] = out;
          break;
        case 'conditional': {
          const val = outputs[step.inputVar] || '';
          const hit = val.includes(step.contains);
          out = hit ? step.thenOutput : step.elseOutput;
          outputs[step.outputVar] = out;
          break;
        }
        case 'output':
          out = outputs[step.inputVar] || '';
          outputs['__output'] = out;
          break;
      }
      history.push({ index: i, kind: step.kind, output: out });
      ctx.onStep?.(i, step, out);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/abort/i.test(msg)) return { status: 'aborted', outputs, history, error: msg };
      return { status: 'failed', outputs, history, error: `Step ${i} (${step.kind}): ${msg}` };
    }
  }
  return { status: 'ok', outputs, history };
}
