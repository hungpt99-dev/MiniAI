const fs = require('node:fs');
const path = require('node:path');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-evidence') continue;
      walk(p);
    } else if (/\.md$/.test(e.name)) files.push(p);
  }
})('.');
let bad = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(s))) {
    const u = m[1];
    if (/^(https?:|mailto:|#)/.test(u)) continue;
    const fp = path.join(path.dirname(f), u.split('#')[0]);
    if (!fs.existsSync(fp)) { console.log('BROKEN:', f, '->', u); bad++; }
  }
}
console.log('md files:', files.length, 'broken links:', bad);
