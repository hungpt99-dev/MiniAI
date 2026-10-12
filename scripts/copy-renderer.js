const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('renderer copied to', dst);
// assets -> dist/assets (tray icon, installer)
const aSrc = path.join(__dirname, '..', 'assets');
const aDst = path.join(__dirname, '..', 'dist', 'assets');
if (fs.existsSync(aSrc)) {
  fs.mkdirSync(aDst, { recursive: true });
  for (const f of fs.readdirSync(aSrc)) {
    fs.copyFileSync(path.join(aSrc, f), path.join(aDst, f));
  }
  console.log('assets copied to', aDst);
}
