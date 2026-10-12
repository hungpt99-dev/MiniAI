import { app, globalShortcut } from 'electron';
import { getDb, closeDb } from './db/db';
import { seedBuiltins } from './db/templates';
import { getSettings } from './store/settings';
import { createPopup, togglePopup } from './popup';
import { createTray } from './tray';
import { registerIpc } from './ipc';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => togglePopup());

async function startup(): Promise<void> {
  await app.whenReady();
  const db = getDb();
  (globalThis as unknown as { __miniaiDb: unknown }).__miniaiDb = db;
  seedBuiltins(db);
  registerIpc();
  createPopup();
  createTray();
  const hotkey = getSettings(db).hotkey || 'Alt+Space';
  try {
    globalShortcut.register(hotkey, () => togglePopup());
  } catch {
    globalShortcut.register('Alt+Space', () => togglePopup());
  }
}

void startup();

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  closeDb();
});
app.on('window-all-closed', () => { /* stay in tray */ });
