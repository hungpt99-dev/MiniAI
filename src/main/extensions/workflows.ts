import type { Workflow } from '../../shared/types';
import { validateWorkflow } from '../workflow/engine';

export const EXT_WORKFLOW_VERSION = 1;
export const EXT_WORKFLOW_MAX_STEPS = 50;
export const WORKFLOW_FILE_CAP = 200 * 1024;

export interface ExtWorkflowInput {
  name: string;
  label?: string;
  type?: 'string' | 'text' | 'number' | 'boolean';
  default?: string;
  required?: boolean;
}

export type ExtStep =
  | { kind: 'llm'; id?: string; text: string; output: string; when?: string }
  | { kind: 'tool'; id?: string; tool: string; args?: Record<string, unknown>; output: string; when?: string }
  | { kind: 'skill'; id?: string; name: string; output: string; when?: string }
  | { kind: 'agent'; id?: string; goal: string; tools?: string[]; output: string; when?: string }
  | { kind: 'confirm'; id?: string; text: string; output: string; when?: string }
  | { kind: 'condition'; id?: string; when: string; output: string };

export interface ExtWorkflow {
  version: 1;
  id: string;
  trigger: string;
  title: string;
  description?: string;
  inputs: ExtWorkflowInput[];
  steps: ExtStep[];
}

/** Loader accepts both shapes: v1 docs and legacy DB-format workflows. */
export type WorkflowDoc =
  | { kind: 'legacy'; workflow: Workflow }
  | { kind: 'ext'; workflow: ExtWorkflow };

