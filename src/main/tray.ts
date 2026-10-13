import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { togglePopup, getPopup } from './popup';
import { platform } from './platform/index';
import { IpcChannels } from '../shared/ipc-channels';

let tray: Tray | null = null;

function showAndOpen(view: 'settings' | 'log'): void {
  togglePopup();
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
  tray = new Tray(iconImage());
  tray.setToolTip('Nexio');
  if (p.key === 'darwin') {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Nexio', click: () => togglePopup() },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => showAndOpen('settings') },
      { label: 'Run log', click: () => showAndOpen('log') },
      { type: 'separator' },
      { label: 'Quit Nexio', accelerator: 'Cmd+Q', click: () => app.quit() },
    ]));
  } else {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / Hide (Alt+Space)', click: () => togglePopup() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  }
  tray.on('click', () => togglePopup());
  return tray;
}
