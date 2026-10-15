import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  VIS_GRACE_MS,
  __setVisDepsForTests,
  show, hide, toggle, onBlur, attach,
  markResizing, markDialogClosed, markTaskFinished,
  setPinned, isPinned,
} from '../../src/main/app/window-visibility';

const root = path.join(__dirname, '..', '..');

interface FakeWin {
  visible: boolean;
  destroyed: boolean;
  focused: boolean;
  shown: number;
  hidden: number;
  focusedN: number;
  bounds: { x: number; y: number; width: number; height: number };
  handlers: Record<string, Array<() => void>>;
  devtools: boolean;
  isVisible(): boolean;
  isDestroyed(): boolean;
  isFocused(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  on(ev: 'focus' | 'blur', cb: () => void): void;
  isDevToolsOpened(): boolean;
}

function fakeWin(): FakeWin {
  const w: FakeWin = {
    visible: false, destroyed: false, focused: false,
    shown: 0, hidden: 0, focusedN: 0,
    bounds: { x: 100, y: 100, width: 640, height: 200 },
    handlers: {}, devtools: false,
    isVisible() { return this.visible; },
    isDestroyed() { return this.destroyed; },
    isFocused() { return this.focused; },
    show() { this.visible = true; this.shown++; },
    hide() { this.visible = false; this.hidden++; },
    focus() { this.focused = true; this.focusedN++; },
    getBounds() { return { ...this.bounds }; },
    on(ev, cb) { (this.handlers[ev] ||= []).push(cb); },
    isDevToolsOpened() { return this.devtools; },
  };
  return w;
}

function setup(opts: {
  cursor?: { x: number; y: number } | null;
  guards?: { dialogOpen: boolean; approvalOpen: boolean; resizing: boolean };
  hideOnBlur?: boolean;
  isMac?: boolean;
} = {}) {
  const g = opts.guards || { dialogOpen: false, approvalOpen: false, resizing: false };
  const win = fakeWin();
  win.visible = true;
  let now = 100000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const logs: unknown[][] = [];
  const cursorBox: { pos: { x: number; y: number } | null } = {
    pos: opts.cursor === undefined ? { x: 0, y: 0 } : opts.cursor,
  };
  __setVisDepsForTests({
    getWin: () => win,
    getCursor: () => cursorBox.pos,
    isMac: () => opts.isMac === true,
    stealFocus: () => { (win as { stolen?: boolean }).stolen = true; },
    hideOnBlur: () => opts.hideOnBlur !== false,
    guards: () => ({ dialogOpen: () => g.dialogOpen, approvalOpen: () => g.approvalOpen, resizing: () => g.resizing }),
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
    log: (...a) => { logs.push(a); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const i = timers.findIndex((t) => t.at <= now);
      if (i < 0) break;
      const [t] = timers.splice(i, 1);
      t.fn();
    }
  };
  return { win, advance, logs, now: () => now, setCursor: (p: { x: number; y: number } | null) => { cursorBox.pos = p; } };
}

beforeEach(() => {
  __setVisDepsForTests(null as never);
  setPinned(false);
});

describe('window visibility: every transition has a reason', () => {
  it('show focuses, hides route through hide(); toggle flips with reasons logged', () => {
    const { win, logs } = setup();
    win.visible = false;
    show('hotkey');
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(true);
    hide('esc');
    expect(win.visible).toBe(false);
    toggle('tray');
    expect(win.visible).toBe(true);
    const reasons = logs.map((l) => String(l[1] || ''));
    expect(reasons).toContain('reason=hotkey');
    expect(reasons).toContain('reason=esc');
    expect(reasons).toContain('reason=tray');
  });
  it('pin blocks hide except forced', () => {
    const { win } = setup();
    setPinned(true);
    hide('blur');
    expect(win.visible).toBe(true);
    expect(win.hidden).toBe(0);
    hide('esc', { force: true });
    expect(win.visible).toBe(false);
    setPinned(false);
  });
  it('attach wires focus clearing and blur handling', () => {
    const { win } = setup();
    attach(win);
    expect(win.handlers.focus.length).toBe(1);
    expect(win.handlers.blur.length).toBe(1);
  });
});

describe('blur recheck: pointer and grace periods decide', () => {
  it('pointer inside the window never hides', () => {
    const { win, advance } = setup({ cursor: { x: 200, y: 150 } });
    win.focused = false;
    onBlur();
    advance(5000);
    expect(win.visible).toBe(true);
    expect(win.hidden).toBe(0);
  });
  it('pointer within the halo gets a second recheck, then hides when gone', () => {
    const ctx = setup({ cursor: { x: 100 + 640 + 20, y: 150 } }); // halo, outside +4px
    ctx.win.focused = false;
    ctx.advance(VIS_GRACE_MS.afterShow + VIS_GRACE_MS.afterTask + 1000);
    onBlur();
    ctx.advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(ctx.win.visible).toBe(true); // halo: recheck scheduled, not hidden
    ctx.setCursor({ x: 0, y: 0 });
    ctx.advance(VIS_GRACE_MS.blurRecheck + 1000);
    expect(ctx.win.visible).toBe(false);
  });
  it('refocus inside 150ms never hides', () => {
    const ctx = setup({ cursor: { x: 0, y: 0 } });
    ctx.win.focused = false;
    onBlur();
    ctx.advance(100);
    ctx.win.focused = true; // user clicked back fast
    ctx.advance(5000);
    expect(ctx.win.visible).toBe(true);
  });
  it('true blur with pointer outside hides', () => {
    const { win, advance } = setup({ cursor: { x: 0, y: 0 } });
    win.focused = false;
    // outside every grace period
    advance(VIS_GRACE_MS.afterShow + VIS_GRACE_MS.afterTask + 1000);
    onBlur();
    advance(1000);
    expect(win.visible).toBe(false);
    expect(win.hidden).toBe(1);
  });
  it('dialog lock, approval, resizing, pin, setting-off and devtools block hiding', () => {
    for (const guards of [
      { dialogOpen: true, approvalOpen: false, resizing: false },
      { dialogOpen: false, approvalOpen: true, resizing: false },
      { dialogOpen: false, approvalOpen: false, resizing: true },
    ]) {
      const ctx = setup({ cursor: { x: 0, y: 0 }, guards });
      ctx.win.focused = false;
      ctx.advance(100000);
      onBlur();
      ctx.advance(5000);
      expect(ctx.win.visible).toBe(true);
    }
    const dev = setup({ cursor: { x: 0, y: 0 } });
    dev.win.focused = false;
    dev.win.devtools = true;
    dev.advance(100000);
    onBlur();
    dev.advance(5000);
    expect(dev.win.visible).toBe(true);
    const off = setup({ cursor: { x: 0, y: 0 }, hideOnBlur: false });
    off.win.focused = false;
    off.advance(100000);
    onBlur();
    off.advance(5000);
    expect(off.win.visible).toBe(true);
  });
  it('show/resize/dialog/task grace periods block hiding; unfocused show passes once', () => {
    const { win, advance } = setup({ cursor: { x: 0, y: 0 } });
    win.focused = false;
    advance(100000); // clear show/resize/task graces from module init? show() not called; lastShowAt=0
    show('hotkey');
    win.focused = false;
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(true); // show-grace
    advance(VIS_GRACE_MS.afterShow);
    onBlur(); // unfocused show (focus never landed): one pass, then normal rules
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(true);
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(false);
  });
  it('markResizing and markTaskFinished arm their graces; markDialogClosed too', () => {
    const { win, advance } = setup({ cursor: { x: 0, y: 0 } });
    advance(100000);
    win.focused = false;
    markResizing();
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(true);
    advance(VIS_GRACE_MS.afterResize + 1000);
    markTaskFinished();
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(true);
    advance(VIS_GRACE_MS.afterTask + 1000);
    markDialogClosed();
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(true);
    advance(VIS_GRACE_MS.afterDialog + 1000);
    onBlur();
    advance(VIS_GRACE_MS.blurRecheck + 10);
    expect(win.visible).toBe(false);
  });
});

describe('visibility confinement (lint rule as a test)', () => {
  it('no direct win.show/hide/focus outside the module (notifications use n.show)', () => {
    const roots = ['src/main'];
    const bad: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (p.endsWith('window-visibility.ts')) continue;
        const s = fs.readFileSync(p, 'utf8');
        for (const m of s.matchAll(/\b(w|win|popup|n)\.(show|hide|focus)\(/g)) {
          if (m[1] === 'n' && m[2] === 'show') continue; // Notification toast, not the window
          bad.push(`${path.relative(root, p)}: ${m[0]}`);
        }
      }
    };
    for (const r of roots) walk(path.join(root, r));
    expect(bad).toEqual([]);
  });
  it('task notify is silent and routes clicks through the module', () => {
    const src = fs.readFileSync(path.join(root, 'src/main/tasks/taskHost.ts'), 'utf8');
    expect(src).toContain('silent: true');
    expect(src).toContain("'notification-click'");
    expect(src).toContain("send(IpcChannels.ui, { open: 'tasks' })");
  });
});
