import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from '../db/db';
import { setSecret } from '../store/secrets';
import { deleteSecretsByPrefix } from '../store/secrets';
import type {
  ExtKind, ExtRecord, ExtSourceType, InstallPreview, InstallResult, RegistryFile, TrustInfo, UpdateResult,
} from './types';
import { extId, extSecretPrefix } from './types';
import type { FileMap, SourceInput } from './sources';
import { materializeSource } from './sources';
import { parseSkillMd, skillCapabilities, validateSkillFiles } from './skills';
import { mcpCapabilities, parseMcpConfigJson, splitMcpSecrets } from './mcp';
import { hookCapabilities, hookTrustInfo, validateHooksJson, type HookDef } from './hooks';
import { parseWorkflowDoc, WORKFLOW_FILE_CAP, workflowCapabilities } from './workflows';

export function resolveExtRoot(userDataPath?: string): string {
  const dir = path.join(path.dirname(resolveDbPath(userDataPath)), 'extensions');
  for (const sub of ['', 'skills', 'mcp', 'hooks', 'workflows']) {
    fs.mkdirSync(sub ? path.join(dir, sub) : dir, { recursive: true });
  }
  return dir;
}

/** SHA-256 over sorted rel-path + contents. */
export function hashFiles(files: FileMap): string {
  const h = crypto.createHash('sha256');
  for (const rel of [...files.keys()].sort()) {
    h.update(rel);
    h.update('\0');
    h.update(String(files.get(rel)!.length));
    h.update('\0');
    h.update(files.get(rel)!);
  }
  return h.digest('hex');
}

function readDirFiles(dir: string): FileMap {
  const files: FileMap = new Map();
  if (!fs.existsSync(dir)) return files;
  const walk = (d: string, base: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) files.set(rel, fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return files;
}

/** Read an install location that may be a directory (skills) or a file (mcp/hook/workflow). */
function readLocationFiles(loc: string): FileMap {
  const st = fs.statSync(loc);
  if (st.isDirectory()) return readDirFiles(loc);
  return new Map([[path.basename(loc), fs.readFileSync(loc)]]);
}

function writeFiles(destDir: string, files: FileMap): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const [rel, buf] of files) {
    // Belt-and-braces: only relative paths inside dest.
    if (rel.startsWith('/') || rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error(`unsafe path in extension: ${rel}`);
    }
    const full = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
}

interface BuiltExt {
  name: string;
  version: string;
  author?: string;
  capabilities: string[];
  trust: TrustInfo | null;
  /** Files to persist under the extension folder. */
  persist: FileMap;
  extra: Partial<ExtRecord>;
  /** Hook entries to apply to the global hooks file. */
  hooks?: HookDef[];
  /** Secret values to store (final services, derived from the record id). */
  secretPlacements?: Array<{ service: string; value: string }>;
}

const HOOKS_FILE = 'hooks.json';

export class ExtStore {
  constructor(readonly root: string, private db: DatabaseSync) {
    for (const sub of ['', 'skills', 'mcp', 'hooks', 'workflows']) {
      fs.mkdirSync(sub ? path.join(root, sub) : root, { recursive: true });
    }
    if (!fs.existsSync(this.regPath)) {
      fs.writeFileSync(this.regPath, JSON.stringify({ version: 1, extensions: [] }, null, 1));
    }
    if (!fs.existsSync(this.hooksPath)) fs.writeFileSync(this.hooksPath, '[]');
  }

  get regPath(): string {
    return path.join(this.root, 'registry.json');
  }

  get hooksPath(): string {
    return path.join(this.root, 'hooks', HOOKS_FILE);
  }

  readRegistry(): RegistryFile {
    try {
      const r = JSON.parse(fs.readFileSync(this.regPath, 'utf8')) as RegistryFile;
      if (r && r.version === 1 && Array.isArray(r.extensions)) return r;
    } catch { /* corrupt -> reset below */ }
    return { version: 1, extensions: [] };
  }

  private writeRegistry(r: RegistryFile): void {
    fs.writeFileSync(this.regPath, JSON.stringify(r, null, 1));
  }

