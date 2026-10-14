import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AlwaysRule, PolicyContext, Risk } from './types';
import { platform, type PlatformAdapter } from '../platform/index';

const NULL_BYTE = /\0/;

function isUnc(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

function isDevicePath(p: string): boolean {
  return /^\\\\[.?]\\/.test(p) || /^\/dev\//i.test(p) || /^[A-Za-z]:\/Device\//i.test(p);
}

/**
 * Resolve and normalize a user/model-supplied path BEFORE any policy check.
 * Throws on traversal tricks (null bytes), UNC paths and device paths.
 * Tilde expands on macOS; macOS names compare in NFC form.
 */
export function normalizeAndResolve(p: string, cwd: string, adapter: PlatformAdapter = platform()): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path-rejected: empty path');
  if (NULL_BYTE.test(p)) throw new Error('path-rejected: null byte');
  let trimmed = adapter.expandUser(p.trim());
  if (isUnc(trimmed) || isDevicePath(trimmed)) throw new Error(`path-rejected: forbidden path form: ${trimmed}`);
  // Resolve with the target OS path semantics so win32 paths check correctly on any host.
  const pp = adapter.key === 'win32' ? path.win32 : path.posix;
  const resolved = pp.resolve(cwd, trimmed);
  if (isUnc(resolved) || isDevicePath(resolved)) throw new Error(`path-rejected: resolves outside local fs: ${trimmed}`);
  const out = pp.normalize(resolved);
  return adapter.key === 'darwin' ? out.normalize('NFC') : out;
}

function norm(p: string): string {
  return path.normalize(p);
}

function inside(child: string, parent: string, adapter: PlatformAdapter = platform()): boolean {
  const c = adapter.normalizeForCompare(child);
  const d = adapter.normalizeForCompare(parent);
  const sep = adapter.key === 'win32' ? '\\' : '/';
  return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** Best-effort realpath (symlinks/junctions); falls back to the input when missing. */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch { /* missing path: resolve the nearest existing ancestor instead */ }
  // realpathSync throws for missing files, which would resolve asymmetrically
  // against existing roots (e.g. macOS /var → /private/var). Walk up instead.
  const tail: string[] = [];
  let dir = p;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return p;
    tail.unshift(path.basename(dir));
    try {
      return path.join(fs.realpathSync(parent), ...tail);
    } catch {
      dir = parent;
    }
  }
}

export function isInsideRoots(resolved: string, roots: string[], adapter: PlatformAdapter = platform()): boolean {
  return roots.some((r) => {
    try {
      // Compare resolved-against-resolved so symlinked roots (macOS /tmp,
      // /etc) match what the FS actually sees.
      return inside(realOrSelf(resolved), realOrSelf(norm(r)), adapter);
    } catch {
      return false;
    }
  });
}

function systemRoots(homeDir: string, adapter: PlatformAdapter = platform()): string[] {
  return adapter.protectedPaths(homeDir);
}

const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  'chrome', 'chromium', 'firefox', 'edge', 'safari',
]);

const BROWSER_DIR_RE = /chrome|chromium|firefox|brave|edge|safari|opera|arc|vivaldi|whale/i;

function hasSensitiveSegment(resolved: string): boolean {
  // Split on both separators so win32 paths check correctly on any host.
  const segs = resolved.split(/[\\/]/).map((s) => s.toLowerCase());
  if (segs.includes('.ssh') || segs.includes('.aws') || segs.includes('.gnupg')) return true;
  // browser profile dirs: e.g. AppData/.../Google/Chrome, .../Mozilla/Firefox,
  // ~/Library/Application Support/Google/Chrome, ~/Library/Safari
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === 'safari' && segs[i - 1] === 'library') return true;
    if (segs[i] === 'application support' && segs.slice(i + 1).some((s) => BROWSER_DIR_RE.test(s))) return true;
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if ((segs[i] === 'google' || segs[i] === 'mozilla' || segs[i] === 'microsoft') &&
      (SENSITIVE_SEGMENTS.has(segs[i + 1]) || segs[i + 1].includes('chrome') || segs[i + 1].includes('firefox') || segs[i + 1].includes('edge'))) {
      return true;
    }
  }
  return false;
}

/** macOS removable/other volumes: allowed only when inside allowed roots. */
function isForeignVolume(resolved: string, adapter: PlatformAdapter): boolean {
  if (adapter.key !== 'darwin') return false;
  const parts = path.posix.normalize(resolved).split('/');
  return parts[1] === 'Volumes' && parts.length > 2;
}

/**
 * True when the path may be touched. Only folders the user EXPLICITLY added
 * in Settings override the block (default roots like home never do);
 * otherwise system dirs, .ssh and browser profiles are blocked even with approval.
 */
export function isPathAllowed(resolved: string, ctx: PolicyContext, adapter: PlatformAdapter = platform()): boolean {
  // Enforced memory prohibitions: the user's own "never touch" rules deny first.
  try {
    if (ctx.extraProtected?.some((r) => inside(resolved, norm(r), adapter))) return false;
  } catch { /* fall through */ }
  if (ctx.explicitRoots && isInsideRoots(resolved, ctx.explicitRoots, adapter)) return true;
  // Symlinks/junctions resolving outside every allowed root are blocked —
  // but only when the as-written path claims to be inside (deception).
  // Merely-outside paths keep the normal approval flow.
  try {
    const rp = realOrSelf(resolved);
    if (rp !== norm(resolved)) {
      const claimed = ctx.allowedRoots.some((r) => {
        try { return inside(norm(resolved), norm(r), adapter); } catch { return false; }
      });
      const escaped = !isInsideRoots(rp, ctx.allowedRoots, adapter) &&
        !(ctx.explicitRoots && isInsideRoots(rp, ctx.explicitRoots, adapter));
      if (claimed && escaped) return false;
    }
  } catch { /* fall through to the checks below */ }
  if (systemRoots(ctx.homeDir, adapter).some((r) => inside(resolved, norm(r), adapter))) return false;
  if (isForeignVolume(resolved, adapter) && !isInsideRoots(resolved, ctx.allowedRoots, adapter)) return false;
  if (hasSensitiveSegment(resolved)) return false;
  return true;
}

