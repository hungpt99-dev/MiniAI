import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { ExtKind, ExtSourceType } from './types';

export type FileMap = Map<string, Buffer>; // posix rel path -> content

export type SourceInput =
  | { type: 'folder'; path: string }
  | { type: 'zip'; path: string }
  | { type: 'git'; url: string }
  | { type: 'paste'; kind: ExtKind; text: string };

export const ZIP_MAX_BYTES = 20 * 1024 * 1024;
export const UNPACKED_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 2000;

export type GitRunner = (url: string, dest: string, timeoutMs: number) => Promise<void>;

const defaultGitRunner: GitRunner = (url, dest, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', url, dest], { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } reject(new Error('git clone timed out')); }, timeoutMs);
    timer.unref?.();
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code}): ${err.slice(0, 300)}`));
    });
  });

function checkRel(rel: string): void {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('..')) {
    throw new Error(`zip-slip rejected: ${rel}`);
  }
}

function walkDir(root: string, files: FileMap, base: string, budget: { bytes: number }): void {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    const rel = path.posix.join(base, e.name.split(path.sep).join(path.posix.sep));
    if (files.size >= MAX_FILES) throw new Error(`too many files (cap ${MAX_FILES})`);
    const st = fs.lstatSync(full);
    // No symlinks: they can point outside the extension folder.
    if (st.isSymbolicLink()) throw new Error(`symlink rejected: ${rel}`);
    if (st.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      walkDir(full, files, rel, budget);
    } else if (st.isFile()) {
      budget.bytes += st.size;
      if (budget.bytes > UNPACKED_MAX_BYTES) throw new Error('source too large (cap 100MB unpacked)');
      files.set(rel, fs.readFileSync(full));
    }
  }
}

export function filesFromFolder(dir: string): FileMap {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error('not a folder');
  const files: FileMap = new Map();
  walkDir(dir, files, '', { bytes: 0 });
  if (!files.size) throw new Error('folder is empty');
  return files;
}

// Minimal ZIP reader: stored (0) + deflate (8) via node:zlib. No deps.
export function filesFromZip(zipPath: string): FileMap {
  const buf = fs.readFileSync(zipPath);
  if (buf.length > ZIP_MAX_BYTES) throw new Error('zip too large (cap 20MB)');
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: FileMap = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const name = rawName.replace(/\\/g, '/');
    if (name.endsWith('/')) continue; // directory entry
    checkRel(name);
    if ((mode & 0o170000) === 0o120000) throw new Error(`symlink rejected: ${name}`);
    if (files.size >= MAX_FILES) throw new Error(`too many files (cap ${MAX_FILES})`);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('corrupt zip (local header)');
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataOff, dataOff + compSize);
    let out: Buffer;
    if (method === 0) out = Buffer.from(comp);
    else if (method === 8) out = zlib.inflateRawSync(comp);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    total += out.length;
    if (total > UNPACKED_MAX_BYTES) throw new Error('zip unpacks too large (cap 100MB)');
    files.set(name, out);
  }
  if (!files.size) throw new Error('zip is empty');
  return files;
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip file (EOCD missing)');
}

/** Pasted snippets become a minimal file set by kind. Nothing executes. */
export function filesFromPaste(kind: ExtKind, text: string): FileMap {
  if (!text.trim()) throw new Error('snippet is empty');
  if (Buffer.byteLength(text, 'utf8') > 200 * 1024) throw new Error('snippet too large (cap 200KB)');
  const files: FileMap = new Map();
  if (kind === 'skill') {
    files.set('SKILL.md', Buffer.from(text, 'utf8'));
  } else if (kind === 'workflow') {
    JSON.parse(text); // must be JSON
    files.set('pasted.workflow.json', Buffer.from(text, 'utf8'));
  } else if (kind === 'mcp') {
    JSON.parse(text);
    files.set('servers.json', Buffer.from(text, 'utf8'));
  } else {
    JSON.parse(text);
    files.set('hooks.json', Buffer.from(text, 'utf8'));
  }
  return files;
}

/**
 * Materialize any install source into a file map. Reads + validates only;
 * never executes anything.
 */
export async function materializeSource(
  src: SourceInput,
  opts: { gitRunner?: GitRunner } = {},
): Promise<{ files: FileMap; detail: string; sourceType: ExtSourceType }> {
  if (src.type === 'folder') return { files: filesFromFolder(src.path), detail: src.path, sourceType: 'folder' };
  if (src.type === 'zip') return { files: filesFromZip(src.path), detail: src.path, sourceType: 'zip' };
  if (src.type === 'paste') {
    return { files: filesFromPaste(src.kind, src.text), detail: 'pasted snippet', sourceType: 'paste' };
  }
  if (!/^https:\/\//i.test(src.url)) throw new Error('git URL must be https');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-ext-git-'));
  try {
    await (opts.gitRunner || defaultGitRunner)(src.url, dest, 60_000);
    return { files: filesFromFolder(dest), detail: src.url, sourceType: 'git' };
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}
