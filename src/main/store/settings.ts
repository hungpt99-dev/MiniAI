import type { DatabaseSync } from 'node:sqlite';
import type { Mode, ProviderId, Settings } from '../../shared/types';

export const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'compatible'];
const HOTKEY_RE = /^[A-Za-z0-9+ ]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export const DEFAULT_SUGGESTIONS = [
  'Find files I changed today',
  'Open my last downloaded file',
  'Organize Downloads by type',
  "What's using my disk space?",
];

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  sendTemperature: true,
  compatibleImages: 'auto',
  theme: 'light',
  hotkey: 'Alt+Space',
  mode: 'agent',
  modeHotkey: 'Alt+M',
  agentAllowedRoots: [],
  agentAlwaysAllow: [],
  agentStopHotkey: 'Ctrl+Alt+Esc',
  agentMaxCalls: 25,
  requireApprovalForWrites: true,
  askReadEnabled: true,
  askMcpTools: [],
  memoryEnabled: false,
  memoryKinds: { preference: true, fact: true, folder_rule: true, procedure: true, episode: true },
  memorySuggest: false,
  memoryOneTap: true,
  memorySemantic: false,
  memoryUseInAsk: true,
  memoryMaxItems: 500,
  memoryEpisodeDays: 30,
  memoryStaleDays: 180,
  memoryDismissed: [],
  incognito: false,
  onboarded: false,
  suggestions: [...DEFAULT_SUGGESTIONS],
  launchAtLogin: false,
  locale: 'system',
};

