import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');

describe('pin: session keep-open across Alt+P, /pin, tray and badge', () => {
  it('renderer: Alt+P, /pin case, badge paint and toggle wiring', () => {
    const src = appJs();
    expect(src).toContain("e.key === 'p' || e.key === 'P'");
    expect(src).toContain('void togglePin()');
    expect(src).toContain("if (trigger === '/pin')");
    expect(src).toContain('var pinState = false;');
    expect(src).toContain('function paintPin()');
    expect(src).toContain('async function togglePin()');
    expect(src).toContain('async function refreshPin()');
    expect(src).toContain('void refreshPin();');
    expect(html()).toContain('id="pin-badge"');
    expect(html()).toContain('aria-label="Window pinned open"');
  });
  it('Esc hides through the module with window.close fallback', () => {
    const src = appJs();
    expect(src).toContain('window.nexio.hidePopup()');
    expect(src).toContain('else window.close?.();');
    const preload = read('src/main/preload.ts');
    expect(preload).toContain('hidePopup');
    expect(preload).toContain('pinGet');
    expect(preload).toContain('pinToggle');
  });
  it('settings checkboxes persist hide-on-blur and compact spacing', () => {
    const h = html();
    expect(h).toContain('id="set-hideblur"');
    expect(h).toContain('id="set-compact"');
    const src = appJs();
    expect(src).toContain('hideOnBlur');
    expect(src).toContain('compactSpacing');
    expect(src).toContain('function applySpaceScale(compact)');
    expect(src).toContain("'0.75'");
  });
  it('tray offers pin with checked state and rebuilds', () => {
    const src = read('src/main/tray.ts');
    expect(src).toContain("togglePopup('tray')");
    expect(src).toContain('pinLabel()');
    expect(src).toContain('togglePin()');
    expect(src).toContain('rebuildTray()');
    for (const tag of ['en', 'vi']) {
      const dict = JSON.parse(read(`src/main/i18n/locales/${tag}.json`));
      expect(typeof dict['tray.pin']).toBe('string');
      expect(typeof dict['tray.unpin']).toBe('string');
      expect(typeof dict['slash.pin']).toBe('string');
    }
  });
  it('/pin registered with scope and localized description', () => {
    const src = read('src/main/slash/registry.ts');
    expect(src).toContain("trigger: '/pin'");
    expect(src).toContain("action: 'pin', scope: 'all'");
    const ipc = read('src/main/ipc.ts');
    expect(ipc).toContain("pin: 'slash.pin'");
  });
});
