import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openTestDb } from '../../src/main/db/db';
import { setSecret, getSecret } from '../../src/main/store/secrets';
import { parseSkillMd } from '../../src/main/extensions/skills';
import { filesFromZip, filesFromFolder, materializeSource } from '../../src/main/extensions/sources';
import { ExtStore, hashFiles } from '../../src/main/extensions/store';
import {
  parseMcpConfigJson, splitMcpSecrets, resolveSecretRefs, mcpToolRisk,
  McpManager, makeMcpTool, type McpClientLike,
} from '../../src/main/extensions/mcp';
import {
  validateHooksJson, makeHookRunner, runHookCommand, verdictFromRun, globMatch,
} from '../../src/main/extensions/hooks';
import {
  parseWorkflowDoc, renderTemplate, evalWhen, runExtWorkflow, EXT_WORKFLOW_MAX_STEPS,
} from '../../src/main/extensions/workflows';
import { runAgent, executeToolCall, type ToolExecState } from '../../src/main/agent/loop';
import type { AgentEvent, Tool } from '../../src/main/agent/types';
import { DEFAULT_LIMITS } from '../../src/main/agent/types';
import { validateWorkflow } from '../../src/main/workflow/engine';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-ext-'));

const SKILL = `---
name: test-skill
description: Does test things well.
---
# Test skill
Follow the user's request. Never delete anything without asking.
`;

// --- minimal zip builder (stored entries) for zip-slip tests ---
function zipOf(entries: Array<{ name: string; data: Buffer; method?: number }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(e.method || 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    chunks.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.method || 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cd, end]);
}

function writeZip(entries: Array<{ name: string; data: Buffer; method?: number }>): string {
  const p = path.join(tmpRoot(), 't.zip');
  fs.writeFileSync(p, zipOf(entries));
  return p;
}

describe('skills: SKILL.md validation', () => {
  it('accepts a good skill', () => {
    expect(parseSkillMd(SKILL)).toMatchObject({ name: 'test-skill', description: 'Does test things well.' });
  });
  it('rejects missing name/description, bad kebab, empty body', () => {
    expect(() => parseSkillMd('no frontmatter')).toThrow(/frontmatter/);
    expect(() => parseSkillMd('---\ndescription: x\n---\nbody')).toThrow(/name/);
    expect(() => parseSkillMd('---\nname: x\n---\nbody')).toThrow(/description/);
    expect(() => parseSkillMd('---\nname: Bad_Name\n---\nbody')).toThrow(/kebab/);
    expect(() => parseSkillMd('---\nname: x\ndescription: y\n---\n')).toThrow(/empty/);
  });
  it('caps SKILL.md at 100KB', () => {
    const big = `---\nname: x\ndescription: y\n---\n${'z'.repeat(101 * 1024)}`;
    expect(() => parseSkillMd(big)).toThrow(/100KB/);
  });
});

describe('sources: zip-slip, symlinks, caps', () => {
  it('rejects ../ traversal entries', () => {
    const p = writeZip([{ name: '../evil.txt', data: Buffer.from('x') }]);
    expect(() => filesFromZip(p)).toThrow(/zip-slip/);
  });
  it('rejects absolute entries', () => {
    const p = writeZip([{ name: '/abs.txt', data: Buffer.from('x') }]);
    expect(() => filesFromZip(p)).toThrow(/zip-slip/);
  });
  it('reads stored + deflated entries', () => {
    const p = writeZip([
      { name: 'SKILL.md', data: Buffer.from(SKILL) },
      { name: 'ref/a.md', data: Buffer.from('hello'), method: 8 },
    ]);
    const files = filesFromZip(p);
    expect(files.get('SKILL.md')!.toString()).toContain('test-skill');
    expect(files.get('ref/a.md')!.toString()).toBe('hello');
  });
  it('rejects folder symlinks escaping the extension', () => {
    const dir = tmpRoot();
    fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL);
    try {
      fs.symlinkSync('/etc', path.join(dir, 'link'));
    } catch {
      return; // no symlink privilege on this machine; skip
    }
    expect(() => filesFromFolder(dir)).toThrow(/symlink/);
  });
  it('rejects oversized unpacked data', () => {
    const p = writeZip([{ name: 'big.bin', data: Buffer.alloc(101 * 1024 * 1024), method: 8 }]);
    expect(() => filesFromZip(p)).toThrow(/too large/);
  }, 30000);
});

