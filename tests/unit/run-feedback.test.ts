import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IpcChannels } from '../../src/shared/ipc-channels';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');
const css = () => read('src/renderer/styles.css');
const foot = () => {
  const h = html();
  return h.slice(h.indexOf('<footer'), h.indexOf('</footer>'));
};

describe('run feedback: never silent, never stuck', () => {
  it('beginRun shows You + Planning immediately (Do submit feedback)', () => {
    const src = appJs();
    const begin = src.slice(src.indexOf('async function beginRun('), src.indexOf('async function startWorkflowRun('));
    expect(begin).toContain("addMsg('user', userText)");
    expect(begin).toContain('plan-row');
    expect(begin).toContain('Planning…');
    expect(begin).toContain("iconFor('run')");
    expect(begin).toContain('agentEventSeen()');
  });
  it('silence watchdog: 10s still-working, 60s error with Retry + Copy details', () => {
    const src = appJs();
    expect(src).toContain('function checkAgentSilence()');
    expect(src).toContain('elapsed > 10000');
    expect(src).toContain('elapsed > 60000');
    expect(src).toContain('still-row');
    expect(src).toContain('Still working…');
    expect(src).toContain('watchdog-row');
    expect(src).toContain('No response for 60 s');
    expect(src).toContain("retry.textContent = 'Retry'");
    expect(src).toContain("stopAgentRun(); if (lastUserText) void startAgentRun(lastUserText, {})");
    expect(src).toContain("copy.textContent = 'Copy details'");
    expect(src).toContain('runId=${runId}');
    // every rendered event resets the clock; terminal state clears the rows
    expect(src).toContain('function agentEventSeen()');
    expect(src.indexOf('agentEventSeen();')).toBeLessThan(src.indexOf("if (ev.type === 'step')"));
    const end = src.slice(src.indexOf('function endAgentRun()'), src.indexOf('function endAgentRun()') + 500);
    expect(end).toContain('.still-row');
    const c = css();
    expect(c).toContain('.astep.still-row .tx');
    expect(c).toContain('.astep .btn-retry');
    expect(c).toContain('.astep .btn-stop-inline');
  });
  it('replay covers a view waiting for the same run (mirrors shared/task-routing)', () => {
    const src = appJs();
    expect(src).toContain('shouldReplayBuffered');
    const replay = src.slice(src.indexOf('// Replay buffered events'), src.indexOf('paintTasksButton();', src.indexOf('// Replay buffered events')));
    expect(replay).toContain('if (!agentState) {');
    expect(replay).toContain('} else if (!agentState.runId || agentState.runId === runId) {');
  });
});

