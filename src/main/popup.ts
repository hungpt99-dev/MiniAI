import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { IpcChannels } from '../shared/ipc-channels';
import { resetDialogLock, shouldSuppressBlur } from './app/dialogs';
import { platform } from './platform/index';

let win: BrowserWindow | null = null;

// Single source for popup geometry: window size equals panel size exactly (no shadow).
export const POPUP_CONTENT_WIDTH = 640;
export const POPUP_MIN_H = 72;
export const POPUP_MAX_H = 560;

export function getPopup(): BrowserWindow | null {
  return win;
}

export function createPopup(): BrowserWindow {
  if (win) return win;
  const mac = platform().key === 'darwin';
  win = new BrowserWindow({
    ...(mac ? { type: 'panel' as const } : {}),
    width: POPUP_CONTENT_WIDTH,
    height: POPUP_MIN_H,
    frame: false,
    hasShadow: false,
    resizable: false,
    // macOS fullscreen visibility comes from setVisibleOnAllWorkspaces at show time.
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    ...(mac ? { visibleOnAllWorkspaces: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload uses a relative require (../shared); keep sandbox off so it loads.
      // Renderer still only loads the local bundled file, no remote content.
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // NOTE: resizable:false pins min/max to the current size on Windows, so
  // creation-time setMinimum/MaximumSize does not stick — setPopupHeight
  // re-pins (width fixed, height free) on every call instead.
  // Hide (not quit) on blur like a launcher popup — except while a native
  // dialog owns focus (blur fires on the popup when the picker opens).
  win.on('blur', () => {
    if (shouldSuppressBlur(win)) return;
    if (win?.isVisible() && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on('closed', () => { win = null; resetDialogLock(); });
  return win;
}

// Clamp content height, resize only while visible.
export function setPopupHeight(contentH: number): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (typeof contentH !== 'number' || !Number.isFinite(contentH)) return;
  const content = Math.min(POPUP_MAX_H, Math.max(POPUP_MIN_H, Math.round(contentH)));
  // resizable:false pins min/max to current size on Windows — re-pin width,
  // free height on every call (post-show sticks, creation-time does not).
  win.setMinimumSize(POPUP_CONTENT_WIDTH, POPUP_MIN_H);
  win.setMaximumSize(POPUP_CONTENT_WIDTH, POPUP_MAX_H);
  win.setSize(POPUP_CONTENT_WIDTH, content);
}

export function togglePopup(): void {
  const w = getPopup() || createPopup();
  if (w.isVisible()) {
    // Hotkey/tray toggle while a native dialog is open: never hide, refocus.
    if (shouldSuppressBlur(w)) {
      try { w.focus(); } catch { /* window gone */ }
      return;
    }
    w.hide();
  } else {
    // Centered upper-third on the display nearest the cursor (multi-monitor safe).
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
    const winH = w.getSize()[1] || POPUP_MIN_H;
    const x = Math.round(ax + (aw - POPUP_CONTENT_WIDTH) / 2);
    const y = Math.round(ay + Math.max(20, (ah - winH) * 0.22));
    w.setPosition(
      Math.min(Math.max(x, ax), ax + aw - POPUP_CONTENT_WIDTH),
      Math.min(Math.max(y, ay), ay + ah - winH),
    );
    w.show();
    w.focus();
    try {
      if (platform().key === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch { /* older Electron */ }
    try { w.webContents.send(IpcChannels.popupShown); } catch { /* webcontents not ready */ }
  }
}
