/**
 * ONE owner for popup window visibility. Every show/hide/focus of the popup
 * goes through show()/hide()/toggle() with a reason; blur never hides
 * directly — it schedules a recheck that only hides when the pointer is
 * really gone and no grace period, lock, approval or pin says otherwise.
 */

export const VIS_GRACE_MS = {
  /** After show(): clicks landing late still count. */
  afterShow: 600,
  /** After a resize: setBounds can fire blur on some platforms. */
  afterResize: 300,
  /** After a native dialog closes: focus lands late. */
  afterDialog: 400,
  /** After a task finishes: result reading time. */
  afterTask: 1000,
  /** Blur recheck delay: refocus inside this window never hides. */
  blurRecheck: 150,
  /** Pointer halo: inside this margin counts as "entering", recheck instead of hide. */
  pointerHaloPx: 48,
  /** Pointer must be inside bounds + this to count as over the window. */
  pointerMarginPx: 4,
} as const;

export type VisReason =
  | 'hotkey' | 'tray' | 'second-instance' | 'toggle' | 'esc' | 'blur' | 'outside-click'
  | 'notification-click' | 'run-finished' | 'task-finished' | 'dialog'
  | 'resize' | 'pin' | 'setting' | 'startup' | 'test';

export interface VisWindow {
  isVisible(): boolean;
  isDestroyed(): boolean;
  isFocused(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  on?(event: 'focus' | 'blur', cb: () => void): void;
  /** Open devtools keeps the window pinned for debugging. */
  isDevToolsOpened?(): boolean;
}

export interface VisGuards {
  /** Native dialog open (or lock held). */
  dialogOpen(): boolean;
  /** An approval card waits for a decision. */
  approvalOpen(): boolean;
  /** A setBounds/setSize resize is in flight. */
  resizing(): boolean;
}

export interface VisDeps {
  getWin(): VisWindow | null;
  getCursor(): { x: number; y: number } | null;
  isMac(): boolean;
  stealFocus(): void;
  hideOnBlur(): boolean;
  guards?(): VisGuards;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(t: unknown): void;
  log?(...args: unknown[]): void;
}

const DEFAULT_GUARDS: VisGuards = { dialogOpen: () => false, approvalOpen: () => false, resizing: () => false };

let deps: VisDeps | null = null;
let lastShowAt = 0;
let lastResizeAt = 0;
let lastDialogAt = 0;
let lastTaskAt = 0;
let unfocusedShow = false;
let pinned = false;
let pendingHide: unknown = null;

/** Test seam: inject all externals (BrowserWindow, screen, timers). */
export function __setVisDepsForTests(d: VisDeps | null): void {
  deps = d;
  lastShowAt = 0;
  lastResizeAt = 0;
  lastDialogAt = 0;
  lastTaskAt = 0;
  unfocusedShow = false;
  pinned = false;
  pendingHide = null;
}

export function isPinned(): boolean {
  return pinned;
}

export function setPinned(v: boolean): void {
  pinned = v;
}

function safeRequire(p: string): Record<string, unknown> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(p) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function d(): VisDeps {
  if (!deps) {
    // Production wiring, piece by piece: any piece may be missing in tests or
    // headless runs, and the module must still load and degrade gracefully.
    const electron = safeRequire('electron') ?? {};
    const popupMod = safeRequire('../popup');
    const dialogsMod = safeRequire('./dialogs');
    const settingsMod = safeRequire('../store/settings');
    const tasksMod = safeRequire('../tasks/taskHost');
    deps = {
      getWin: () => {
        try { return (popupMod?.getPopup as unknown as () => VisWindow | null)?.() ?? null; }
        catch { return null; }
      },
      getCursor: () => {
        try {
          const screen = electron.screen as { getCursorScreenPoint?: () => { x: number; y: number } } | undefined;
          return screen?.getCursorScreenPoint?.() ?? null;
        } catch { return null; }
      },
      isMac: () => process.platform === 'darwin',
      stealFocus: () => {
        try {
          const app = electron.app as { focus?: (o: unknown) => void } | undefined;
          app?.focus?.({ steal: true });
        } catch { /* best effort */ }
      },
      hideOnBlur: () => {
        try {
          const db = (globalThis as unknown as { __nexioDb?: unknown }).__nexioDb;
          const getSettings = settingsMod?.getSettings as ((db: never) => { hideOnBlur?: boolean }) | undefined;
          if (!getSettings) return true;
          return getSettings(db as never).hideOnBlur !== false;
        } catch { return true; }
      },
      guards: () => {
        let approval = false;
        try {
          const getScheduler = tasksMod?.getScheduler as (() => { counts: () => { approval: number } } | null) | undefined;
          approval = (getScheduler?.()?.counts().approval || 0) > 0;
        } catch { /* scheduler not ready */ }
        let dialog = false;
        try {
          const suppress = dialogsMod?.shouldSuppressBlur as (() => boolean) | undefined;
          dialog = suppress?.() === true;
        } catch { /* dialogs unavailable */ }
        const resizing = resizingFlag;
        return { dialogOpen: () => dialog, approvalOpen: () => approval, resizing: () => resizing };
      },
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as never),
      log: (...a) => console.debug('[vis]', ...a),
    };
  }
  return deps as VisDeps;
}

