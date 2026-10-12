import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

export function getPopup(): BrowserWindow | null {
  return win;
}

export function createPopup(): BrowserWindow {
  if (win) return win;
  win = new BrowserWindow({
    width: 480,
    height: 640,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Hide (not quit) on blur like a launcher popup.
  win.on('blur', () => {
    if (win?.isVisible() && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on('closed', () => { win = null; });
  return win;
}

export function togglePopup(): void {
  const w = getPopup() || createPopup();
  if (w.isVisible()) {
    w.hide();
  } else {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { width, height } = display.workAreaSize;
    const x = Math.min(Math.max(cursor.x - 240, display.workArea.x), display.workArea.x + width - 480);
    const y = Math.min(Math.max(cursor.y - 100, display.workArea.y), display.workArea.y + height - 640);
    w.setPosition(Math.round(x), Math.round(y));
    w.show();
    w.focus();
  }
}

export function hidePopup(): void {
  win?.hide();
}
