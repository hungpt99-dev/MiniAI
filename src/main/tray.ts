import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { togglePopup, getPopup } from './popup';
import { isPinned, setPinned } from './app/window-visibility';
import { platform } from './platform/index';
import { IpcChannels } from '../shared/ipc-channels';
import { t } from './i18n/index';

let tray: Tray | null = null;

function showAndOpen(view: 'settings' | 'log'): void {
  togglePopup('tray');
  const w = getPopup();
  try { w?.webContents.send(IpcChannels.ui, { open: view }); } catch { /* not ready */ }
}

function iconImage(): Electron.NativeImage {
  const p = platform();
  if (p.key === 'darwin') {
    // Monochrome Template image adapts to light/dark menu bars.
    for (const name of ['Nexio-Template.png', 'Nexio-Template@2x.png']) {
      try {
        const file = path.join(__dirname, '../assets', name);
        if (fs.existsSync(file)) {
          const img = nativeImage.createFromPath(file);
          if (!img.isEmpty()) {
            img.setTemplateImage(true);
            return img;
          }
        }
      } catch { /* try next */ }
    }
    // Artwork TODO (see report): fall back to the app icon so the tray still works.
  }
  // Windows prefers the size-matched tray art; macOS fallback and Linux use the full icon.
  for (const name of ['tray/tray-32.png', 'tray/tray-24.png', 'icon.png']) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, '../assets', name));
      if (!img.isEmpty()) return img;
    } catch { /* try next */ }
  }
  return nativeImage.createEmpty();
}

export function createTray(): Tray {
  if (tray) return tray;
  const p = platform();
  const hotkey = hotkeyLabel();
  tray = new Tray(iconImage());
  tray.setToolTip('Nexio');
  if (p.key === 'darwin') {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t('tray.show'), click: () => togglePopup('tray') },
      { label: t('tray.settings'), accelerator: 'Cmd+,', click: () => showAndOpen('settings') },
      { label: t('tray.runlog'), click: () => showAndOpen('log') },
      { label: pinLabel(), type: 'checkbox', checked: isPinned(), click: () => { togglePin(); } },
      { type: 'separator' },
      { label: t('tray.quit'), accelerator: 'Cmd+Q', click: () => app.quit() },
    ]));
  } else {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `${t('tray.showHide')} (${hotkey})`, click: () => togglePopup('tray') },
      { label: pinLabel(), type: 'checkbox', checked: isPinned(), click: () => { togglePin(); } },
      { type: 'separator' },
      { label: t('tray.quitShort'), click: () => app.quit() },
    ]));
  }
  tray.on('click', () => togglePopup('tray'));
  return tray;
}

function pinLabel(): string {
  try {
    return isPinned() ? t('tray.unpin') : t('tray.pin');
  } catch {
    return 'Pin';
  }
}

function togglePin(): void {
  try {
    setPinned(!isPinned());
    rebuildTray();
  } catch { /* headless tests */ }
}

/** Rebuild the tray menu in the current locale (language switch, no restart). */
export function rebuildTray(): void {
  try {
    tray?.destroy();
  } catch { /* already gone */ }
  tray = null;
  try {
    createTray();
  } catch { /* headless tests */ }
}

function hotkeyLabel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettings } = require('./store/settings') as typeof import('./store/settings');
    const { platform: plat } = require('./platform/index') as typeof import('./platform/index');
    const s = getSettings((globalThis as unknown as { __nexioDb?: unknown }).__nexioDb as never);
    return plat().keyLabel(s.hotkey || 'Alt+Space');
  } catch {
    return 'Alt+Space';
  }
}