describe('failed runs end cleanly: friendly error, no spinner, footer Retry', () => {
  it('error rows carry Retry + Details + Open Settings, never a raw string with a spinner', () => {
    const src = appJs();
    expect(src).toContain('function addErrorRow(info)');
    expect(src).toContain("retry.textContent = 'Retry'");
    expect(src).toContain("det.textContent = 'Details'");
    expect(src).toContain("copy.textContent = 'Copy details'");
    expect(src).toContain("open.textContent = 'Open Settings'");
    expect(src).toContain("togglePanel('settings')");
    // terminal error resolves the Planning row and stops spinners
    const branch = src.slice(src.indexOf("} else if (ev.type === 'error')"), src.indexOf("} else if (ev.type === 'stopped')"));
    expect(branch).toContain('.plan-row');
    expect(branch).toContain('finalizeSpinners()');
    expect(branch).toContain('addErrorRow(');
    expect(branch).toContain('endAgentRun()');
    // invoke rejections (no terminal event coming) clean up the same way
    const startCatch = src.slice(src.indexOf('const r = await startP;'), src.indexOf('} catch (e) {', src.indexOf('const r = await startP;')) + 900);
    expect(startCatch).toContain('.plan-row');
    expect(startCatch).toContain('addErrorRow(');
    expect(startCatch).toContain('e.technical');
    expect(startCatch).toContain('failedRun = { text: lastUserText }');
  });
  it('footer failed state: Retry + Esc-clear, armed for Do runs only', () => {
    const src = appJs();
    expect(src).toContain('var failedRun = null;');
    expect(src).toContain("/^agent-/.test(runId || '')");
    expect(src).toContain('function retryFailedRun()');
    expect(src).toContain('function clearFailedRun()');
    const foot = (() => { const h = html(); return h.slice(h.indexOf('<footer'), h.indexOf('</footer>')); })();
    expect(foot).toContain('id="btn-retry"');
    const fn = src.slice(src.indexOf('function syncAgentFooter()'), src.indexOf('function paintChip()'));
    expect(fn).toContain("const failed = !running && !!failedRun;");
    expect(fn).toContain('btn-retry');
    // Esc clears a failed run with an empty composer instead of closing
    expect(src).toContain('if (typeof failedRun !== ');
    expect(src).toContain('clearFailedRun();');
    // a new submit supersedes the failed state
    expect(src).toContain('failedRun = null; // a new run supersedes the failed state');
    expect(src).toContain('failedRun = null; // a new submit supersedes the failed state');
  });
  it('settings surfaces unreadable keys with re-entry guidance', () => {
    const h = html();
    expect(h).toContain('id="key-note"');
    const src = appJs();
    expect(src).toContain('function paintSecretsNotice()');
    expect(src).toContain("Saved key couldn't be unlocked. Paste it again to continue.");
    expect(src).toContain('window.nexio.secretsStatus');
    expect(src).toContain('void paintSecretsNotice();');
    const preload = read('src/main/preload.ts');
    expect(preload).toContain('secretsStatus');
    const map = read('src/shared/ipc-channels.ts');
    expect(map).toContain(`secretsStatus: '${IpcChannels.secretsStatus}'`);
    expect(map).toContain('reentry: string[]');
  });
  it('main maps failures friendly with redacted technical (envelope + events)', () => {
    const main = read('src/main/ipc.ts');
    expect(main).toContain('function emitAppError(');
    expect(main).toContain('requireApiKey(d, s.provider)');
    expect(main).toContain('emit({ type: \'error\', message: app.friendly, code: app.code');
    const boot = read('src/main/main.ts');
    expect(boot).toContain("markSecretsReady();");
    expect(boot).toContain('scanForReentry(db)');
    const types = read('src/main/agent/types.ts');
    expect(types).toContain("code?: string; technical?: string; action?: 'open-settings' | 'retry' | null");
    const loop = read('src/main/agent/loop.ts');
    expect(loop).toContain('toAppError(e)');
    const env = read('src/shared/ipc-channels.ts');
    expect(env).toContain('appCode?: string;');
    expect(env).toContain('technical?: string;');
  });
});
describe('footer states per task state (shell, single copy)', () => {
  it('running shows Stop ghost + one Esc cap, hides idle hints', () => {
    const src = appJs();
    const fn = src.slice(src.indexOf('function syncAgentFooter()'), src.indexOf('function paintChip()'));
    expect(fn).toContain("classList.toggle('hidden', !running)");
    expect(fn).toContain("['hint-tab', 'hint-enter', 'hint-queue']");
    expect(fn).toContain("classList.toggle('hidden', quiet)");
    expect(fn).toContain("hint-approval");
    expect(fn).toContain("document.querySelector('#agent-steps .appr')");
    // one Esc cap in markup; global hotkey only in tooltips
    expect(foot()).toContain('<span id="stop-hint" class="hidden"><span class="k">Esc</span></span>');
    expect(foot()).not.toContain('<span class="k">Ctrl</span> <span class="k">Alt</span> <span class="k">Esc</span>');
    expect(src).toContain('btnStop.title');
    expect(src).toContain('Stop (${stopLabel})');
    const c = css();
    expect(c).toContain('#hints #btn-stop { width: auto; height: 28px;');
    expect(c).toContain('1px solid var(--border)');
    expect(c).toContain('color: var(--danger)');
  });
  it('waiting approval shows allow-once/deny hints; composer Enter/Esc answer them', () => {
    expect(foot()).toContain('id="hint-approval"');
    expect(foot()).toContain('<span>allow once</span>');
    expect(foot()).toContain('<span>deny</span>');
    const src = appJs();
    expect(src).toContain("document.querySelector('#agent-steps .appr .btn-allow')");
    expect(src).toContain('allow.click()');
    expect(src).toContain("appr.querySelector('.btn-deny')");
    expect(src).toContain('deny.click()');
    // Esc stops a running task before it clears/closes
    expect(src).toContain('if (typeof agentRunning === ');
    expect(src).toContain('stopAgentRun();');
  });
  it('Tasks is an icon button between History and Settings; no text-only items', () => {
    const f = foot();
    expect(f).toContain('id="btn-tasks" class="fbtn"');
    expect(f).not.toContain('task-label');
    expect(f).not.toContain('>Tasks<');
    expect(f).not.toContain('>Log<');
    expect(f).not.toContain('hist-note');
    expect(f).toContain('id="task-badge"');
    expect(f).toContain('id="task-warn"');
    const order = ['btn-ext', 'btn-history', 'btn-tasks', 'btn-settings', 'btn-attach', 'btn-send'];
    const idx = order.map((id) => f.indexOf(`id="${id}"`));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // icon buttons carry 18px svg; view highlight retained
    const tasksBtn = f.slice(f.indexOf('id="btn-tasks"'), f.indexOf('id="btn-settings"'));
    expect(tasksBtn).toContain('<svg width="18" height="18"');
    expect(appJs()).toContain("panelOn('btn-tasks', name === 'tasks')");
  });
  it('exactly one footer in the panel shell', () => {
    const h = html();
    expect(h.split('<footer').length - 1).toBe(1);
    expect(h.indexOf('<footer')).toBeGreaterThan(h.indexOf('id="view"'));
  });
});
