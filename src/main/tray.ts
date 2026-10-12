import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import { togglePopup } from './popup';

let tray: Tray | null = null;

export function createTray(): Tray {
  if (tray) return tray;
  const iconPath = path.join(__dirname, '../assets/icon.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('MiniAI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide (Alt+Space)', click: () => togglePopup() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => togglePopup());
  return tray;
}
