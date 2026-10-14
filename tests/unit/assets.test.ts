import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', '..');

function pngDims(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function expectPng(rel: string, w: number, h: number): void {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) throw new Error(`missing ${rel} — run npm run assets`);
  const d = pngDims(f);
  expect(`${rel} ${d.w}x${d.h}`).toBe(`${rel} ${w}x${h}`);
}

// Brand asset refs: every image path named in code/config/docs must exist.
// Fails clearly so a missing `npm run assets` is caught in CI, not at package time.
describe('brand asset refs', () => {
  it('ships C2PA-free SVG sources with the right viewBox', () => {
    for (const [f, vb] of [
      ['assets/icon.svg', '0 0 512 512'],
      ['assets/banner.svg', '0 0 1280 360'],
      ['assets/social-preview.svg', '0 0 1280 640'],
    ] as const) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) throw new Error(`missing ${f}`);
      const t = fs.readFileSync(p, 'utf8');
      expect(t.includes(`viewBox="${vb}"`), `${f} viewBox`).toBe(true);
      expect(/c2pa/i.test(t), `${f} C2PA stripped`).toBe(false);
    }
  });
  it('ships every raster the app and installer need', () => {
    expectPng('assets/icon.png', 1024, 1024);
    for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) expectPng(`assets/icons/icon-${s}.png`, s, s);
    for (const s of [16, 20, 24, 32]) expectPng(`assets/tray/tray-${s}.png`, s, s);
    expectPng('assets/Nexio-Template.png', 18, 18);
    expectPng('assets/Nexio-Template@2x.png', 36, 36);
    expectPng('assets/banner.png', 2560, 720);
    expectPng('assets/social-preview.png', 1280, 640);
    expectPng('docs/images/icon-128.png', 128, 128);
    const ico = path.join(root, 'assets/icon.ico');
    if (!fs.existsSync(ico)) throw new Error('missing assets/icon.ico — run npm run assets');
    const b = fs.readFileSync(ico);
    expect([b[0], b[1], b[2], b[3]]).toEqual([0, 0, 1, 0]);
    const icns = path.join(root, 'assets/icon.icns');
    if (process.platform === 'darwin') {
      if (!fs.existsSync(icns)) throw new Error('missing assets/icon.icns — run npm run assets on macOS');
      expect(fs.readFileSync(icns).toString('ascii', 0, 4)).toBe('icns');
    } else {
      expect(fs.existsSync(icns) || fs.existsSync(icns + '.png'), 'icns or PNG fallback').toBe(true);
    }
    const social = fs.statSync(path.join(root, 'assets/social-preview.png')).size;
    expect(social < 1024 * 1024, `social-preview.png ${social}B < 1MB`).toBe(true);
  });
  it('every asset path named in tray/popup/builder config exists', () => {
    const tray = fs.readFileSync(path.join(root, 'src/main/tray.ts'), 'utf8');
    for (const m of tray.matchAll(/['"]([^'"]+\.png)['"]/g)) {
      const rel = m[1].includes('assets') ? m[1].slice(m[1].indexOf('assets')) : `assets/${m[1]}`;
      if (!fs.existsSync(path.join(root, rel))) throw new Error(`tray.ts ref missing: ${m[1]}`);
    }
    const popup = fs.readFileSync(path.join(root, 'src/main/popup.ts'), 'utf8');
    expect(popup.includes('../assets/icon.png'), 'popup window icon').toBe(true);
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    for (const m of yml.matchAll(/icon:\s*(\S+)/g)) {
      const ref = m[1];
      const p = path.join(root, ref);
      if (ref.endsWith('.icns') && !fs.existsSync(p) && process.platform !== 'darwin') {
        expect(fs.existsSync(`${p}.png`), `${ref} PNG fallback`).toBe(true);
        continue;
      }
      if (!fs.existsSync(p)) throw new Error(`builder icon ref missing: ${ref}`);
    }
  });
  it('window title is Nexio with an SVG favicon, README shows the banner', () => {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    expect(html.includes('<title>Nexio</title>'), 'title').toBe(true);
    expect(html.includes('rel="icon"'), 'favicon').toBe(true);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme.includes('assets/banner.svg'), 'README banner').toBe(true);
  });
});