  /** List records; re-check hashes and disable anything modified on disk. */
  list(): ExtRecord[] {
    const reg = this.readRegistry();
    let changed = false;
    for (const rec of reg.extensions) {
      if (rec.tampered) continue;
      const loc = this.location(rec);
      let current = 'missing';
      try {
        if (loc && fs.existsSync(loc)) current = hashFiles(readLocationFiles(loc));
      } catch {
        current = 'unreadable';
      }
      if (current !== rec.hash) {
        rec.tampered = true;
        rec.enabled = false;
        changed = true;
      }
    }
    if (changed) this.writeRegistry(reg);
    return reg.extensions;
  }

  get(id: string): ExtRecord | undefined {
    return this.list().find((r) => r.id === id);
  }

  /** Patch one record (tool policy, flags). Tampered records stay disabled. */
  updateRecord(id: string, patch: Partial<ExtRecord>): ExtRecord {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    if (patch.enabled && rec.tampered) throw new Error('extension was modified on disk — remove and reinstall to re-approve');
    Object.assign(rec, patch);
    this.writeRegistry(reg);
    return rec;
  }

  location(rec: ExtRecord): string | null {
    switch (rec.kind) {
      case 'skill': return path.join(this.root, 'skills', rec.name);
      case 'workflow': return path.join(this.root, 'workflows', `${rec.name}.workflow.json`);
      case 'mcp': return path.join(this.root, 'mcp', `${rec.name}.servers.json`);
      case 'hook': return path.join(this.root, 'hooks', `${rec.name}.json`);
    }
  }

  takenNames(kind: ExtKind): Set<string> {
    return new Set(this.readRegistry().extensions.filter((r) => r.kind === kind).map((r) => r.name));
  }

  // --- hooks file (global list; ext entries carry extId) ---