describe('mcp: config parsing + secret extraction', () => {
  it('accepts {mcpServers} and bare maps', () => {
    const a = parseMcpConfigJson({ mcpServers: { srv: { command: 'npx', args: ['-y', 'x'] } } });
    expect(a.errors).toEqual([]);
    expect(a.servers.srv).toMatchObject({ command: 'npx' });
    const b = parseMcpConfigJson({ web: { url: 'https://example.com/mcp' } });
    expect(b.errors).toEqual([]);
    expect(parseMcpConfigJson({ bad: { nope: 1 } }).errors.length).toBeGreaterThan(0);
    expect(parseMcpConfigJson({ h: { url: 'http://evil.example/x' } }).errors.length).toBeGreaterThan(0);
    expect(parseMcpConfigJson({ h: { url: 'http://localhost:3000/x' } }).errors).toEqual([]);
  });
  it('moves secret-looking values to the secret store, never plain JSON', () => {
    const { config, values } = splitMcpSecrets(
      { srv: { command: 'x', env: { API_KEY: 'sk-abc123', PLAIN: 'hello' } } },
      (srv, key) => `ext:test:mcp:${srv}:${key}`,
    );
    expect(values['ext:test:mcp:srv:API_KEY']).toBe('sk-abc123');
    expect(config.srv).toMatchObject({ command: 'x' });
    const env = (config.srv as { env: Record<string, string> }).env;
    expect(env.API_KEY).toContain('$secret');
    expect(env.PLAIN).toBe('hello');
    expect(JSON.stringify(config)).not.toContain('sk-abc123');
    // round-trip through the secret store
    const db = openTestDb();
    for (const [service, value] of Object.entries(values)) setSecret(db, service, value);
    const resolved = resolveSecretRefs(config, (s) => getSecret(db, s));
    expect((resolved.srv as { env: Record<string, string> }).env.API_KEY).toBe('sk-abc123');
    db.close();
  });
  it('maps risk from annotations + trust + overrides', () => {
    expect(mcpToolRisk(undefined, false)).toBe('write');
    expect(mcpToolRisk({ readOnlyHint: true }, false)).toBe('write'); // untrusted: stays write
    expect(mcpToolRisk({ readOnlyHint: true }, true)).toBe('read');
    expect(mcpToolRisk({ destructiveHint: true }, true)).toBe('destructive');
    expect(mcpToolRisk(undefined, false, 'allow')).toBe('read');
    expect(mcpToolRisk({ destructiveHint: true }, false, 'block')).toBe('block');
  });
});

