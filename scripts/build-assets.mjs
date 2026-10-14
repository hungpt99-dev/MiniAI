// Build all brand raster assets from assets/*.svg (idempotent).
// Sources: assets/icon.svg (512), assets/banner.svg, assets/social-preview.svg.
// Fonts: bundled Geist woff2 only (loadSystemFonts: false), so CI output is stable.
// Usage: npm run assets
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';
import pngToIcoModule from 'png-to-ico';

const pngToIco = pngToIcoModule.default ?? pngToIcoModule.imagesToIco ?? pngToIcoModule;
if (typeof pngToIco !== 'function') throw new Error('png-to-ico export not a function');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const inIcon = path.join(assets, 'icon.svg');
const inBanner = path.join(assets, 'banner.svg');
const inSocial = path.join(assets, 'social-preview.svg');
for (const f of [inIcon, inBanner, inSocial]) {
  if (!fs.existsSync(f)) throw new Error(`missing brand source: ${path.relative(root, f)} (edit design/*.svg first)`);
}

const fontFiles = ['geist-600.woff2', 'geist-500.woff2', 'geist-400.woff2']
  .map((f) => path.join(root, 'src', 'renderer', 'fonts', f));
for (const f of fontFiles) {
  if (!fs.existsSync(f)) throw new Error(`missing bundled font: ${path.relative(root, f)}`);
}

function render(svgText, width) {
  const r = new Resvg(svgText, {
    fitTo: { mode: 'width', value: width },
    // why: bundled woff2 subsets never match resvg's fontdb, so system fonts
    // do the text (SVG fallback stack: Geist -> Segoe UI -> Helvetica...).
    // PNG text may differ subtly per OS; SVG stays the canonical banner.
    font: { fontFiles, loadSystemFonts: true },
  });
  return r.render();
}

function writePng(img, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(img.asPng()));
  console.log(`wrote ${path.relative(root, file)} ${img.width}x${img.height} ${fs.statSync(file).size}B`);
  return img;
}

// N + dot only, black on transparent (no rounded square): macOS Template icon.
function templateSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`
    + `<path d="M148 376V190l216 186V196" fill="none" stroke="#000" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="364" cy="132" r="26" fill="#000"/></svg>`;
}

function assertCornerTransparent(img, label) {
  const { width, height, pixels } = img;
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  for (const [x, y] of corners) {
    if (pixels[(y * width + x) * 4 + 3] !== 0) {
      throw new Error(`${label}: corner pixel (${x},${y}) not transparent — halo outside rounded square`);
    }
  }
}

function assertSafeMargin(img, label, frac = 0.04) {
  // Margin of the inner artwork (N + dot) inside the tile: ignore the
  // rounded-square tile itself (bg #15161B, border #2A2D36) and transparency.
  const { width, height, pixels } = img;
  const isTile = (r, g, b) =>
    (Math.abs(r - 0x15) + Math.abs(g - 0x16) + Math.abs(b - 0x1b) < 36) ||
    (Math.abs(r - 0x2a) + Math.abs(g - 0x2d) + Math.abs(b - 0x36) < 36);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Opaque core only: antialiased tile/border fringe is not artwork.
      if (pixels[i + 3] > 128 && !isTile(pixels[i], pixels[i + 1], pixels[i + 2])) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${label}: no inner artwork found`);
  const m = Math.min(minX, minY, width - 1 - maxX, height - 1 - maxY) / Math.min(width, height);
  if (m < frac) throw new Error(`${label}: artwork margin ${(m * 100).toFixed(1)}% < ${(frac * 100).toFixed(0)}%`);
}

function assertBlackOnly(img, label) {
  const { pixels } = img;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 8 && (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0)) {
      throw new Error(`${label}: non-black pixel (Template icons must be black-only)`);
    }
  }
}

const iconSvg = fs.readFileSync(inIcon, 'utf8');

