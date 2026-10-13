import type { AlwaysRule } from '../agent/types';

/** Extension kinds, one folder per kind under <data>/extensions/. */
export type ExtKind = 'skill' | 'mcp' | 'hook' | 'workflow';

export type ExtSourceType = 'folder' | 'zip' | 'git' | 'paste' | 'example';

export interface ExtSource {
  type: ExtSourceType;
  /** Human-readable origin: path, URL, or "pasted snippet". */
  detail: string;
}

export interface ExtRecord {
  id: string;
  kind: ExtKind;
  /** Unique per kind: skill name, workflow trigger, server group, hook file. */
  name: string;
  source: ExtSource;
  version: string;
  author?: string;
  enabled: boolean;
  /** User explicitly trusted runnable content (stdio servers, hook commands). */
  trusted: boolean;
  installedAt: number;
  /** SHA-256 over installed files; re-checked on load. */
  hash: string;
  tampered?: boolean;
  /** "This extension can:" lines for the install screen. */
  capabilities: string[];
  /** Install-time "always allow" grants (workflows); dropped on uninstall. */
  grants?: AlwaysRule[];
  /** MCP per-tool policy. */
  toolPolicy?: Record<string, 'ask' | 'allow' | 'block'>;
  /** MCP server names owned by this extension. */
  servers?: string[];
}

export interface RegistryFile {
  version: 1;
  extensions: ExtRecord[];
}

/** Trust dialog content: exact commands, never secret values. */
export interface TrustInfo {
  title: string;
  lines: string[];
}

export interface InstallPreview {
  name: string;
  kind: ExtKind;
  version: string;
  author?: string;
  capabilities: string[];
  trust: TrustInfo | null;
  files: string[];
}

export type InstallResult =
  | { status: 'installed'; record: ExtRecord }
  | { status: 'needs-trust'; preview: InstallPreview };

export interface UpdateResult {
  record: ExtRecord;
  /** Added capability lines vs the installed version. */
  added: string[];
  /** True when permissions grew: stays disabled until re-enabled. */
  grew: boolean;
}

export function extId(kind: ExtKind, name: string): string {
  return `${kind}:${name}`;
}

/** Secret-store prefix owned by one extension; wiped on uninstall. */
export function extSecretPrefix(id: string): string {
  return `ext:${id}:`;
}
