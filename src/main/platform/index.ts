import type { PlatformAdapter, PlatformKey } from './types';
import { win32Adapter } from './win32';
import { darwinAdapter } from './darwin';

let override: PlatformAdapter | null = null;
let memo: PlatformAdapter | null = null;

/** Test seam: force a specific adapter regardless of host OS. */
export function __setPlatform(a: PlatformAdapter | null): void {
  override = a;
  memo = a;
}

/** The adapter for this OS, chosen once at startup. */
export function platform(): PlatformAdapter {
  if (memo) return memo;
  // Linux is out of scope: it rides the POSIX (darwin) adapter, unchanged behavior not promised.
  const key = (process.platform === 'win32' ? 'win32' : 'darwin') as PlatformKey;
  memo = key === 'darwin' ? darwinAdapter : win32Adapter;
  return memo;
}

/** Explicit adapter for a platform key (tests run both adapters on any host). */
export function adapterFor(key: PlatformKey): PlatformAdapter {
  return key === 'darwin' ? darwinAdapter : win32Adapter;
}

export type { PlatformAdapter, PlatformKey };
export type {
  AppInfo, KeyCaps, ShellRunOpts, ShellRunResult, RunShellOpts,
} from './types';
