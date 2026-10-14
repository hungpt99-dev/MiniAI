/** Minimal renderer-safe i18n core: key lookup, ICU-style plurals via
 * Intl.PluralRules, {placeholders}. No dependencies. English is the source
 * of truth and the fallback. Locale dicts live in main (locales/*.json);
 * the renderer receives its dict over IPC and uses the same helpers
 * (mirrored in app.js — keep the two in sync).
 */

export type LocaleDict = Record<string, string | Record<string, string>>;

export const FALLBACK_LOCALE = 'en';

/** Normalize a BCP-47 tag to an available dict ('pt-BR' -> 'pt-BR' | 'pt' | 'en'). */
export function resolveLocale(requested: string | undefined, available: string[]): string {
  const list = (available.length ? available : [FALLBACK_LOCALE]).map((s) => s.toLowerCase());
  const want = String(requested || '').replace(/_/g, '-').toLowerCase();
  if (!want || want === 'system') return FALLBACK_LOCALE;
  if (list.includes(want)) return available[list.indexOf(want)];
  const base = want.split('-')[0];
  if (list.includes(base)) return available[list.indexOf(base)];
  return FALLBACK_LOCALE;
}

/** Pick the plural sub-key for n in locale (Intl-driven: ar/ru get their forms). */
export function pluralKey(locale: string, n: number): string {
  try {
    return new Intl.PluralRules(locale).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] === undefined ? `{${k}}` : String(vars[k]));
}

/** Translate: dict -> fallback -> key itself. Never throws. */
export function translate(
  dict: LocaleDict, fallback: LocaleDict, key: string,
  vars?: Record<string, string | number> & { count?: number },
  locale?: string,
): string {
  try {
    const raw = dict[key] ?? fallback[key] ?? key;
    if (typeof raw === 'string') return fill(raw, vars);
    const n = typeof vars?.count === 'number' ? vars.count : 1;
    const form = pluralKey(locale || FALLBACK_LOCALE, n);
    const template = raw[form] ?? raw.other ?? Object.values(raw)[0] ?? key;
    return fill(String(template), vars);
  } catch {
    return key;
  }
}

/** Pseudo-locale: expand 30-40% with accents to catch overflow/truncation. */
export function pseudoLocalize(text: string): string {
  const map: Record<string, string> = {
    a: 'àáâãäåā', e: 'èéêëēė', i: 'ìíîïī', o: 'òóôõöøō', u: 'ùúûüū',
    c: 'çćč', n: 'ñń', s: 'šśş', z: 'žźż', y: 'ýÿ', d: 'ďđ', t: 'ťţ', l: 'ľł', r: 'řŕ',
  };
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    if (map[low]) {
      const acc = map[low][ch.charCodeAt(0) % map[low].length];
      out += ch === low ? acc : acc.toUpperCase();
      if (/[aeiou]/i.test(ch)) out += '̃';
    } else {
      out += ch;
    }
  }
  return '⟦' + out + '⟧';
}

export function pseudoDict(en: LocaleDict): LocaleDict {
  const out: LocaleDict = {};
  for (const [k, v] of Object.entries(en)) {
    out[k] = typeof v === 'string'
      ? pseudoLocalize(v)
      : Object.fromEntries(Object.entries(v).map(([f, t]) => [f, pseudoLocalize(t)]));
  }
  return out;
}
