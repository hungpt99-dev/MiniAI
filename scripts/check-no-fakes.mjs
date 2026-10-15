// Build gate: test-only providers/servers must never ship. Scans exactly the
// file set electron-builder.yml packages (dist + listed node_modules slices)
// and fails on fake-provider markers. Run: node scripts/check-no-fakes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS = ['Echo:', 'hello to you too', 'NEXIO_E2E', 'FAKE_PROVIDER'];
const ROOTS = ['dist', 'package.json', 'node_modules/@modelcontextprotocol', 'node_modules/ajv',
  'node_modules/content-type', 'node_modules/zod'];

let hits = 0;
function walk(p) {
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === '.git' || e === 'node_modules/.cache') continue;
      walk(path.join(p, e));
    }
    return;
  }
  if (!/\.(js|mjs|cjs|json|html)$/.test(p)) return;
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch { return; }
  for (const m of MARKERS) {
    if (s.includes(m)) { console.error(`[no-fakes] ${m} in ${path.relative(root, p)}`); hits++; }
  }
}
for (const r of ROOTS) walk(path.join(root, r));
// The harness itself must stay out of the package file list.
const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
for (const banned of ['e2e/', 'tests/']) {
  const listed = yml.split('\n').some((l) => l.trim().startsWith('- ') && l.includes(banned));
  if (listed) { console.error(`[no-fakes] packaged file list includes ${banned}`); hits++; }
}
if (hits > 0) {
  console.error(`[no-fakes] FAIL: ${hits} hit(s)`);
  process.exit(1);
}
console.log('[no-fakes] OK: no test providers in packaged inputs');
