// Single-view state for the Nexio popup (renderer-safe, pure logic only).
// The popup mounts exactly one view node inside .view; all switches go
// through openView/goBack so Esc/Back return to returnTo. See app.js showView.
export type ViewName = 'idle' | 'palette' | 'run' | 'settings' | 'extensions' | 'history' | 'onboard';

export interface ViewState {
  view: ViewName;
  returnTo: ViewName;
}

export function defaultView(hasRun: boolean): ViewName {
  return hasRun ? 'run' : 'idle';
}

// why: panels/palette remember their idle|run origin; run/idle never clobber it
export function openView(state: ViewState, name: ViewName): ViewState {
  if (state.view === name) return state;
  if (name === 'idle' || name === 'run') return { view: name, returnTo: state.returnTo };
  if (state.view === 'idle' || state.view === 'run') return { view: name, returnTo: state.view };
  return { view: name, returnTo: state.returnTo };
}

// why: a cleared run has no content to return to, so fall back to idle
export function goBack(state: ViewState, hasRun: boolean): ViewState {
  const t = state.returnTo;
  if (t === 'run' && !hasRun) return { view: 'idle', returnTo: state.returnTo };
  return { view: t, returnTo: state.returnTo };
}

export const VIEW_SLASHES = ['/extensions', '/settings', '/history', '/log'] as const;
export type ViewSlash = (typeof VIEW_SLASHES)[number];

export function isViewSlash(trigger: string): trigger is ViewSlash {
  return (VIEW_SLASHES as readonly string[]).includes(trigger);
}

export interface ViewSlashDeps {
  clearInput(): void;
  hidePalette(): void;
  openExtensions(): void;
  openSettings(): void;
  openHistory(): void;
  openLog(): void;
}

// View-only slashes run before router/agent: clear + hide, never submit.
export function handleViewSlash(trigger: string, deps: ViewSlashDeps): boolean {
  if (!isViewSlash(trigger)) return false;
  deps.clearInput();
  deps.hidePalette();
  if (trigger === '/extensions') deps.openExtensions();
  else if (trigger === '/settings') deps.openSettings();
  else if (trigger === '/history') deps.openHistory();
  else deps.openLog();
  return true;
}

// Single footer chip while away from the run; null means hidden (no duplicate).
export function runChipLabel(
  running: boolean,
  hasRecent: boolean,
  viewingRun: boolean,
): 'Running / View' | 'Done / View' | null {
  if (viewingRun) return null;
  if (running) return 'Running / View';
  if (hasRecent) return 'Done / View';
  return null;
}

// Planning narration exists only while active with zero tool steps.
export function shouldShowPlanning(active: boolean, toolCount: number): boolean {
  return active && toolCount === 0;
}

export interface EmptyState {
  msgCount: number;
  toolCount: number;
  active: boolean;
  attachCount: number;
  inputEmpty: boolean;
}

// why: starter suggestions only on a fresh idle composer; the active check
// reuses shouldShowPlanning so a planning-only run never reads as empty
export function isEmpty(s: EmptyState): boolean {
  return (
    s.inputEmpty &&
    s.msgCount === 0 &&
    s.toolCount === 0 &&
    s.attachCount === 0 &&
    !s.active &&
    !shouldShowPlanning(s.active, s.toolCount)
  );
}
