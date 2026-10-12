import type { DatabaseSync } from 'node:sqlite';
import type { ProviderId, Settings } from '../../shared/types';

export const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'compatible'];
const HOTKEY_RE = /^[A-Za-z0-9+ ]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  theme: 'light',
  hotkey: 'Alt+Space',
};

export function validateSettings(s: Partial<Settings>): string[] {
  const errors: string[] = [];
  if (s.provider !== undefined && !PROVIDERS.includes(s.provider)) errors.push(`provider must be one of ${PROVIDERS.join(',')}`);
  if (s.model !== undefined && (typeof s.model !== 'string' || !s.model.trim())) errors.push('model must be non-empty');
  if (s.baseUrl !== undefined && s.baseUrl !== '' && (typeof s.baseUrl !== 'string' || !URL_RE.test(s.baseUrl))) errors.push('baseUrl must be a valid http(s) URL');
  if (s.hotkey !== undefined && (typeof s.hotkey !== 'string' || !HOTKEY_RE.test(s.hotkey))) errors.push('hotkey must match letters/digits joined by + (e.g. Alt+Space)');
  if (s.temperature !== undefined && (typeof s.temperature !== 'number' || s.temperature < 0 || s.temperature > 2)) errors.push('temperature must be 0..2');
  if (s.theme !== undefined && s.theme !== 'light' && s.theme !== 'dark') errors.push('theme must be light or dark');
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
