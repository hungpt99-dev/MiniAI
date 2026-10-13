// Verify committed brand assets (exists / dims / format / ICO / ICNS / monochrome / <1MB).
// Usage: npm run assets:check — exits non-zero with a clear message on failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];
function fail(msg) { failures.push(msg); console.error(`FAIL ${msg}`); }
function warn(msg) { warnings.push(msg); console.log(`WARN ${msg}`); }
function ok(msg) { console.log(`ok ${msg}`); }

function pngDims(file) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// Minimal PNG decoder: 8-bit RGB/RGBA only (what build-assets.mjs emits).
function pngPixels(file) {
  const b = fs.readFileSync(file);
  let pos = 8;
  let w = 0, h = 0, ctype = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`${file}: only 8-bit PNG supported`);
      ctype = data[9];
      if (ctype !== 2 && ctype !== 6) throw new Error(`${file}: only RGB/RGBA PNG supported`);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  const stride = w * ch;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        const i = y * stride + x * ch + c;
        const a = x > 0 ? out[(y * w + x - 1) * 4 + c] : 0;
        const bb = y > 0 ? out[((y - 1) * w + x) * 4 + c] : 0;
        const cc = x > 0 && y > 0 ? out[((y - 1) * w + x - 1) * 4 + c] : 0;
        let v = raw[p + i];
        if (filter === 1) v = (v + a) & 255;
        else if (filter === 2) v = (v + bb) & 255;
        else if (filter === 3) v = (v + ((a + bb) >> 1)) & 255;
        else if (filter === 4) {
          const pp = a + bb - cc;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : cc)) & 255;
        } else if (filter !== 0) throw new Error(`${file}: unknown filter ${filter}`);
        out[(y * w + x) * 4 + c] = v;
      }
      if (ch === 3) out[(y * w + x) * 4 + 3] = 255;
    }
    p += 0;
  }
  return { w, h, pixels: out };
}

function expectPng(rel, w, h) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) return fail(`missing ${rel} — run npm run assets`);
  try {
    const d = pngDims(f);
    if (d.w === w && d.h === h) ok(`${rel} ${w}x${h}`);
    else fail(`${rel} is ${d.w}x${d.h}, want ${w}x${h}`);
  } catch (e) { fail(`${rel}: ${e.message}`); }
}

// Sources: dims + C2PA-free.
for (const [f, vb] of [['assets/icon.svg', '0 0 512 512'], ['assets/banner.svg', '0 0 1280 320'], ['assets/social-preview.svg', '0 0 1280 640']]) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { fail(`missing ${f}`); continue; }
  const t = fs.readFileSync(p, 'utf8');
  if (!t.includes(`viewBox="${vb}"`)) fail(`${f}: viewBox wrong (want ${vb})`);
  else if (/c2pa/i.test(t)) fail(`${f}: C2PA metadata not stripped`);
  else ok(`${f} viewBox ${vb}, no C2PA`);
}

// Icon set.
expectPng('assets/icon.png', 1024, 1024);
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) expectPng(`assets/icons/icon-${s}.png`, s, s);
for (const s of [16, 20, 24, 32]) expectPng(`assets/tray/tray-${s}.png`, s, s);
expectPng('assets/Nexio-Template.png', 18, 18);
expectPng('assets/Nexio-Template@2x.png', 36, 36);
expectPng('assets/banner.png', 2560, 640);
expectPng('assets/social-preview.png', 1280, 640);
expectPng('docs/images/icon-128.png', 128, 128);

// ICO magic.
{
  const f = path.join(root, 'assets/icon.ico');
  if (!fs.existsSync(f)) fail('missing assets/icon.ico — run npm run assets');
  else {
    const b = fs.readFileSync(f);
    if (b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) ok(`assets/icon.ico ${b.length}B`);
    else fail('assets/icon.ico: bad ICO header');
  }
}

// ICNS: required on macOS; elsewhere the committed note + PNG fallback is accepted.
{
  const f = path.join(root, 'assets/icon.icns');
  if (fs.existsSync(f)) {
    const b = fs.readFileSync(f);
    if (b.toString('ascii', 0, 4) === 'icns') ok(`assets/icon.icns ${b.length}B`);
    else fail('assets/icon.icns: bad magic (want icns)');
  } else if (process.platform === 'darwin') {
    fail('missing assets/icon.icns — run npm run assets on macOS');
  } else {
    const note = path.join(root, 'assets/icon.icns.note.txt');
    const fb = path.join(root, 'assets/icon.icns.png');
    if (fs.existsSync(note) && fs.existsSync(fb)) warn('icon.icns absent off-mac (note + PNG fallback present)');
    else fail('missing assets/icon.icns and no note/fallback — run npm run assets');
  }
}

// Template icons: black-only (alpha ramp allowed), names end in Template.
for (const f of ['assets/Nexio-Template.png', 'assets/Nexio-Template@2x.png']) {
  if (!/Template\.png$/.test(f) && !/Template@2x\.png$/.test(f)) fail(`${f}: filename must end in Template`);
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  try {
    const { pixels } = pngPixels(p);
    let bad = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 8 && (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0)) bad++;
    }
    if (bad > 0) fail(`${f}: ${bad} non-black pixels (Template must be black-only)`);
    else ok(`${f} monochrome`);
  } catch (e) { fail(`${f}: ${e.message}`); }
}

// Social <1MB.
{
  const f = path.join(root, 'assets/social-preview.png');
  if (fs.existsSync(f)) {
    const size = fs.statSync(f).size;
    if (size > 1024 * 1024) fail(`social-preview.png ${size}B > 1MB`);
    else ok(`social-preview.png ${size}B < 1MB`);
  }
}

// Builder icon refs resolve.
{
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  for (const m of yml.matchAll(/icon:\s*(\S+)/g)) {
    const ref = m[1];
    const p = path.join(root, ref);
    if (ref.endsWith('.icns') && !fs.existsSync(p) && process.platform !== 'darwin') {
      if (fs.existsSync(p + '.png')) { warn(`builder ref ${ref} falls back to ${ref}.png off-mac`); continue; }
    }
    if (!fs.existsSync(p)) fail(`builder icon ref missing: ${ref}`);
    else ok(`builder ref ${ref}`);
  }
}

if (failures.length > 0) {
  console.error(`assets:check failed (${failures.length})`);
  process.exit(1);
}
console.log(`assets:check passed${warnings.length > 0 ? ` (${warnings.length} warnings)` : ''}`);
