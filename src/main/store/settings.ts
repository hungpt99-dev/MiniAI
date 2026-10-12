import type { DatabaseSync } from 'node:sqlite';
import type { Mode, ProviderId, RuntimeId, Settings } from '../../shared/types';

export const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'compatible'];
const HOTKEY_RE = /^[A-Za-z0-9+ ]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  theme: 'light',
  hotkey: 'Alt+Space',
  mode: 'chat',
  agentRuntime: 'opencode',
  modeHotkey: 'Alt+M',
};

export function validateSettings(s: Partial<Settings>): string[] {
  const errors: string[] = [];
  const MODES: Mode[] = ['chat', 'agent'];
  const RUNTIMES: RuntimeId[] = ['opencode', 'claude', 'codex'];
  if (s.provider !== undefined && !PROVIDERS.includes(s.provider)) errors.push(`provider must be one of ${PROVIDERS.join(',')}`);
  if (s.model !== undefined && (typeof s.model !== 'string' || !s.model.trim())) errors.push('model must be non-empty');
  if (s.baseUrl !== undefined && s.baseUrl !== '' && (typeof s.baseUrl !== 'string' || !URL_RE.test(s.baseUrl))) errors.push('baseUrl must be a valid http(s) URL');
  if (s.hotkey !== undefined && (typeof s.hotkey !== 'string' || !HOTKEY_RE.test(s.hotkey))) errors.push('hotkey must match letters/digits joined by + (e.g. Alt+Space)');
  if (s.temperature !== undefined && (typeof s.temperature !== 'number' || s.temperature < 0 || s.temperature > 2)) errors.push('temperature must be 0..2');
  if (s.theme !== undefined && s.theme !== 'light' && s.theme !== 'dark') errors.push('theme must be light or dark');
  if (s.mode !== undefined && !MODES.includes(s.mode)) errors.push('mode must be chat or agent');
  if (s.agentRuntime !== undefined && !RUNTIMES.includes(s.agentRuntime)) errors.push('agentRuntime must be opencode, claude or codex');
  if (s.modeHotkey !== undefined && (typeof s.modeHotkey !== 'string' || !HOTKEY_RE.test(s.modeHotkey))) errors.push('modeHotkey must match letters/digits joined by + (e.g. Alt+M)');
  if (s.opencodeBaseUrl !== undefined && s.opencodeBaseUrl !== '' && (typeof s.opencodeBaseUrl !== 'string' || !URL_RE.test(s.opencodeBaseUrl))) errors.push('opencodeBaseUrl must be a valid http(s) URL');
  if (s.claudeBin !== undefined && s.claudeBin !== '' && (typeof s.claudeBin !== 'string' || !s.claudeBin.trim())) errors.push('claudeBin must be non-empty');
  if (s.codexBin !== undefined && s.codexBin !== '' && (typeof s.codexBin !== 'string' || !s.codexBin.trim())) errors.push('codexBin must be non-empty');
  if (s.agentCwd !== undefined && s.agentCwd !== '' && typeof s.agentCwd !== 'string') errors.push('agentCwd must be a string path');
  return errors;
}

export function getSettings(db: DatabaseSync): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      (out as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    } catch { /* ignore corrupt row */ }
  }
  return out;
}

export function updateSettings(db: DatabaseSync, patch: Partial<Settings>): Settings {
  const errors = validateSettings(patch);
  if (errors.length > 0) throw new Error(`Invalid settings: ${errors.join('; ')}`);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
  }
  return getSettings(db);
}
