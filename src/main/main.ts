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
  // register() returns false (no throw) on conflict — never fail silently.
  const fallback = hotkey === 'Alt+Space' ? 'Alt+X' : 'Alt+Space';
  if (globalShortcut.register(hotkey, () => togglePopup())) {
    console.log(`[MiniAI] hotkey registered: ${hotkey}`);
  } else if (globalShortcut.register(fallback, () => togglePopup())) {
    console.warn(`[MiniAI] hotkey ${hotkey} taken, using fallback ${fallback}`);
  } else {
    console.error(`[MiniAI] no hotkey registered (${hotkey}, ${fallback} both taken)`);
  }
}

void startup();

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  closeDb();
});
app.on('window-all-closed', () => { /* stay in tray */ });