  readHooksFile(): HookDef[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.hooksPath, 'utf8')) as unknown;
      const { hooks } = validateHooksJson(v);
      return hooks;
    } catch {
      return [];
    }
  }

  writeHooksFile(hooks: HookDef[]): void {
    fs.writeFileSync(this.hooksPath, JSON.stringify(hooks, null, 1));
  }

  /** Effective hooks: global enabled state AND owning extension enabled. */
  effectiveHooks(): HookDef[] {
    const byId = new Map(this.list().map((r) => [r.id, r]));
    return this.readHooksFile().filter((h) => {
      if (h.enabled === false) return false;
      if (!h.extId) return true;
      return byId.get(h.extId)?.enabled === true;
    });
  }

  // --- MCP configs (per-extension files under mcp/) ---

  mcpConfigs(): Array<{ extId: string; servers: Record<string, import('./mcp').McpServerConf> }> {
    const out: Array<{ extId: string; servers: Record<string, import('./mcp').McpServerConf> }> = [];
    for (const rec of this.list()) {
      if (rec.kind !== 'mcp' || !rec.enabled) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.root, 'mcp', `${rec.name}.servers.json`), 'utf8'));
        const { servers } = parseMcpConfigJson(raw);
        out.push({ extId: rec.id, servers });
      } catch { /* corrupt file: shows as tampered on next list() */ }
    }
    return out;
  }

  // --- install / update ---

  async preview(source: SourceInput): Promise<InstallPreview> {
    const { files, sourceType } = await materializeSource(source);
    const kind = sourceType === 'paste' ? sourceKind(source) : guessKind(files);
    const built = this.build(kind, files, '');
    return {
      name: built.name, kind, version: built.version, author: built.author,
      capabilities: built.capabilities, trust: built.trust, files: [...files.keys()].sort(),
    };
  }

  /** Diff a candidate update against the installed record before applying. */
  async updatePreview(id: string, source: SourceInput): Promise<{ preview: InstallPreview; added: string[]; grew: boolean }> {
    const rec = this.get(id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    const { files, sourceType } = await materializeSource(source);
    void sourceType;
    const built = this.build(rec.kind, files, '', rec.name);
    const added = built.capabilities.filter((c) => !rec.capabilities.includes(c));
    return {
      preview: {
        name: built.name, kind: rec.kind, version: built.version, author: built.author,
        capabilities: built.capabilities, trust: built.trust, files: [...files.keys()].sort(),
      },
      added,
      grew: added.length > 0,
    };
  }

  async install(source: SourceInput, opts: { enable?: boolean } = {}): Promise<InstallResult> {
    const { files, detail, sourceType } = await materializeSource(source);
    const kind = sourceType === 'paste' ? sourceKind(source) : guessKind(files);
    const built = this.build(kind, files, detail);
    if (this.takenNames(kind).has(built.name)) {
      throw new Error(`duplicate ${kind} name: ${built.name} (remove it first to reinstall)`);
    }
    const record: ExtRecord = {
      id: extId(kind, built.name),
      kind,
      name: built.name,
      source: { type: sourceType, detail },
      version: built.version,
      author: built.author,
      enabled: false, // OFF by default until the user reviews and enables
      trusted: false,
      installedAt: Date.now(),
      hash: hashFiles(built.persist),
      capabilities: built.capabilities,
      ...built.extra,
    };
    this.persistBuilt(kind, built.name, built);
    if (built.hooks) this.applyHookEntries(record.id, built.hooks);
    if (built.secretPlacements) {
      for (const p of built.secretPlacements) setSecret(this.db, p.service, p.value);
    }
    const reg = this.readRegistry();
    reg.extensions.push(record);
    this.writeRegistry(reg);
    if (opts.enable) {
      const gated = this.enable(record.id, { trustAccepted: false });
      if (gated.status === 'needs-trust') return { status: 'needs-trust', preview: await this.previewOf(record) };
    }
    return { status: 'installed', record };
  }

  enable(id: string, opts: { trustAccepted?: boolean } = {}): { status: 'enabled' } | { status: 'needs-trust'; trust: TrustInfo } {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    if (rec.tampered) throw new Error('extension was modified on disk — remove and reinstall to re-approve');
    if (rec.kind === 'hook' && !rec.trusted && !opts.trustAccepted) {
      const trust = this.trustFor(rec);
      if (trust) return { status: 'needs-trust', trust };
    }
    if (opts.trustAccepted) rec.trusted = true;
    rec.enabled = true;
    delete rec.tampered;
    this.writeRegistry(reg);
    return { status: 'enabled' };
  }

  trust(id: string): void {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    rec.trusted = true;
    rec.enabled = true;
    this.writeRegistry(reg);
  }

  disable(id: string): void {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    rec.enabled = false;
    this.writeRegistry(reg);
  }

  async update(id: string, source: SourceInput): Promise<UpdateResult> {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    const { files, detail, sourceType } = await materializeSource(source);
    const built = this.build(rec.kind, files, detail, rec.name);
    if (built.name !== rec.name) throw new Error(`update is for a different ${rec.kind} (${built.name} ≠ ${rec.name})`);
    const added = built.capabilities.filter((c) => !rec.capabilities.includes(c));
    const grew = added.length > 0;
    this.persistBuilt(rec.kind, rec.name, built);
    if (built.hooks) this.applyHookEntries(rec.id, built.hooks);
    if (built.secretPlacements) {
      for (const p of built.secretPlacements) setSecret(this.db, p.service, p.value);
    }
    rec.capabilities = built.capabilities;
    rec.hash = hashFiles(built.persist);
    rec.source = { type: sourceType, detail };
    if (built.version) rec.version = built.version;
    if (built.extra.servers) rec.servers = built.extra.servers;
    if (grew) {
      // Permissions grew: disable until the user re-approves.
      rec.enabled = false;
      if (rec.kind === 'hook') rec.trusted = false;
    }
    this.writeRegistry(reg);
    return { record: rec, added, grew };
  }

  remove(id: string): void {
    const reg = this.readRegistry();
    const rec = reg.extensions.find((r) => r.id === id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    const loc = this.location(rec);
    if (loc) fs.rmSync(loc, { recursive: true, force: true });
    if (rec.kind === 'hook') {
      this.writeHooksFile(this.readHooksFile().filter((h) => h.extId !== id));
    }
    deleteSecretsByPrefix(this.db, extSecretPrefix(id));
    reg.extensions = reg.extensions.filter((r) => r.id !== id);
    this.writeRegistry(reg);
  }

  /** Raw files for the source viewer (capped). */
  readSource(id: string): Array<{ path: string; content: string; truncated: boolean }> {
    const rec = this.get(id);
    if (!rec) throw new Error(`unknown extension: ${id}`);
    const loc = this.location(rec);
    if (!loc) return [];
    const files = readLocationFiles(loc);
    return [...files.entries()].slice(0, 50).map(([rel, buf]) => ({
      path: rel || path.basename(loc),
      content: buf.length > 100 * 1024 ? buf.subarray(0, 100 * 1024).toString('utf8') : buf.toString('utf8'),
      truncated: buf.length > 100 * 1024,
    }));
  }

  /** Seed bundled examples as disabled extensions (first run only). */
  seedExamples(examplesRoot: string): void {
    // Layout: <root>/skills/<skill-name>/..., <root>/workflows/<name>.workflow.json
    const jobs: Array<{ kind: ExtKind; files: FileMap; detail: string }> = [];
    try {
      for (const name of fs.readdirSync(path.join(examplesRoot, 'skills'))) {
        const full = path.join(examplesRoot, 'skills', name);
        if (!fs.statSync(full).isDirectory()) continue;
        const files: FileMap = new Map();
        const walk = (d: string, base: string) => {
          for (const x of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, x.name);
            const rel = base ? `${base}/${x.name}` : x.name;
            if (x.isDirectory()) walk(f, rel);
            else if (x.isFile()) files.set(rel, fs.readFileSync(f));
          }
        };
        walk(full, '');
        jobs.push({ kind: 'skill', files, detail: `bundled: ${name}` });
      }
      for (const name of fs.readdirSync(path.join(examplesRoot, 'workflows'))) {
        if (!name.endsWith('.workflow.json')) continue;
        const full = path.join(examplesRoot, 'workflows', name);
        if (!fs.statSync(full).isFile()) continue;
        jobs.push({ kind: 'workflow', files: new Map([[name, fs.readFileSync(full)]]), detail: `bundled: ${name}` });
      }
    } catch {
      return;
    }
    for (const job of jobs) {
      try {
        const built = this.build(job.kind, job.files, job.detail, undefined, true);
        if (this.takenNames(job.kind).has(built.name)) continue;
        const record: ExtRecord = {
          id: extId(job.kind, built.name),
          kind: job.kind,
          name: built.name,
          source: { type: 'example', detail: job.detail },
          version: built.version,
          enabled: false,
          trusted: false,
          installedAt: Date.now(),
          hash: hashFiles(built.persist),
          capabilities: built.capabilities,
          ...built.extra,
        };
        this.persistBuilt(job.kind, built.name, built);
        const reg = this.readRegistry();
        reg.extensions.push(record);
        this.writeRegistry(reg);
      } catch { /* one bad example never breaks startup */ }
    }
  }

  // --- internals ---

  private trustFor(rec: ExtRecord): TrustInfo | null {
    if (rec.kind === 'hook') {
      const hooks = this.readHooksFile().filter((h) => h.extId === rec.id);
      return hookTrustInfo(hooks);
    }
    return null;
  }

  private async previewOf(rec: ExtRecord): Promise<InstallPreview> {
    return {
      name: rec.name, kind: rec.kind, version: rec.version, author: rec.author,
      capabilities: rec.capabilities, trust: this.trustFor(rec), files: [],
    };
  }

  private persistBuilt(kind: ExtKind, name: string, built: BuiltExt): void {
    if (kind === 'workflow') {
      const loc = path.join(this.root, 'workflows', `${name}.workflow.json`);
      fs.mkdirSync(path.dirname(loc), { recursive: true });
      const only = [...built.persist.values()][0];
      fs.writeFileSync(loc, only);
    } else if (kind === 'mcp') {
      const loc = path.join(this.root, 'mcp', `${name}.servers.json`);
      fs.mkdirSync(path.dirname(loc), { recursive: true });
      fs.writeFileSync(loc, [...built.persist.values()][0]);
    } else if (kind === 'hook') {
      const loc = path.join(this.root, 'hooks', `${name}.json`);
      fs.writeFileSync(loc, [...built.persist.values()][0]);
    } else {
      writeFiles(path.join(this.root, 'skills', name), built.persist);
    }
  }

  private applyHookEntries(extIdStr: string, hooks: HookDef[]): void {
    const rest = this.readHooksFile().filter((h) => h.extId !== extIdStr);
    this.writeHooksFile([...rest, ...hooks.map((h) => ({ ...h, extId: extIdStr }))]);
  }

  private templateExists(idOrTrigger: string): boolean {
    try {
      const row = this.db.prepare('SELECT 1 FROM templates WHERE id = ? OR trigger = ?').get(idOrTrigger, idOrTrigger);
      return !!row;
    } catch {
      return true;
    }
  }

  private build(kind: ExtKind, files: FileMap, detail: string, expectName?: string, lenient = false): BuiltExt {
    void detail;
    if (kind === 'skill') {
      const skill = validateSkillFiles(files, expectName ? new Set() : this.takenNames('skill'));
      if (expectName && skill.name !== expectName) throw new Error(`update is for a different skill (${skill.name})`);
      const hasScripts = [...files.keys()].some((k) => k.includes('scripts/'));
      const base = [...files.keys()].find((k) => k.endsWith('/SKILL.md'))?.replace(/\/SKILL\.md$/, '');
      const persist: FileMap = new Map();
      for (const [rel, buf] of files) {
        persist.set(base && rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : rel, buf);
      }
      return {
        name: skill.name, version: skill.version || '0.1.0', author: skill.author,
        capabilities: skillCapabilities(skill, hasScripts), trust: null, persist, extra: {},
      };
    }
    if (kind === 'workflow') {
      const rels = [...files.keys()].filter((k) => k.endsWith('.workflow.json'));
      if (rels.length !== 1) throw new Error('workflow install needs exactly one *.workflow.json file');
      const buf = files.get(rels[0])!;
      if (buf.length > WORKFLOW_FILE_CAP) throw new Error('workflow too large (cap 200KB)');
      const doc = parseWorkflowDoc(JSON.parse(buf.toString('utf8')), { templateExists: (t) => this.templateExists(t) });
      const trigger = doc.kind === 'ext' ? doc.workflow.trigger : doc.workflow.trigger;
      const name = trigger.slice(1);
      if (this.takenNames('workflow').has(name) && name !== expectName && !lenient) {
        throw new Error(`duplicate workflow trigger: ${trigger}`);
      }
      const title = doc.workflow.title;
      const caps = doc.kind === 'ext' ? workflowCapabilities(doc.workflow) : ['Legacy workflow (prompts and transforms only)'];
      return {
        name, version: doc.kind === 'ext' ? '1.0.0' : '0.1.0', capabilities: caps, trust: null,
        persist: new Map([[`${name}.workflow.json`, buf]]), extra: {},
      };
    }
    if (kind === 'mcp') {
      const rel = [...files.keys()].find((k) => k.endsWith('servers.json'));
      if (!rel) throw new Error('mcp install needs a servers.json file');
      const { servers, errors } = parseMcpConfigJson(JSON.parse(files.get(rel)!.toString('utf8')));
      if (!Object.keys(servers).length) throw new Error(`no valid servers: ${errors.join('; ') || 'empty'}`);
      if (errors.length && !lenient) throw new Error(`invalid servers: ${errors.join('; ')}`);
      const name = deriveGroupName(files, rel);
      if (this.takenNames('mcp').has(name) && name !== expectName && !lenient) throw new Error(`duplicate mcp group: ${name}`);
      // Secrets leave the JSON at install time; placeholder services use the
      // final record id so update/uninstall stay consistent.
      const groupId = extId('mcp', expectName || name);
      const { config, secrets, values } = splitMcpSecrets(
        servers, (srv, key) => `${extSecretPrefix(groupId)}mcp:${srv}:${key}`);
      const placements = secrets.map((s) => ({ service: s.service, value: values[s.service] }));
      const caps = Object.entries(servers).flatMap(([srv, conf]) =>
        mcpCapabilities(srv, conf).map((c) => `${srv}: ${c}`));
      const stdio = Object.entries(servers).filter(([, c]) => 'command' in c);
      const trust: TrustInfo | null = stdio.length ? {
        title: 'These MCP servers run programs on your computer',
        lines: stdio.map(([srv, c]) => `${srv}: ${(c as { command: string }).command} ${((c as { args?: string[] }).args || []).join(' ')}`.trim()),
      } : null;
      return {
        name, version: '0.1.0', capabilities: caps, trust,
        persist: new Map([[`${name}.servers.json`, Buffer.from(JSON.stringify({ mcpServers: config }, null, 1))]]),
        extra: { servers: Object.keys(servers) },
        secretPlacements: placements,
      };
    }
    // hook
    const rel = [...files.keys()].find((k) => k.endsWith('hooks.json'));
    if (!rel) throw new Error('hook install needs a hooks.json file');
    const parsed = JSON.parse(files.get(rel)!.toString('utf8'));
    const { hooks, errors } = validateHooksJson(parsed);
    if (errors.length) throw new Error(`invalid hooks: ${errors.join('; ')}`);
    if (!hooks.length) throw new Error('no hooks defined');
    const name = deriveGroupName(files, rel);
    if (this.takenNames('hook').has(name) && name !== expectName && !lenient) throw new Error(`duplicate hook group: ${name}`);
    return {
      name, version: '0.1.0', capabilities: hookCapabilities(hooks), trust: hookTrustInfo(hooks),
      persist: new Map([[`${name}.json`, Buffer.from(JSON.stringify(hooks, null, 1))]]),
      extra: {}, hooks,
    };
  }
}

