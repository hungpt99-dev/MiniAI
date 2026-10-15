import { app, globalShortcut, Menu, powerMonitor } from 'electron';
import path from 'node:path';
import { getDb, closeDb } from './db/db';
import { seedBuiltins } from './db/templates';
import { getSettings } from './store/settings';
import { resolveAppLocale, setLocale, t } from './i18n/index';
import { createPopup, togglePopup, getPopup } from './popup';
import { confirmQuitWithTasks, resetDialogLock } from './app/dialogs';
import { createTray } from './tray';
import { registerIpc, refreshToggleHotkey, applyLaunchAtLogin } from './ipc';
import { getScheduler, interruptTasksForQuit, runningTaskCount } from './tasks/taskHost';
import { markSecretsReady, scanForReentry } from './secrets/index';
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

export function refreshAppMenu(): void {
  if (platform().key !== 'darwin') return;
  try {
    setupMacMenu();
  } catch { /* headless tests */ }
}

function setupMacMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Nexio',
      submenu: [
        { label: t('tray.settings'), accelerator: 'Cmd+,', click: () => showAndOpen('settings') },
        { type: 'separator' },
        { label: t('tray.quit'), accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: t('menu.edit'),
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
  // Secrets after ready: self-check + mark stored blobs the OS store can no
  // longer decrypt (ids only, never values). Secrets never break startup.
  markSecretsReady();
  try {
    const reentry = scanForReentry(db);
    if (reentry.length > 0) {
      console.warn(`[Nexio] secrets need re-entry: ${reentry.join(',')}`);
    }
  } catch { /* secrets never break startup */ }
  // Locale before any user-facing string: settings value, else OS locale.
  try {
    const s = getSettings(db);
    let sys = 'en';
    try {
      sys = app.getLocale() || 'en';
    } catch { /* headless */ }
    setLocale(resolveAppLocale(s.locale, sys));
  } catch { /* English fallback */ }
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
  // Sleep marks mid-stream tasks interrupted (Retry in Tasks); resume repaints.
  try {
    powerMonitor.on('suspend', () => {
      try { interruptTasksForQuit('sleep'); } catch { /* best-effort */ }
    });
  } catch { /* headless tests */ }
}

void startup();

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  let n = 0;
  try { n = runningTaskCount(); } catch { n = 0; }
  if (n <= 0) return;
  e.preventDefault();
  void (async () => {
    const go = await confirmQuitWithTasks(
      getPopup(),
      t('tasks.quitConfirm', { n }),
      t('tasks.quitStop'),
      t('tasks.keepRunning'),
    );
    if (!go) return;
    try { interruptTasksForQuit('quit'); } catch { /* best-effort */ }
    try { getScheduler()?.interruptAll('quit'); } catch { /* best-effort */ }
    quitting = true;
    app.quit();
  })();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  resetDialogLock();
  void shutdownExtensions().finally(() => closeDb());
});
app.on('window-all-closed', () => { /* stay in tray */ });
