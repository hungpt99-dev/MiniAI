// i18n parity + placeholder check. Fails CI on missing keys, placeholder
// mismatches, and hardcoded user-visible strings in the renderer.
// Untranslated keys in shipped non-English locales warn (exit 0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'src', 'main', 'i18n', 'locales');
const rendererJs = path.join(root, 'src', 'renderer', 'app.js');

let errors = 0;
const warn = (m) => console.warn(`[i18n:check] warn: ${m}`);
const fail = (m) => { console.error(`[i18n:check] error: ${m}`); errors++; };

const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
const dicts = new Map();
for (const f of files) {
  try {
    dicts.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8')));
  } catch (e) { fail(`${f}: invalid JSON (${e.message})`); }
}
const en = dicts.get('en') || {};
const enKeys = Object.keys(en);
if (!enKeys.length) fail('en.json has no keys');
const placeholders = (v) => {
  if (typeof v === 'string') return new Set([...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const out = new Set();
  for (const s of Object.values(v)) for (const p of placeholders(s)) out.add(p);
  return out;
};
for (const [tag, dict] of dicts) {
  if (tag === 'en') continue;
  for (const k of enKeys) {
    if (!(k in dict)) { fail(`${tag}.json: missing key "${k}"`); continue; }
    const a = [...placeholders(en[k])].sort().join(',');
    const b = [...placeholders(dict[k])].sort().join(',');
    if (a !== b) fail(`${tag}.json: placeholder mismatch on "${k}" (en {${a}} vs ${tag} {${b}})`);
    if (typeof dict[k] === 'string' && typeof en[k] === 'string' && dict[k] === en[k] && !k.startsWith('attach.reject')) {
      warn(`${tag}.json: untranslated key "${k}"`);
    }
  }
  for (const k of Object.keys(dict)) {
    if (!(k in en)) fail(`${tag}.json: unused key "${k}" (not in en.json)`);
  }
}
// Hardcoded user-visible strings in the renderer (outside t()/esc()/locale dict).
try {
  const src = fs.readFileSync(rendererJs, 'utf8');
  const bad = [
    /\bmemor\$\{/,
    /\? 'y' : 'ies'/,
    /is only available in .* mode\./,
    /Usage: \/remember/,
    /Usage: \/forget/,
    /Nothing remembered matching/,
    /Memory is full — forget something/,
    /Too many attachments \(max 5\)/,
    /attached file\(s\)/,
    / executable files are not allowed/,
  ];
  for (const re of bad) {
    if (re.test(src)) fail(`renderer app.js matches hardcoded-string pattern ${re}`);
  }
} catch (e) { fail(`cannot read renderer: ${e.message}`); }

if (errors) { console.error(`[i18n:check] FAILED (${errors} error(s))`); process.exit(1); }
console.log('[i18n:check] OK');