let resizingFlag = false;

function now(): number {
  try { return d().now?.() ?? Date.now(); } catch { return Date.now(); }
}

function later(fn: () => void, ms: number): void {
  try { d().setTimeout?.(fn, ms); } catch { /* timers unavailable */ }
}

function log(...args: unknown[]): void {
  try { d().log?.(...args); } catch { /* logging never breaks visibility */ }
}

function winState(w: VisWindow | null): string {
  if (!w) return 'no-window';
  try {
    const b = w.getBounds();
    return `visible=${w.isVisible()} focused=${w.isFocused()} bounds=${b.x},${b.y} ${b.width}x${b.height}`;
  } catch {
    return 'dead-window';
  }
}

function alive(w: VisWindow | null | undefined): w is VisWindow {
  try { return !!w && !w.isDestroyed(); } catch { return false; }
}

/** Attach focus/blur tracking to a fresh popup window. */
export function attach(win: VisWindow): void {
  try {
    win.on?.('focus', () => { unfocusedShow = false; });
    win.on?.('blur', () => { onBlur(); });
  } catch { /* window gone */ }
}

/** Mark a resize in flight (blur events during it are ignored). */
export function markResizing(): void {
  resizingFlag = true;
  lastResizeAt = now();
  later(() => { resizingFlag = false; }, VIS_GRACE_MS.afterResize);
}

/** Native dialog closed: grace before blur may hide again. */
export function markDialogClosed(): void {
  lastDialogAt = now();
}

/** A task reached a terminal state: result reading time. */
export function markTaskFinished(): void {
  lastTaskAt = now();
}

export function show(reason: VisReason, w?: VisWindow | null): void {
  const dd = d();
  const win = w === undefined ? dd.getWin() : w;
  if (!alive(win)) { log('show', `reason=${reason}`, 'no-window'); return; }
  if (pendingHide !== null) {
    try { dd.clearTimeout?.(pendingHide); } catch { /* noop */ }
    pendingHide = null;
  }
  try {
    if (!win.isVisible()) win.show();
    win.focus();
    if (dd.isMac()) dd.stealFocus();
  } catch { /* window gone */ }
  lastShowAt = now();
  unfocusedShow = false;
  later(() => {
    try {
      const ww = dd.getWin();
      if (alive(ww) && ww.isVisible() && !ww.isFocused()) unfocusedShow = true;
    } catch { /* noop */ }
  }, 300);
  log('show', `reason=${reason}`, winState(win));
}

export function hide(reason: VisReason, opts: { force?: boolean } = {}): void {
  const dd = d();
  const w = dd.getWin();
  if (!alive(w)) { log('hide', `reason=${reason}`, 'no-window'); return; }
  if (pinned && !opts.force) { log('hide', `reason=${reason}`, 'pinned'); return; }
  if (pendingHide !== null) {
    try { dd.clearTimeout?.(pendingHide); } catch { /* noop */ }
    pendingHide = null;
  }
  try {
    if (w.isVisible()) w.hide();
  } catch { /* window gone */ }
  log('hide', `reason=${reason}`, winState(w));
}

