import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { IpcChannels } from '../shared/ipc-channels';
import { resetDialogLock, shouldSuppressBlur } from './app/dialogs';
import { attach as visAttach, show as visShow, hide as visHide, markResizing } from './app/window-visibility';
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
    // why: first click must both activate and hit the button (no dead click).
    ...(mac ? { acceptFirstMouse: true } : {}),
    icon: path.join(__dirname, '../assets/icon.png'),
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
  // Visibility (incl. blur handling) is owned by app/window-visibility.
  visAttach(win as never);
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
  // Same size, same focus: setSize alone never hides (blur during it is ignored).
  markResizing();
  win.setMinimumSize(POPUP_CONTENT_WIDTH, POPUP_MIN_H);
  win.setMaximumSize(POPUP_CONTENT_WIDTH, POPUP_MAX_H);
  win.setSize(POPUP_CONTENT_WIDTH, content);
}

export function togglePopup(reason: 'hotkey' | 'tray' | 'second-instance' | 'toggle' = 'toggle'): void {
  const w = getPopup() || createPopup();
  if (w.isVisible()) {
    // Hotkey/tray toggle while a native dialog is open: never hide, refocus.
    // Explicit toggle bypasses pin (only blur/outside auto-hide respects it).
    if (shouldSuppressBlur(w)) {
      visShow(reason);
      return;
    }
    visHide(reason, { force: true });
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
    visShow(reason);
    try {
      if (platform().key === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch { /* older Electron */ }
    try { w.webContents.send(IpcChannels.popupShown); } catch { /* webcontents not ready */ }
  }
}
