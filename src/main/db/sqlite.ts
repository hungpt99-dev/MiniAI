import type { DatabaseSync } from 'node:sqlite';

type Ctor = new (path: string) => DatabaseSync;

let cache: Ctor | null = null;

/**
 * Runtime loader for node:sqlite that survives Vite transform (vitest).
 * Uses process.getBuiltinModule so no static 'node:sqlite' specifier exists
 * at runtime for the bundler to resolve. Requires Node 22.5+.
 */
export function getDatabaseSyncCtor(): Ctor {
  if (cache) return cache;
  const gb = (
    process as unknown as { getBuiltinModule?: (id: string) => { DatabaseSync: Ctor } }
  ).getBuiltinModule;
  if (typeof gb !== 'function') throw new Error('node:sqlite requires Node 22.5+');
  cache = gb.call(process, 'node:sqlite').DatabaseSync;
  return cache;
}

export function createDatabase(path: string): DatabaseSync {
  return new (getDatabaseSyncCtor())(path);
}