function sourceKind(source: SourceInput): ExtKind {
  if (source.type === 'paste') return source.kind;
  throw new Error('kind required');
}

/** Guess kind from file layout: SKILL.md | *.workflow.json | servers.json | hooks.json. */
export function guessKind(files: FileMap): ExtKind {
  const keys = [...files.keys()];
  if (keys.some((k) => k === 'SKILL.md' || k.endsWith('/SKILL.md'))) return 'skill';
  if (keys.some((k) => k.endsWith('.workflow.json'))) return 'workflow';
  if (keys.some((k) => k.endsWith('servers.json'))) return 'mcp';
  if (keys.some((k) => k.endsWith('hooks.json'))) return 'hook';
  throw new Error('cannot tell extension kind (need SKILL.md, *.workflow.json, servers.json, or hooks.json)');
}

function deriveGroupName(files: FileMap, rel: string): string {
  const parts = rel.split('/');
  if (parts.length > 1) return sanitize(parts[0]);
  return 'custom';
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
}

/** Installed workflow docs (ext + legacy) with their records. */
export function readInstalledWorkflows(store: ExtStore): Array<{ record: ExtRecord; raw: unknown }> {
  const out: Array<{ record: ExtRecord; raw: unknown }> = [];
  for (const rec of store.list()) {
    if (rec.kind !== 'workflow' || !rec.enabled) continue;
    try {
      const loc = store.location(rec)!;
      out.push({ record: rec, raw: JSON.parse(fs.readFileSync(loc, 'utf8')) });
    } catch { /* tampered handled by list() */ }
  }
  return out;
}

/** Installed skill name+description for prompts and palette (enabled only). */
export function readInstalledSkills(store: ExtStore): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const rec of store.list()) {
    if (rec.kind !== 'skill' || !rec.enabled) continue;
    try {
      const dir = store.location(rec)!;
      const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      const { description } = parseSkillMd(text);
      out.push({ name: rec.name, description });
    } catch { /* skip unreadable */ }
  }
  return out;
}
