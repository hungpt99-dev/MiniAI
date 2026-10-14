/** Main-side locale state: JSON dicts, system detection, pseudo mode. */
import fs from 'node:fs';
import path from 'node:path';
import { FALLBACK_LOCALE, pseudoDict, resolveLocale, translate, type LocaleDict } from '../../shared/i18n';

const cache = new Map<string, LocaleDict>();
let currentTag = FALLBACK_LOCALE;
let dirs: string[] = [];

function localeDir(): string {
  // dist/main/i18n -> dist/main/../.. no: locales ship next to this module.
  for (const d of [path.join(__dirname, 'locales'), path.join(__dirname, '..', 'locales')]) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch { /* try next */ }
  }
  return path.join(__dirname, 'locales');
}

function readDict(tag: string): LocaleDict | null {
  try {
    const raw = fs.readFileSync(path.join(localeDir(), `${tag}.json`), 'utf8');
    const o = JSON.parse(raw) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) return o as LocaleDict;
  } catch { /* missing locale never breaks anything */ }
  return null;
}

/** Tags with a shipped locale file (pseudo appended under NEXIO_PSEUDO_LOCALE=1). */
export function availableLocales(): string[] {
  if (!dirs.length) {
    try {
      dirs = fs.readdirSync(localeDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
    } catch {
      dirs = [FALLBACK_LOCALE];
    }
    if (!dirs.includes(FALLBACK_LOCALE)) dirs.unshift(FALLBACK_LOCALE);
  }
  const out = [...dirs];
  if (process.env.NEXIO_PSEUDO_LOCALE === '1' && !out.includes('pseudo')) out.push('pseudo');
  return out;
}

function enDict(): LocaleDict {
  let d = cache.get(FALLBACK_LOCALE);
  if (!d) {
    d = readDict(FALLBACK_LOCALE) || {};
    cache.set(FALLBACK_LOCALE, d);
  }
  return d;
}

export function loadDict(tag: string): LocaleDict {
  if (tag === 'pseudo' && process.env.NEXIO_PSEUDO_LOCALE === '1') return pseudoDict(enDict());
  const hit = cache.get(tag);
  if (hit) return hit;
  const d = readDict(tag) || {};
  cache.set(tag, d);
  return d;
}

/** Test seam: drop cached dicts/dirs. */
export function __resetI18nForTests(): void {
  cache.clear();
  dirs = [];
  currentTag = FALLBACK_LOCALE;
}

/** Resolve a settings value ('system'/tag) against shipped locales + OS tag. */
export function resolveAppLocale(setting: string | undefined, systemTag: string): string {
  if (!setting || setting === 'system') {
    const sys = String(systemTag || '').replace(/_/g, '-');
    return resolveLocale(sys, availableLocales());
  }
  return resolveLocale(setting, availableLocales());
}

export function setLocale(tag: string): string {
  currentTag = resolveLocale(tag, availableLocales());
  loadDict(currentTag);
  return currentTag;
}

export function getLocaleTag(): string {
  return currentTag;
}

/** Translate in the current locale (English fallback). Never throws. */
export function t(key: string, vars?: Record<string, string | number> & { count?: number }): string {
  return translate(loadDict(currentTag), enDict(), key, vars, currentTag);
}

/** Is this an RTL UI locale (mirrors layout via <html dir>). */
export function isRtl(tag: string): boolean {
  return /^(ar|he|fa|ur)\b/i.test(tag);
}
