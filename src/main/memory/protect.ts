import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeAndResolve } from '../agent/permissions';
import { platform } from '../platform/index';
import { listMemories, memoryHash } from './store';

/** "never touch X" style prohibition inside a folder_rule text. */
const NEVER_RE = /\b(never\s+(touch|delete|remove|modify|change|edit|write(\s+to)?|trash)|don'?t\s+(touch|delete|remove|modify|change|edit|trash)|do\s+not\s+(touch|delete|remove|modify|change|edit|trash)|keep\s+out\s+of|no\s+(deletes?|changes?|edits?|writes?)\s+(in|to|under))\b/i;

/**
 * Best absolute-path candidate in a rule text: quoted paths win, else a
 * drive-absolute or multi-segment rooted path. Single-segment '/final' and
 * bare names are relative mentions, not paths (null → advisory only).
 */
export function extractPathCandidate(text: string): string | null {
  const quoted = text.match(/["“”']([^"“”']{1,260})["“”']/);
  const raw = (quoted?.[1] || text.match(/[A-Za-z]:[\\/][^\s"'“”]+|\/[^\s"'“”]+/)?.[0] || '')
    .trim().replace(/[.,;:!?]+$/, '');
  if (!raw) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
  if (raw.startsWith('/')) {
    return (raw.match(/\//g) || []).length >= 2 ? raw : null;
  }
  return null;
}

/**
 * Parse an unambiguous prohibition into an absolute protected path.
 * A folder-scoped rule with no extractable path protects the scope folder
 * itself; anything else without a path stays advisory (null). Never throws.
 */
export function parseProhibition(text: string, scopePath: string | null, cwd: string): string | null {
  try {
    if (!NEVER_RE.test(text)) return null;
    const cand = extractPathCandidate(text);
    if (cand) return normalizeAndResolve(cand, scopePath || cwd);
    if (scopePath) return normalizeAndResolve(scopePath, cwd);
    return null;
  } catch {
    return null;
  }
}

/** Enforced protected paths from user-approved prohibition rules matching this cwd. */
export function memoryProtectedPaths(db: DatabaseSync, cwd: string, now = Date.now()): string[] {
  const out: string[] = [];
  try {
    const rules = listMemories(db, { kind: 'folder_rule', now })
      .filter((m) => (m.source === 'user_said' || m.source === 'user_approved') && !m.expiresAt);
    for (const m of rules) {
      const scopePath = m.scope.type === 'folder' ? m.scope.path : null;
      // Scope gate: global rules apply; folder rules apply inside their folder.
      if (scopePath) {
        try {
          const resolved = normalizeAndResolve(scopePath, cwd);
          const adapter = platform();
          const norm = adapter.normalizeForCompare(resolved);
          const here = adapter.normalizeForCompare(normalizeAndResolve(cwd, cwd));
          const sep = adapter.key === 'win32' ? '\\' : '/';
          if (here !== norm && !here.startsWith(norm.endsWith(sep) ? norm : norm + sep)) continue;
        } catch {
          continue;
        }
      }
      const p = parseProhibition(m.text, scopePath, cwd);
      if (p && !out.includes(p)) out.push(p);
    }
  } catch { /* enforcement never breaks runs */ }
  return out;
}

/** True when a folder_rule parses to an enforced path (the "Enforced" badge). */
export function isEnforcedRule(text: string, scopePath: string | null, cwd: string): boolean {
  return parseProhibition(text, scopePath, cwd) !== null;
}

const RULES_FILE = path.join('.nexio', 'rules.md');
const RULES_CAP = 20 * 1024;

export interface FolderRulesFile {
  path: string;
  hash: string;
  /** Approved never-touch lines (enforced). */
  enforced: string[];
  /** Everything else: advisory untrusted context. */
  advisory: string;
}

/** Read <cwd>/.nexio/rules.md: approved never-touch lines enforce, the rest is untrusted data. */
export function loadFolderRulesFile(cwd: string, approvals: Record<string, string>): FolderRulesFile | null {
  try {
    const file = path.join(cwd, RULES_FILE);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > RULES_CAP) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const enforced: string[] = [];
    const advisory: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      // Approved never-touch lines enforce only with an extractable path;
      // anything else (bare names, changed lines) stays advisory.
      if (NEVER_RE.test(t) && approvals[t] === memoryHash(t)) {
        const cand = extractPathCandidate(t);
        if (cand) {
          try {
            enforced.push(normalizeAndResolve(cand, cwd));
            continue;
          } catch { /* fall through to advisory */ }
        }
      }
      advisory.push(t);
    }
    return { path: file, hash: memoryHash(raw), enforced, advisory: advisory.join('\n').slice(0, 4000) };
  } catch {
    return null;
  }
}