describe('mcp: lifecycle with a fake server', () => {
  function fakeManager(opts: { trusted: boolean; tools?: Array<{ name: string; description?: string }> }) {
    let closed = 0;
    const client: McpClientLike = {
      listTools: async () => (opts.tools || [{ name: 'read', description: 'r' }]).map((t) => ({
        name: t.name, description: t.description, inputSchema: { type: 'object', properties: {} },
      })),
      callTool: async (name, args) => ({ ok: true, output: `called ${name} ${JSON.stringify(args)}` }),
      listPrompts: async () => [{ name: 'greet' }],
      close: async () => { closed++; },
    };
    const mgr = new McpManager({
      loadConfig: () => ({ srv: { command: 'fake' } }),
      isTrusted: () => opts.trusted,
      connect: async () => client,
    });
    return { mgr, closed: () => closed };
  }

  it('requires trust before first stdio start', async () => {
    const { mgr } = fakeManager({ trusted: false });
    await expect(mgr.ensure('srv')).rejects.toThrow(/trust-required/);
    try {
      await mgr.ensure('srv');
    } catch (e) {
      const t = (e as { trust: { lines: string[] } }).trust;
      expect(t.lines.join(' ')).toContain('fake');
    }
  });
  it('registers mcp__server__tool names with untrusted results', async () => {
    const { mgr } = fakeManager({ trusted: true });
    await mgr.ensure('srv');
    expect(mgr.getState('srv')?.status).toBe('ready');
    const tool = makeMcpTool('srv', { name: 'read', inputSchema: { type: 'object', properties: {} } }, mgr, 'write');
    expect(tool.name).toBe('mcp__srv__read');
    const r = await tool.run({}, { signal: new AbortController().signal, cwd: tmpRoot() });
    expect(r.ok).toBe(true);
    expect(r.untrusted).toBe(true);
    expect(r.source).toBe('mcp:srv');
  });
  it('health check times out', async () => {
    const mgr = new McpManager({
      loadConfig: () => ({ srv: { command: 'hang' } }),
      isTrusted: () => true,
      connect: () => new Promise<McpClientLike>(() => { /* never */ }),
      healthTimeoutMs: 50,
    });
    await expect(mgr.ensure('srv')).rejects.toThrow(/timed out/);
    expect(mgr.getState('srv')?.status).toBe('error');
  });
  it('stopAll closes children', async () => {
    const m = fakeManager({ trusted: true });
    await m.mgr.ensure('srv');
    await m.mgr.stopAll();
    expect(m.closed()).toBe(1);
  });
});

describe('hooks: exit codes and never-auto-approve', () => {
  const node = process.execPath;
  it('exit 2 blocks with stderr as the reason', async () => {
    const rec = await runHookCommand(`${node} -e "console.error('nope'); process.exit(2)"`, { cwd: tmpRoot() });
    expect(rec.exitCode).toBe(2);
    const v = verdictFromRun('PreToolUse', rec);
    expect(v).toEqual({ action: 'block', reason: 'nope' });
  });
  it('exit 0 continues; other nonzero is a warning', async () => {
    const ok = await runHookCommand(`${node} -e "process.exit(0)"`, { cwd: tmpRoot() });
    expect(verdictFromRun('PreToolUse', ok)).toEqual({ action: 'continue' });
    const warn = await runHookCommand(`${node} -e "process.exit(1)"`, { cwd: tmpRoot() });
    expect(verdictFromRun('PreToolUse', warn)).toEqual({ action: 'continue' });
  });
  it('block is ignored outside blockable events', async () => {
    const rec = await runHookCommand(`${node} -e "process.exit(2)"`, { cwd: tmpRoot() });
    expect(verdictFromRun('PostToolUse', rec)).toEqual({ action: 'continue' });
  });
  it('explicit allow never approves; require-approval escalates', () => {
    expect(verdictFromRun('PreToolUse', { exitCode: 0, stdout: '{"decision":"allow"}', stderr: '' }))
      .toEqual({ action: 'continue' });
    expect(verdictFromRun('PreToolUse', { exitCode: 0, stdout: '{"decision":"require-approval"}', stderr: '' }))
      .toEqual({ action: 'force-approval' });
  });
  it('matcher globs tool names', () => {
    expect(globMatch('shell_*', 'shell_run')).toBe(true);
    expect(globMatch('shell_*', 'fs_read')).toBe(false);
    expect(globMatch('*', 'anything')).toBe(true);
  });
  it('hook allow does not skip the approval card', async () => {
    const events: AgentEvent[] = [];
    const approvals: string[] = [];
    const tool: Tool = {
      name: 'fs_write', description: 'fake', risk: 'write',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describe: (i) => `write ${i.path}`,
      run: async () => ({ ok: true, output: 'wrote' }),
    };
    const dir = tmpRoot();
    const st: ToolExecState = {
      cwd: dir,
      policy: { allowedRoots: [dir], alwaysAllow: [], requireApprovalForWrites: true, homeDir: os.homedir() },
      limits: DEFAULT_LIMITS,
      emit: (e) => events.push(e),
      messages: [],
      waitForApproval: async (call) => { approvals.push(call.id); return { decision: 'allow-once' }; },
      hooks: makeHookRunner({
        hooks: () => [{ event: 'PreToolUse', command: `${node} -e "console.log(JSON.stringify({decision:'allow'}))"` }],
        cwd: dir,
      }),
      checkRunTimeout: () => false,
      toolCalls: 0,
      approvalWaitMs: 0,
      lastUntrusted: null,
    };
    const p = path.join(dir, 'n.txt');
    expect(await executeToolCall(tool, 'fs_write', { path: p }, 'c1', st)).toBe('ran');
    expect(approvals).toEqual(['c1']); // card still raised
  });
  it('hook block stops the call before policy/approval', async () => {
    const events: AgentEvent[] = [];
    let ran = 0;
    const tool: Tool = {
      name: 'shell_run', description: 'fake', risk: 'destructive',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      describe: (i) => `run ${i.command}`,
      run: async () => { ran++; return { ok: true, output: 'x' }; },
    };
    const dir = tmpRoot();
    const st: ToolExecState = {
      cwd: dir,
      policy: { allowedRoots: [dir], alwaysAllow: [], requireApprovalForWrites: true, homeDir: os.homedir() },
      limits: DEFAULT_LIMITS,
      emit: (e) => events.push(e),
      messages: [],
      waitForApproval: async () => ({ decision: 'allow-once' }),
      hooks: makeHookRunner({
        hooks: () => [{ event: 'PreToolUse', matcher: 'shell_*', command: `${node} -e "console.error('danger'); process.exit(2)"` }],
        cwd: dir,
      }),
      checkRunTimeout: () => false,
      toolCalls: 0,
      approvalWaitMs: 0,
      lastUntrusted: null,
    };
    expect(await executeToolCall(tool, 'shell_run', { command: 'whatever' }, 'c1', st)).toBe('blocked');
    expect(ran).toBe(0);
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
    const res = events.find((e) => e.type === 'tool_result');
    expect(res?.type === 'tool_result' && res.output).toContain('danger');
  });
  it('validateHooksJson rejects admin commands and bad shapes', () => {
    expect(validateHooksJson([{ event: 'PreToolUse', command: 'sudo rm -rf /' }]).errors.length).toBeGreaterThan(0);
    expect(validateHooksJson([{ event: 'Nope', command: 'echo' }]).errors.length).toBeGreaterThan(0);
    expect(validateHooksJson([{ event: 'PreToolUse', command: 'echo hi', matcher: 'shell_*' }]).errors).toEqual([]);
  });
});

