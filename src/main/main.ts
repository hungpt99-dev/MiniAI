import { app, globalShortcut, Menu } from 'electron';
import path from 'node:path';
import { getDb, closeDb } from './db/db';
import { seedBuiltins } from './db/templates';
import { getSettings } from './store/settings';
import { createPopup, togglePopup, getPopup } from './popup';
import { resetDialogLock } from './app/dialogs';
import { createTray } from './tray';
import { registerIpc, refreshToggleHotkey, applyLaunchAtLogin } from './ipc';
import { extService, shutdownExtensions } from './extensions/index';
import { platform } from './platform/index';
import { IpcChannels } from '../shared/ipc-channels';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.setName('Nexio');

app.on('second-instance', () => togglePopup());

function showAndOpen(view: 'settings' | 'log'): void {
  togglePopup();
  const w = getPopup();
  try { w?.webContents.send(IpcChannels.ui, { open: view }); } catch { /* not ready */ }
}

function setupMacMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Nexio',
      submenu: [
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => showAndOpen('settings') },
        { type: 'separator' },
        { label: 'Quit Nexio', accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startup(): Promise<void> {
  await app.whenReady();
  if (platform().key === 'darwin') {
    try { app.dock?.hide(); } catch { /* no dock (already accessory) */ }
    setupMacMenu();
  }
  const db = getDb();
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = db;
  seedBuiltins(db);
  registerIpc();
  try {
    // Seed bundled example extensions (disabled until the user enables them).
    extService(db).store.seedExamples(path.join(__dirname, '..', 'assets', 'extensions'));
    extService(db).autostart();
  } catch { /* extensions never break startup */ }
  createPopup();
  createTray();
  // Only touch login items when the user opted in. The OS persists the item
  // across restarts, so re-applying `false` at every launch is pure harm
  // (it logs "Operation not permitted" noise on macOS).
  try {
    if (getSettings(db).launchAtLogin === true) applyLaunchAtLogin();
  } catch { /* db not ready */ }
  refreshToggleHotkey(() => togglePopup());
}

void startup();

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  resetDialogLock();
  void shutdownExtensions().finally(() => closeDb());
});
app.on('window-all-closed', () => { /* stay in tray */ });