export function toggle(reason: VisReason): void {
  const dd = d();
  const w = dd.getWin();
  if (alive(w) && w.isVisible()) hide(reason);
  else show(reason);
}

function insideBounds(cursor: { x: number; y: number }, margin: number): boolean {
  const dd = d();
  const w = dd.getWin();
  if (!alive(w)) return false;
  try {
    const b = w.getBounds();
    return cursor.x >= b.x - margin && cursor.x <= b.x + b.width + margin &&
      cursor.y >= b.y - margin && cursor.y <= b.y + b.height + margin;
  } catch {
    return false;
  }
}

function shouldHide(nowMs: number): { hide: boolean; why: string } {
  const dd = d();
  const w = dd.getWin();
  if (!alive(w) || !w.isVisible()) return { hide: false, why: 'gone' };
  try {
    if (w.isFocused()) return { hide: false, why: 'focused' };
  } catch { return { hide: false, why: 'dead' }; }
  const g = dd.guards?.() ?? DEFAULT_GUARDS;
  try {
    if (w.isDevToolsOpened?.()) return { hide: false, why: 'devtools' };
  } catch { /* ignore */ }
  if (g.dialogOpen()) return { hide: false, why: 'dialog' };
  if (g.approvalOpen()) return { hide: false, why: 'approval' };
  if (g.resizing()) return { hide: false, why: 'resizing' };
  if (nowMs - lastShowAt < VIS_GRACE_MS.afterShow) return { hide: false, why: 'show-grace' };
  if (nowMs - lastResizeAt < VIS_GRACE_MS.afterResize) return { hide: false, why: 'resize-grace' };
  if (nowMs - lastDialogAt < VIS_GRACE_MS.afterDialog) return { hide: false, why: 'dialog-grace' };
  if (nowMs - lastTaskAt < VIS_GRACE_MS.afterTask) return { hide: false, why: 'task-grace' };
  if (unfocusedShow) return { hide: false, why: 'unfocused-show' };
  let hideOnBlur = true;
  try { hideOnBlur = dd.hideOnBlur(); } catch { /* default on */ }
  if (!hideOnBlur && !pinned) return { hide: false, why: 'setting-off' };
  const cursor = dd.getCursor();
  if (!cursor) return { hide: true, why: 'no-cursor' };
  if (insideBounds(cursor, VIS_GRACE_MS.pointerMarginPx)) return { hide: false, why: 'pointer-inside' };
  return { hide: true, why: 'pointer-outside' };
}

/** Blur never hides directly: recheck after 150ms, then hide only if still valid.
 * A show that never gained focus passes exactly one blur (activation races),
 * then normal rules apply. */
export function onBlur(): void {
  const dd = d();
  const w = dd.getWin();
  if (!alive(w) || !w.isVisible()) return;
  log('blur', winState(w));
  if (unfocusedShow) {
    unfocusedShow = false;
    log('blur', 'unfocused-show-pass');
    return;
  }
  if (pendingHide !== null) return; // one recheck at a time
  try {
    pendingHide = dd.setTimeout?.(() => {
      pendingHide = null;
      const t = now();
      const verdict = shouldHide(t);
      // Near-miss (pointer halo): one more recheck instead of hiding.
      if (verdict.hide) {
        try {
          const cursor = dd.getCursor();
          if (cursor && insideBounds(cursor, VIS_GRACE_MS.pointerHaloPx)) {
            log('blur-recheck', 'halo-recheck');
            if (pendingHide !== null) return;
            pendingHide = dd.setTimeout?.(() => {
              pendingHide = null;
              const v2 = shouldHide(now());
              log('blur-recheck', v2.why, winState(dd.getWin()));
              if (v2.hide) hide('blur');
            }, VIS_GRACE_MS.blurRecheck);
            return;
          }
        } catch { /* fall through to hide */ }
      }
      log('blur-recheck', verdict.why, winState(dd.getWin()));
      if (verdict.hide) hide('blur');
    }, VIS_GRACE_MS.blurRecheck);
  } catch { /* timers unavailable */ }
}