describe('workflows: templating, conditions, limits, legacy loader', () => {
  const ctx = { inputs: { name: 'Ada' }, outputs: { sum: 'hello world' } };
  it('renders {{input.x}} and {{steps.id.output}} refs, missing is empty', () => {
    expect(renderTemplate('hi {{input.name}}: {{steps.sum}}!', ctx)).toBe('hi Ada: hello world!');
    expect(renderTemplate('{{input.missing}}|{{steps.nope}}', ctx)).toBe('|');
  });
  it('evaluates simple when expressions', () => {
    expect(evalWhen('steps.sum contains "world"', ctx)).toBe(true);
    expect(evalWhen('steps.sum contains "mars"', ctx)).toBe(false);
    expect(evalWhen('input.name == "Ada"', ctx)).toBe(true);
    expect(evalWhen('input.name != "Ada"', ctx)).toBe(false);
    expect(evalWhen('input.missing', ctx)).toBe(false);
    expect(evalWhen('garbage [[[', ctx)).toBe(false);
  });
  it('runs llm/tool/confirm/condition steps with templated args', async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const doc = parseWorkflowDoc({
      version: 1, trigger: '/demo', title: 'Demo',
      inputs: [{ name: 'topic', required: true }],
      steps: [
        { kind: 'llm', id: 'idea', text: 'idea about {{input.topic}}', output: 'idea' },
        { kind: 'tool', id: 'w', tool: 'fs_write', args: { path: '/tmp/{{input.topic}}.txt' }, output: 'wrote' },
        { kind: 'condition', id: 'big', when: 'steps.w contains "ok"', output: 'is_big' },
        { kind: 'confirm', id: 'go', text: 'proceed?', output: 'go' },
      ],
    });
    if (doc.kind !== 'ext') throw new Error('expected ext doc');
    const r = await runExtWorkflow(doc.workflow, { topic: 'x' }, {
      runPrompt: async (p) => `P:${p}`,
      callTool: async (tool, args) => { seen.push({ tool, args }); return { ok: true, output: 'ok done' }; },
      loadSkill: async () => 'skill',
      runSubAgent: async () => 'sub',
      confirm: async () => true,
    });
    expect(r.status).toBe('ok');
    expect(r.outputs.idea).toBe('P:idea about x');
    expect(seen[0]).toEqual({ tool: 'fs_write', args: { path: '/tmp/x.txt' } });
    expect(r.outputs.is_big).toBe('true');
    expect(r.outputs.go).toBe('yes');
  });
  it('fails on missing required input; enforces 50-step cap', async () => {
    const doc = parseWorkflowDoc({
      version: 1, trigger: '/d', title: 'D', inputs: [{ name: 'need', required: true }], steps: [{ kind: 'llm', text: 'x', output: 'o' }],
    });
    if (doc.kind !== 'ext') throw new Error('expected ext doc');
    const r = await runExtWorkflow(doc.workflow, {}, {
      runPrompt: async () => '', callTool: async () => ({ ok: true, output: '' }),
      loadSkill: async () => '', runSubAgent: async () => '', confirm: async () => true,
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/need/);
    const many = Array.from({ length: EXT_WORKFLOW_MAX_STEPS + 1 }, (_, i) => ({ kind: 'llm', text: `t${i}`, output: `o${i}` }));
    expect(() => parseWorkflowDoc({ version: 1, trigger: '/d', title: 'D', steps: many })).toThrow(/50/);
  });
  it('accepts legacy files via the same loader (old engine keeps running them)', () => {
    const legacy = {
      id: 'wf-email-reply', trigger: '/email-reply', title: 'Email reply',
      steps: [
        { kind: 'user-input', outputVar: 'text', prompt: 'Paste the email' },
        { kind: 'prompt', templateId: '/reply', inputVar: 'text', outputVar: 'draft' },
        { kind: 'output', inputVar: 'draft' },
      ],
    };
    const doc = parseWorkflowDoc(legacy, { templateExists: () => true });
    expect(doc.kind).toBe('legacy');
    if (doc.kind !== 'legacy') throw new Error('unreachable');
    expect(validateWorkflow(doc.workflow, () => true)).toEqual([]);
    const bad = { ...legacy, steps: [{ kind: 'prompt', templateId: '/x', outputVar: 'o' }] };
    expect(() => parseWorkflowDoc(bad, { templateExists: () => false })).toThrow(/invalid workflow/);
  });
});