export function validateSettings(s: Partial<Settings>): string[] {
  const errors: string[] = [];
  const MODES: Mode[] = ['chat', 'agent'];
  if (s.provider !== undefined && !PROVIDERS.includes(s.provider)) errors.push(`provider must be one of ${PROVIDERS.join(',')}`);
  if (s.model !== undefined && (typeof s.model !== 'string' || !s.model.trim())) errors.push('model must be non-empty');
  if (s.baseUrl !== undefined && s.baseUrl !== '' && (typeof s.baseUrl !== 'string' || !URL_RE.test(s.baseUrl))) errors.push('baseUrl must be a valid http(s) URL');
  if (s.hotkey !== undefined && (typeof s.hotkey !== 'string' || !HOTKEY_RE.test(s.hotkey))) errors.push('hotkey must match letters/digits joined by + (e.g. Alt+Space)');
  if (s.temperature !== undefined && (typeof s.temperature !== 'number' || s.temperature < 0 || s.temperature > 2)) errors.push('temperature must be 0..2');
  if (s.sendTemperature !== undefined && typeof s.sendTemperature !== 'boolean') errors.push('sendTemperature must be boolean');
  if (s.compatibleImages !== undefined && s.compatibleImages !== 'auto' && s.compatibleImages !== 'on' && s.compatibleImages !== 'off') errors.push('compatibleImages must be auto, on or off');
  if (s.theme !== undefined && s.theme !== 'light' && s.theme !== 'dark') errors.push('theme must be light or dark');
  if (s.mode !== undefined && !MODES.includes(s.mode)) errors.push('mode must be chat or agent');
  if (s.modeHotkey !== undefined && (typeof s.modeHotkey !== 'string' || !HOTKEY_RE.test(s.modeHotkey))) errors.push('modeHotkey must match letters/digits joined by + (e.g. Alt+M)');
  if (s.agentCwd !== undefined && s.agentCwd !== '' && typeof s.agentCwd !== 'string') errors.push('agentCwd must be a string path');
  if (s.agentAllowedRoots !== undefined && !Array.isArray(s.agentAllowedRoots)) errors.push('agentAllowedRoots must be an array');
  if (s.agentAlwaysAllow !== undefined && !Array.isArray(s.agentAlwaysAllow)) errors.push('agentAlwaysAllow must be an array');
  if (s.agentStopHotkey !== undefined && (typeof s.agentStopHotkey !== 'string' || !s.agentStopHotkey.trim())) errors.push('agentStopHotkey must be non-empty');
  if (s.agentMaxCalls !== undefined && (typeof s.agentMaxCalls !== 'number' || s.agentMaxCalls < 1 || s.agentMaxCalls > 100)) errors.push('agentMaxCalls must be 1..100');
  if (s.requireApprovalForWrites !== undefined && typeof s.requireApprovalForWrites !== 'boolean') errors.push('requireApprovalForWrites must be boolean');
  if (s.askReadEnabled !== undefined && typeof s.askReadEnabled !== 'boolean') errors.push('askReadEnabled must be boolean');
  if (s.askMcpTools !== undefined && (!Array.isArray(s.askMcpTools) || !s.askMcpTools.every((x) => typeof x === 'string'))) errors.push('askMcpTools must be an array of strings');
  if (s.memoryEnabled !== undefined && typeof s.memoryEnabled !== 'boolean') errors.push('memoryEnabled must be boolean');
  if (s.memoryKinds !== undefined && (typeof s.memoryKinds !== 'object' || Array.isArray(s.memoryKinds) ||
    !['preference', 'fact', 'folder_rule', 'procedure', 'episode'].every((k) => typeof (s.memoryKinds as Record<string, unknown>)[k] === 'boolean'))) errors.push('memoryKinds must be a map of booleans');
  if (s.memorySuggest !== undefined && typeof s.memorySuggest !== 'boolean') errors.push('memorySuggest must be boolean');
  if (s.memoryOneTap !== undefined && typeof s.memoryOneTap !== 'boolean') errors.push('memoryOneTap must be boolean');
  if (s.memorySemantic !== undefined && typeof s.memorySemantic !== 'boolean') errors.push('memorySemantic must be boolean');
  if (s.memoryUseInAsk !== undefined && typeof s.memoryUseInAsk !== 'boolean') errors.push('memoryUseInAsk must be boolean');
  if (s.memoryMaxItems !== undefined && (typeof s.memoryMaxItems !== 'number' || s.memoryMaxItems < 10 || s.memoryMaxItems > 5000)) errors.push('memoryMaxItems must be 10..5000');
  if (s.memoryEpisodeDays !== undefined && (typeof s.memoryEpisodeDays !== 'number' || s.memoryEpisodeDays < 1 || s.memoryEpisodeDays > 365)) errors.push('memoryEpisodeDays must be 1..365');
  if (s.memoryStaleDays !== undefined && (typeof s.memoryStaleDays !== 'number' || s.memoryStaleDays < 7 || s.memoryStaleDays > 3650)) errors.push('memoryStaleDays must be 7..3650');
  if (s.memoryDismissed !== undefined && (!Array.isArray(s.memoryDismissed) || !s.memoryDismissed.every((x) => typeof x === 'string'))) errors.push('memoryDismissed must be an array of strings');
  if (s.memoryNoticeDismissed !== undefined && (typeof s.memoryNoticeDismissed !== 'object' || Array.isArray(s.memoryNoticeDismissed) ||
    !Object.values(s.memoryNoticeDismissed).every((v) => typeof v === 'boolean'))) errors.push('memoryNoticeDismissed must be a map of booleans');
  if (s.memoryRuleApprovals !== undefined && (typeof s.memoryRuleApprovals !== 'object' || Array.isArray(s.memoryRuleApprovals) ||
    !Object.values(s.memoryRuleApprovals).every((v) => typeof v === 'string'))) errors.push('memoryRuleApprovals must be a map of strings');
  if (s.incognito !== undefined && typeof s.incognito !== 'boolean') errors.push('incognito must be boolean');
  if (s.onboarded !== undefined && typeof s.onboarded !== 'boolean') errors.push('onboarded must be boolean');
  if (s.attachNoticeDismissed !== undefined && (typeof s.attachNoticeDismissed !== 'object' || Array.isArray(s.attachNoticeDismissed) ||
    !Object.values(s.attachNoticeDismissed).every((v) => typeof v === 'boolean'))) errors.push('attachNoticeDismissed must be a map of booleans');
  if (s.askReadNoticeDismissed !== undefined && (typeof s.askReadNoticeDismissed !== 'object' || Array.isArray(s.askReadNoticeDismissed) ||
    !Object.values(s.askReadNoticeDismissed).every((v) => typeof v === 'boolean'))) errors.push('askReadNoticeDismissed must be a map of booleans');
  if (s.suggestions !== undefined && (!Array.isArray(s.suggestions) || s.suggestions.length > 8 || !s.suggestions.every((x) => typeof x === 'string' && x.trim()))) errors.push('suggestions must be up to 8 non-empty strings');
  if (s.launchAtLogin !== undefined && typeof s.launchAtLogin !== 'boolean') errors.push('launchAtLogin must be boolean');
  if (s.locale !== undefined && (typeof s.locale !== 'string' || !s.locale.trim() || s.locale.length > 20)) errors.push('locale must be a BCP-47 tag or "system"');
  return errors;
}

/** Keys from the removed external-runtime era; always built-in now, dropped on read. */
const LEGACY_RUNTIME_KEYS = ['agentRuntime', 'agentBackend', 'engine', 'opencodeBaseUrl', 'claudeBin', 'codexBin'];

export function getSettings(db: DatabaseSync): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  let legacy = false;
  for (const r of rows) {
    if (LEGACY_RUNTIME_KEYS.includes(r.key)) { legacy = true; continue; }
    try {
      (out as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    } catch { /* ignore corrupt row */ }
  }
  if (legacy) {
    // Old agentBackend/engine values fall back to built-in; purge the rows once.
    try {
      db.prepare(`DELETE FROM settings WHERE key IN (${LEGACY_RUNTIME_KEYS.map(() => '?').join(',')})`).run(...LEGACY_RUNTIME_KEYS);
    } catch { /* best-effort */ }
  }
  return out;
}

export function updateSettings(db: DatabaseSync, patch: Partial<Settings>): Settings {
  const errors = validateSettings(patch);
  if (errors.length > 0) throw new Error(`Invalid settings: ${errors.join('; ')}`);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || LEGACY_RUNTIME_KEYS.includes(k)) continue;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
  }
  return getSettings(db);
}