export function normalizeTrigger(t: unknown): string {
  const s = String(t || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9_-]+$/.test(s.replace(/^\//, ''))) throw new Error(`bad workflow trigger: ${t}`);
  return s.startsWith('/') ? s : `/${s}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseWorkflowDoc(raw: unknown, opts: { templateExists?: (id: string) => boolean } = {}): WorkflowDoc {
  if (!isObject(raw)) throw new Error('workflow must be a JSON object');
  if (raw.version === EXT_WORKFLOW_VERSION) return { kind: 'ext', workflow: parseExt(raw) };
  // Legacy shape (same as the DB format): {id?, trigger, title, steps}.
  const trigger = normalizeTrigger(raw.trigger);
  const steps = raw.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('workflow has no steps');
  const wf: Workflow = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `wf-${trigger.slice(1)}`,
    trigger,
    title: typeof raw.title === 'string' && raw.title ? raw.title : trigger,
    steps: steps as Workflow['steps'],
  };
  // Reuse the existing validator so old files keep working unchanged.
  const errors = validateWorkflow(wf, opts.templateExists || (() => true));
  if (errors.length) throw new Error(`invalid workflow: ${errors.join('; ')}`);
  return { kind: 'legacy', workflow: wf };
}

function parseExt(raw: Record<string, unknown>): ExtWorkflow {
  const trigger = normalizeTrigger(raw.trigger);
  const steps = raw.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('workflow has no steps');
  if (steps.length > EXT_WORKFLOW_MAX_STEPS) throw new Error(`workflow has more than ${EXT_WORKFLOW_MAX_STEPS} steps`);
  const inputs: ExtWorkflowInput[] = [];
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) throw new Error('inputs must be an array');
    for (const inp of raw.inputs) {
      if (!isObject(inp) || typeof inp.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(inp.name)) {
        throw new Error('each input needs a name ([A-Za-z0-9_]+)');
      }
      inputs.push({
        name: inp.name,
        label: typeof inp.label === 'string' ? inp.label : undefined,
        type: inp.type === 'text' || inp.type === 'number' || inp.type === 'boolean' ? inp.type : 'string',
        default: typeof inp.default === 'string' ? inp.default : undefined,
        required: inp.required === true,
      });
    }
  }
  const seenIds = new Set<string>();
  const parsed: ExtStep[] = steps.map((s, i) => {
    if (!isObject(s) || typeof s.kind !== 'string') throw new Error(`step ${i}: bad kind`);
    if (typeof s.output !== 'string' || !s.output) throw new Error(`step ${i}: output var required`);
    if (typeof s.id === 'string' && s.id) {
      if (seenIds.has(s.id)) throw new Error(`step ${i}: duplicate id ${s.id}`);
      seenIds.add(s.id);
    }
    const when = typeof s.when === 'string' ? s.when : undefined;
    switch (s.kind) {
      case 'llm':
        if (typeof s.text !== 'string' || !s.text) throw new Error(`step ${i}: text required`);
        return { kind: 'llm', id: optId(s), text: s.text, output: s.output as string, when };
      case 'tool':
        if (typeof s.tool !== 'string' || !s.tool) throw new Error(`step ${i}: tool required`);
        if (s.args !== undefined && !isObject(s.args)) throw new Error(`step ${i}: args must be an object`);
        return { kind: 'tool', id: optId(s), tool: s.tool, args: s.args as Record<string, unknown> | undefined, output: s.output as string, when };
      case 'skill':
        if (typeof s.name !== 'string' || !s.name) throw new Error(`step ${i}: name required`);
        return { kind: 'skill', id: optId(s), name: s.name, output: s.output as string, when };
      case 'agent':
        if (typeof s.goal !== 'string' || !s.goal) throw new Error(`step ${i}: goal required`);
        if (s.tools !== undefined && (!Array.isArray(s.tools) || !s.tools.every((t) => typeof t === 'string'))) {
          throw new Error(`step ${i}: tools must be string[]`);
        }
        return { kind: 'agent', id: optId(s), goal: s.goal, tools: s.tools as string[] | undefined, output: s.output as string, when };
      case 'confirm':
        if (typeof s.text !== 'string' || !s.text) throw new Error(`step ${i}: text required`);
        return { kind: 'confirm', id: optId(s), text: s.text, output: s.output as string, when };
      case 'condition':
        if (typeof s.when !== 'string' || !s.when) throw new Error(`step ${i}: when required`);
        return { kind: 'condition', id: optId(s), when: s.when, output: s.output as string };
      default:
        throw new Error(`step ${i}: unknown kind ${s.kind}`);
    }
  });
  return {
    version: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : `wf-${trigger.slice(1)}`,
    trigger,
    title: typeof raw.title === 'string' && raw.title ? raw.title : trigger,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputs,
    steps: parsed,
  };
}

function optId(s: Record<string, unknown>): string | undefined {
  return typeof s.id === 'string' && s.id ? s.id : undefined;
}

// --- templating: {{input.x}}, {{steps.id.output}} ({{steps.id}} short), {{vars}} ---

export interface TemplateCtx {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  vars?: Record<string, string>;
}

const REF_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function lookupRef(ref: string, ctx: TemplateCtx): string {
  const parts = ref.split('.');
  if (parts[0] === 'input' && parts.length === 2) return ctx.inputs[parts[1]] ?? '';
  if (parts[0] === 'steps' && (parts.length === 2 || parts.length === 3)) {
    const id = parts[1];
    void parts[2];
    return ctx.outputs[id] ?? '';
  }
  if (ctx.vars && ref in ctx.vars) return ctx.vars[ref];
  if (ref in ctx.outputs) return ctx.outputs[ref];
  return '';
}

export function renderTemplate(text: string, ctx: TemplateCtx): string {
  REF_RE.lastIndex = 0;
  return text.replace(REF_RE, (_, ref: string) => lookupRef(ref, ctx));
}

function renderDeep(value: unknown, ctx: TemplateCtx): unknown {
  if (typeof value === 'string') return renderTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderDeep(v, ctx);
    return out;
  }
  return value;
}

/** Simple `when`: `ref`, `ref contains "x"`, `ref == "x"`, `ref != "x"`. */
export function evalWhen(when: string, ctx: TemplateCtx): boolean {
  const m = when.trim().match(/^([A-Za-z0-9_.]+)(?:\s+(contains|==|!=)\s+"([\s\S]*)")?$/);
  if (!m) return false;
  const val = lookupRef(m[1], ctx);
  if (!m[2]) return val.trim() !== '' && val !== 'false';
  if (m[2] === 'contains') return val.includes(m[3]);
  if (m[2] === '==') return val === m[3];
  return val !== m[3];
}

// --- runner (new kinds only; legacy docs run through the existing engine) ---

export interface ExtRunCtx {
  signal?: AbortSignal;
  runPrompt: (prompt: string) => Promise<string>;
  callTool: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  loadSkill: (name: string) => Promise<string>;
  runSubAgent: (goal: string, tools?: string[]) => Promise<string>;
  confirm: (text: string) => Promise<boolean>;
  onStep?: (index: number, step: ExtStep, output: string) => void;
}

export interface ExtRunResult {
  status: 'ok' | 'failed' | 'aborted';
  outputs: Record<string, string>;
  history: Array<{ index: number; kind: string; output: string }>;
  error?: string;
}

export async function runExtWorkflow(
  w: ExtWorkflow,
  givenInputs: Record<string, string>,
  ctx: ExtRunCtx,
): Promise<ExtRunResult> {
  if (w.steps.length > EXT_WORKFLOW_MAX_STEPS) {
    return { status: 'failed', outputs: {}, history: [], error: `more than ${EXT_WORKFLOW_MAX_STEPS} steps` };
  }
  const inputs: Record<string, string> = {};
  for (const def of w.inputs) {
    const v = givenInputs[def.name] ?? def.default ?? '';
    if (def.required && !v) {
      return { status: 'failed', outputs: {}, history: [], error: `missing required input: ${def.name}` };
    }
    inputs[def.name] = v;
  }
  const outputs: Record<string, string> = {};
  const history: ExtRunResult['history'] = [];
  const tctx = (): TemplateCtx => ({ inputs, outputs });
  for (let i = 0; i < w.steps.length; i++) {
    if (ctx.signal?.aborted) return { status: 'aborted', outputs, history, error: 'Aborted' };
    const step = w.steps[i];
    try {
      let out = '';
      if (step.kind !== 'condition' && step.when && !evalWhen(step.when, tctx())) {
        history.push({ index: i, kind: `${step.kind}:skipped`, output: '' });
        ctx.onStep?.(i, step, '');
        continue;
      }
      switch (step.kind) {
        case 'condition':
          out = evalWhen(step.when, tctx()) ? 'true' : 'false';
          outputs[step.output] = out;
          break;
        case 'llm':
          out = await ctx.runPrompt(renderTemplate(step.text, tctx()));
          outputs[step.output] = out;
          break;
        case 'tool': {
          const args = (renderDeep(step.args || {}, tctx()) as Record<string, unknown>);
          const r = await ctx.callTool(step.tool, args);
          out = r.output;
          if (!r.ok) throw new Error(out.slice(0, 300) || `tool ${step.tool} failed`);
          outputs[step.output] = out;
          break;
        }
        case 'skill':
          out = await ctx.loadSkill(step.name);
          outputs[step.output] = out;
          break;
        case 'agent':
          out = await ctx.runSubAgent(renderTemplate(step.goal, tctx()), step.tools);
          outputs[step.output] = out;
          break;
        case 'confirm': {
          const yes = await ctx.confirm(renderTemplate(step.text, tctx()));
          out = yes ? 'yes' : 'no';
          outputs[step.output] = out;
          break;
        }
      }
      history.push({ index: i, kind: step.kind, output: out });
      // Alias outputs by step id so {{steps.<id>}} and {{steps.<id>.output}} work.
      if (step.id) outputs[step.id] = out;
      ctx.onStep?.(i, step, out);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/abort/i.test(msg)) return { status: 'aborted', outputs, history, error: msg };
      return { status: 'failed', outputs, history, error: `Step ${i} (${step.kind}): ${msg}` };
    }
  }
  return { status: 'ok', outputs, history };
}

/** Tools/servers/skills a workflow needs — shown on the install screen. */
export function workflowPermissions(w: ExtWorkflow): {
  tools: string[]; servers: string[]; skills: string[]; agents: boolean; confirms: string[];
} {
  const tools = new Set<string>();
  const servers = new Set<string>();
  const skills = new Set<string>();
  let agents = false;
  const confirms: string[] = [];
  for (const s of w.steps) {
    if (s.kind === 'tool') {
      tools.add(s.tool);
      const m = s.tool.match(/^mcp__([^_]+)__/);
      if (m) servers.add(m[1]);
    } else if (s.kind === 'skill') skills.add(s.name);
    else if (s.kind === 'agent') agents = true;
    else if (s.kind === 'confirm') confirms.push(s.text);
  }
  return { tools: [...tools], servers: [...servers], skills: [...skills], agents, confirms };
}

export function workflowCapabilities(w: ExtWorkflow): string[] {
  const p = workflowPermissions(w);
  const caps: string[] = [];
  if (p.tools.length) caps.push(`Calls tools: ${p.tools.join(', ')} (each still needs approval)`);
  if (p.servers.length) caps.push(`Uses MCP servers: ${p.servers.join(', ')}`);
  if (p.skills.length) caps.push(`Loads skills: ${p.skills.join(', ')}`);
  if (p.agents) caps.push('Runs agent sub-tasks with the same limits and approvals');
  if (p.confirms.length) caps.push(`Asks for confirmation: ${p.confirms.map((c) => `"${c.slice(0, 60)}"`).join('; ')}`);
  if (!caps.length) caps.push('Runs prompts only — no tools, no side effects');
  return caps;
}