describe('store: install/enable/hash/uninstall', () => {
  function makeStore() {
    const db = openTestDb();
    const store = new ExtStore(tmpRoot(), db);
    return { db, store };
  }
  it('installs a skill OFF by default; enable lists it', async () => {
    const { db, store } = makeStore();
    const r = await store.install({ type: 'paste', kind: 'skill', text: SKILL });
    if (r.status !== 'installed') throw new Error('expected install');
    expect(r.record.enabled).toBe(false);
    expect(store.list()).toHaveLength(1);
    store.enable(r.record.id);
    expect(store.get(r.record.id)?.enabled).toBe(true);
    db.close();
  });
  it('rejects duplicate names', async () => {
    const { db, store } = makeStore();
    await store.install({ type: 'paste', kind: 'skill', text: SKILL });
    await expect(store.install({ type: 'paste', kind: 'skill', text: SKILL })).rejects.toThrow(/duplicate/);
    db.close();
  });
  it('disables a modified extension (hash re-check)', async () => {
    const { db, store } = makeStore();
    const r = await store.install({ type: 'paste', kind: 'skill', text: SKILL });
    if (r.status !== 'installed') throw new Error('expected install');
    store.enable(r.record.id);
    const loc = store.location(store.get(r.record.id)!)!;
    fs.writeFileSync(path.join(loc, 'SKILL.md'), SKILL + '\nEVIL=1\n');
    const rec = store.list().find((x) => x.id === r.record.id)!;
    expect(rec.tampered).toBe(true);
    expect(rec.enabled).toBe(false);
    expect(() => store.enable(r.record.id)).toThrow(/modified/);
    db.close();
  });
  it('uninstall removes files, secrets, hooks and grants', async () => {
    const { db, store } = makeStore();
    const mcp = await store.install({
      type: 'paste', kind: 'mcp',
      text: JSON.stringify({ mcpServers: { srv: { command: 'fake', env: { TOKEN: 'secret-abc-1234567890' } } } }),
    });
    if (mcp.status !== 'installed') throw new Error('expected install');
    const rec = mcp.record;
    expect(getSecret(db, `ext:${rec.id}:mcp:srv:TOKEN`)).toBe('secret-abc-1234567890');
    const hook = await store.install({
      type: 'paste', kind: 'hook',
      text: JSON.stringify([{ event: 'PreToolUse', command: 'echo hi' }]),
    });
    if (hook.status !== 'installed') throw new Error('expected install');
    expect(store.readHooksFile().some((h) => h.extId === hook.record.id)).toBe(true);
    store.remove(rec.id);
    expect(store.get(rec.id)).toBeUndefined();
    expect(getSecret(db, `ext:${rec.id}:mcp:srv:TOKEN`)).toBeUndefined();
    store.remove(hook.record.id);
    expect(store.readHooksFile().some((h) => h.extId === hook.record.id)).toBe(false);
    db.close();
  });
  it('update with grown permissions disables until re-approved', async () => {
    const { db, store } = makeStore();
    const r = await store.install({ type: 'paste', kind: 'skill', text: SKILL });
    if (r.status !== 'installed') throw new Error('expected install');
    store.enable(r.record.id);
    // Same capabilities: stays enabled.
    const same = await store.update(r.record.id, { type: 'paste', kind: 'skill', text: SKILL });
    expect(same.grew).toBe(false);
    expect(store.get(r.record.id)?.enabled).toBe(true);
    db.close();
  });
  it('hashFiles is stable and content-sensitive', () => {
    const a = new Map([['b', Buffer.from('2')], ['a', Buffer.from('1')]]);
    const b = new Map([['a', Buffer.from('1')], ['b', Buffer.from('2')]]);
    expect(hashFiles(a)).toBe(hashFiles(b));
    expect(hashFiles(new Map([['a', Buffer.from('1x')]]))).not.toBe(hashFiles(a));
  });
});

describe('store: bundled examples seed disabled', () => {
  it('seeds 2 skills + 2 workflows, all OFF', () => {
    const db = openTestDb();
    const store = new ExtStore(tmpRoot(), db);
    store.seedExamples('assets/extensions');
    const recs = store.list();
    expect(recs.filter((r) => r.kind === 'skill')).toHaveLength(2);
    expect(recs.filter((r) => r.kind === 'workflow')).toHaveLength(2);
    expect(recs.every((r) => r.enabled === false)).toBe(true);
    db.close();
  });
});
describe('loop: extension hooks + skill content stays untrusted', () => {
  it('UserPromptSubmit block aborts the run before any model call', async () => {
    const events: AgentEvent[] = [];
    let fetched = 0;
    await runAgent('do evil', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: tmpRoot(), history: [],
      fetchFn: (async () => { fetched++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      logDir: tmpRoot(),
      emit: (e) => events.push(e),
      waitForApproval: async () => ({ decision: 'allow-once' }),
      hooks: async () => ({ verdict: { action: 'block', reason: 'nope' }, records: [] }),
    });
    expect(fetched).toBe(0);
    expect(events.some((e) => e.type === 'error' && /Blocked by hook/.test(e.message))).toBe(true);
  });
});
