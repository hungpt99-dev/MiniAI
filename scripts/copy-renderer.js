const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  const s = path.join(src, f);
  const d = path.join(dst, f);
  if (fs.statSync(s).isDirectory()) {
    fs.cpSync(s, d, { recursive: true });
  } else {
    fs.copyFileSync(s, d);
  }
}
console.log('renderer copied to', dst);
// assets -> dist/assets (tray icon, installer, bundled example extensions)
const aSrc = path.join(__dirname, '..', 'assets');
const aDst = path.join(__dirname, '..', 'dist', 'assets');
function copyTree(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(s)) {
    const ps = path.join(s, f);
    const pd = path.join(d, f);
    if (fs.statSync(ps).isDirectory()) copyTree(ps, pd);
    else fs.copyFileSync(ps, pd);
  }
}
if (fs.existsSync(aSrc)) {
  copyTree(aSrc, aDst);
  console.log('assets copied to', aDst);
}
// i18n locale dicts + intent packs (tsc does not emit JSON next to compiled JS)
for (const sub of ['i18n/locales', 'i18n/intents']) {
  const s = path.join(__dirname, '..', 'src', 'main', sub);
  const d = path.join(__dirname, '..', 'dist', 'main', sub);
  if (fs.existsSync(s)) {
    copyTree(s, d);
    console.log('i18n copied:', sub);
  }
}