// 1. Master icon + sized set.
writePng(render(iconSvg, 1024), path.join(assets, 'icon.png'));
const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const s of iconSizes) {
  writePng(render(iconSvg, s), path.join(assets, 'icons', `icon-${s}.png`));
}
// Transparent corners + 4% margin verified on the artwork itself.
{
  const probe = render(iconSvg, 256);
  assertCornerTransparent(probe, 'icon');
  assertSafeMargin(probe, 'icon');
}

// 2. Windows ICO (16–256).
{
  const icoPngs = [16, 24, 32, 48, 64, 128, 256].map((s) => path.join(assets, 'icons', `icon-${s}.png`));
  const ico = await pngToIco(icoPngs);
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.from(ico));
  console.log(`wrote assets/icon.ico ${fs.statSync(path.join(assets, 'icon.ico')).size}B`);
}

// 3. Tray: full-color small sizes + macOS Template pair (black-only, names end in Template).
for (const s of [16, 20, 24, 32]) {
  writePng(render(iconSvg, s), path.join(assets, 'tray', `tray-${s}.png`));
}
{
  const tpl = templateSvg();
  const t1 = render(tpl, 18);
  assertBlackOnly(t1, 'Nexio-Template');
  writePng(t1, path.join(assets, 'Nexio-Template.png'));
  const t2 = render(tpl, 36);
  assertBlackOnly(t2, 'Nexio-Template@2x');
  writePng(t2, path.join(assets, 'Nexio-Template@2x.png'));
}

// 4. Banner 2x + social preview (<1MB).
{
  const b = render(fs.readFileSync(inBanner, 'utf8'), 2560);
  if (b.height !== 720) throw new Error(`banner aspect wrong: ${b.width}x${b.height}, want 2560x720`);
  writePng(b, path.join(assets, 'banner.png'));
}
{
  const s = render(fs.readFileSync(inSocial, 'utf8'), 1280);
  if (s.height !== 640) throw new Error(`social aspect wrong: ${s.width}x${s.height}, want 1280x640`);
  const file = path.join(assets, 'social-preview.png');
  writePng(s, file);
  const size = fs.statSync(file).size;
  if (size > 1024 * 1024) {
    throw new Error(`social-preview.png ${size}B > 1MB — quantize palette (flat artwork should compress far smaller)`);
  }
}

// 5. Docs thumbnail.
writePng(render(iconSvg, 128), path.join(root, 'docs', 'images', 'icon-128.png'));

// 6. macOS ICNS via iconutil; elsewhere a note + PNG fallback.
{
  const icns = path.join(assets, 'icon.icns');
  let made = false;
  if (process.platform === 'darwin') {
    try {
      const set = path.join(assets, 'icon.iconset');
      fs.mkdirSync(set, { recursive: true });
      const pairs = [[16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'], [128, '128x128'], [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x']];
      for (const [size, name] of pairs) {
        fs.copyFileSync(path.join(assets, 'icons', `icon-${size}.png`), path.join(set, `icon_${name}.png`));
      }
      execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);
      fs.rmSync(set, { recursive: true, force: true });
      made = true;
      console.log(`wrote assets/icon.icns ${fs.statSync(icns).size}B`);
    } catch (e) {
      console.log(`iconutil failed (${e.message}); writing note + PNG fallback`);
    }
  }
  if (!made) {
    fs.copyFileSync(path.join(assets, 'icon.png'), path.join(assets, 'icon.icns.png'));
    fs.writeFileSync(path.join(assets, 'icon.icns.note.txt'),
      `icon.icns is built on macOS only (iconutil). This host is ${process.platform}.\n`
      + `Fallback icon.icns.png (1024) is committed for reference.\n`
      + `To finish on a Mac: npm run assets, then commit assets/icon.icns.\n`
      + `GitHub upload path: release assets accept the .dmg/.zip without a separate icon upload.\n`);
    console.log('note: icon.icns skipped off-mac, wrote icon.icns.png fallback + icon.icns.note.txt');
  } else {
    for (const f of ['icon.icns.png', 'icon.icns.note.txt']) {
      const p = path.join(assets, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
}

console.log('assets done');