/** Default allowed roots: home, Desktop, Documents, Downloads, plus working folder. */
export function defaultAllowedRoots(homeDir: string, cwd?: string): string[] {
  const home = homeDir || os.homedir();
  const roots = [home];
  for (const sub of ['Desktop', 'Documents', 'Downloads']) roots.push(path.join(home, sub));
  if (cwd && typeof cwd === 'string' && cwd.trim()) roots.push(path.normalize(cwd));
  return roots;
}

const PATH_KEYS = ['path', 'root', 'from', 'to', 'cwd', 'nameOrPath'];

/** Resolve every path-like field of a tool input; throws on rejection. */
export function resolveInputPaths(toolName: string, input: Record<string, unknown>, cwd: string, adapter: PlatformAdapter = platform()): string[] {
  void toolName;
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (k === 'nameOrPath' && /^(https?:|file:)/i.test(v.trim())) continue; // URL, not a path
    // app_open bare app names ("notepad") are not paths
    if (k === 'nameOrPath' && !/[/\\.]/.test(v)) continue;
    out.push(normalizeAndResolve(v, cwd, adapter));
  }
  return out;
}

export type PolicyAction = 'auto' | 'approval-required' | 'denied';

export interface PolicyDecision {
  action: PolicyAction;
  reason?: string;
}

export function matchesAlwaysAllow(toolName: string, input: Record<string, unknown>, rules: AlwaysRule[], cwd: string, adapter: PlatformAdapter = platform()): boolean {
  const describeCmd = typeof input.command === 'string' ? input.command.trim() : '';
  for (const r of rules) {
    if (r.scope === 'exact-command' && r.command && describeCmd && r.command === describeCmd) return true;
    if (r.scope === 'tool-dir' && r.tool === toolName && r.dir) {
      try {
        const paths = resolveInputPaths(toolName, input, cwd, adapter);
        if (paths.length > 0 && paths.every((p) => inside(p, norm(r.dir as string), adapter))) return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function decidePolicy(
  toolName: string,
  risk: Risk,
  input: Record<string, unknown>,
  ctx: PolicyContext,
  cwd: string,
  adapter: PlatformAdapter = platform(),
): PolicyDecision {
  let paths: string[] = [];
  try {
    paths = resolveInputPaths(toolName, input, cwd, adapter);
  } catch (e) {
    return { action: 'denied', reason: (e as Error).message };
  }
  for (const p of paths) {
    if (!isPathAllowed(p, ctx, adapter)) return { action: 'denied', reason: `blocked path: ${p}` };
  }
  // Write-only protected roots (macOS /Applications): reads pass, writes need explicit roots.
  const writeBlocked = paths.some((p) =>
    adapter.writeProtectedPaths().some((w) => inside(p, norm(w), adapter)) &&
    !(ctx.explicitRoots && isInsideRoots(p, ctx.explicitRoots, adapter)));
  if (writeBlocked && risk !== 'read') {
    return { action: 'denied', reason: 'write-protected path: add it in Settings to allow writes' };
  }
  if (risk === 'destructive') {
    if (matchesAlwaysAllow(toolName, input, ctx.alwaysAllow, cwd, adapter)) return { action: 'auto' };
    return { action: 'approval-required', reason: 'destructive tools always need approval' };
  }
  if (risk === 'write') {
    if (matchesAlwaysAllow(toolName, input, ctx.alwaysAllow, cwd, adapter)) return { action: 'auto' };
    if (!ctx.requireApprovalForWrites && (paths.length === 0 || paths.every((p) => isInsideRoots(p, ctx.allowedRoots, adapter)))) {
      return { action: 'auto' };
    }
    return { action: 'approval-required', reason: 'file writes need approval' };
  }
  // read: auto inside allowed roots, approval outside
  if (paths.length > 0 && !paths.every((p) => isInsideRoots(p, ctx.allowedRoots, adapter))) {
    return { action: 'approval-required', reason: 'outside allowed roots' };
  }
  return { action: 'auto' };
}

/** Minimal JSON-schema check (required + property types) before a tool runs. */
export function validateInput(schema: { required?: string[]; properties: Record<string, { type: string }> }, input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'input must be an object';
  const o = input as Record<string, unknown>;
  for (const key of schema.required || []) {
    if (o[key] === undefined) return `missing required field: ${key}`;
  }
  for (const [key, def] of Object.entries(schema.properties)) {
    const v = o[key];
    if (v === undefined) continue;
    const t = def.type;
    if (t === 'string' && typeof v !== 'string') return `${key} must be a string`;
    if (t === 'number' && typeof v !== 'number') return `${key} must be a number`;
    if (t === 'boolean' && typeof v !== 'boolean') return `${key} must be a boolean`;
    if (t === 'object' && (typeof v !== 'object' || v === null)) return `${key} must be an object`;
  }
  return null;
}
