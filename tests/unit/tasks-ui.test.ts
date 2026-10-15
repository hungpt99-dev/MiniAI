import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IpcChannels } from '../../src/shared/ipc-channels';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const html = () => read('src/renderer/index.html');
const css = read('src/renderer/styles.css');

describe('tasks view: mounted once, single active view, footer in shell', () => {
  it('tasks aside lives inside .view with data-i18n chrome', () => {
    const h = html();
    expect(h).toContain('aside id="tasks"');
    expect(h).toContain('id="task-list"');
    expect(h).toContain('id="task-summary"');
    expect(h).toContain('id="task-empty"');
    expect(h).toContain('id="task-resume-bar"');
    expect(h).toContain('data-i18n="tasks.title"');
    expect(h).toContain('data-i18n="tasks.empty"');
    // One .view only; tasks is a section inside it.
    expect(h.split('class="view').length - 1).toBe(1);
    expect(h.indexOf('aside id="tasks"')).toBeGreaterThan(h.indexOf('id="view"'));
  });
  it('single-view rule covers tasks (mount, back, esc, assert list)', () => {
    const src = appJs();
    expect(src).toContain("$('tasks').classList.toggle('hidden', name !== 'tasks')");
    expect(src).toContain("panelOn('btn-tasks', name === 'tasks')");
    expect(src).toContain("const memOpen = view === 'memory';");
    expect(src).toContain("const taskOpen = view === 'tasks';");
    expect(src).toContain("'palette', 'suggest', 'run', 'settings', 'history', 'extensions', 'memory', 'tasks', 'onboard'");
  });
  it('footer: tasks icon button with badge + warn dot, queue hint, footer stays put', () => {
    const h = html();
    expect(h).toContain('id="btn-tasks"');
    expect(h).toContain('id="task-badge"');
    expect(h).toContain('id="task-warn"');
    expect(h).toContain('id="hint-queue"');
    expect(h).toContain('data-i18n="footer.queue"');
    // icon button between History and Settings: no text label in the footer
    expect(h).not.toContain('task-label');
    expect(h.indexOf('id="btn-tasks"')).toBeGreaterThan(h.indexOf('id="btn-history"'));
    expect(h.indexOf('id="btn-tasks"')).toBeLessThan(h.indexOf('id="btn-settings"'));
    const src = appJs();
    expect(src).toContain('function paintTasksButton');
    expect(src).toContain("$('task-badge')");
    expect(src).toContain('tasks.waitingApproval');
    // Footer remains a single shell node.
    expect(h.split('<footer').length - 1).toBe(1);
  });
  it('rows: 56px+, status icons, 14px title, 12px muted second line, elapsed, menu', () => {
    expect(css).toContain('.task-row { position: relative; display: flex; gap: 10px;');
    expect(css).toContain('min-height: 56px;');
    expect(css).toContain('.task-row .task-title { font-size: 14px;');
    expect(css).toContain('.task-row .task-meta { font-size: 12px; color: var(--muted);');
    expect(css).toContain('.task-row .task-elapsed { font-size: 12px; color: var(--muted);');
    const src = appJs();
    expect(src).toContain('function taskRow(');
    expect(src).toContain('function taskStateText(');
    expect(src).toContain('function taskElapsed(');
    expect(src).toContain('new Intl.RelativeTimeFormat(L.tag');
    expect(src).toContain("t('tasks.open')");
    expect(src).toContain("t('tasks.stop')");
    expect(src).toContain("t('tasks.retry')");
    expect(src).toContain("t('tasks.undo')");
    expect(src).toContain("t('tasks.remove')");
  });
  it('subtasks nest 16px with connector + agent tag; user rows stay flat', () => {
    expect(css).toContain('.task-row.task-sub { margin-inline-start: 16px; }');
    expect(css).toContain('.task-row.task-sub .task-conn');
    expect(css).toContain('.task-agent-tag');
    const src = appJs();
    expect(src).toContain('taskRow(sub, true)');
    expect(src).toContain("t('tasks.agentTag')");
    expect(src).toContain("t('tasks.createdByNexio')");
    expect(src).toContain("t('tasks.startedByYou')");
  });
  it('sections in order: approval, running/queued, done (last 10 + show more)', () => {
    const src = appJs();
    expect(src).toContain("t('tasks.needsApproval')");
    expect(src).toContain("t('tasks.done')");
    expect(src).toContain("t('tasks.showMore')");
    expect(src).toContain('taskShowDone');
  });
  it('reorder: drag handle + Alt+Up/Alt+Down, announcements in the live region', () => {
    const src = appJs();
    expect(src).toContain('task-drag');
    expect(src).toContain('text/task-id');
    expect(src).toContain("e.key === 'ArrowUp'");
    expect(src).toContain("view === 'tasks'");
    expect(src).toContain("taskOp('move'");
    expect(src).toContain('attach-live');
  });
  it('detail inline: prompt, outcome, chips, collapsed steps, pending cards, stop', () => {
    const src = appJs();
    expect(src).toContain('function taskDetail(');
    expect(src).toContain('task-chips');
    expect(src).toContain('task-appr-head');
    expect(src).toContain("t('tasks.reviewAll')");
    expect(src).toContain('buildApprovalCard(p.runId');
    expect(src).toContain('task-steps hidden');
    expect(src).toContain("t('tasks.undoFamily')");
  });
  it('submit: Ctrl+Enter queues, while-busy choice, ghost buttons, slashes', () => {
    const src = appJs();
    expect(src).toContain('e.ctrlKey || e.metaKey');
    expect(src).toContain('void send({ queued: true })');
    expect(src).toContain('function showTaskChoice(');
    expect(src).toContain("t('tasks.runSeparately')");
    expect(src).toContain("t('tasks.addToQueue')");
    expect(src).toContain("t('tasks.replaceCurrent')");
    expect(src).toContain("t('tasks.dontAsk')");
    expect(src).toContain('taskSubmitDefault');
    expect(src).toContain("trigger === '/spawn'");
    expect(src).toContain("trigger === '/queue'");
    expect(src).toContain('runCancelCommand');
    expect(src).toContain('runClearQueueCommand');
    expect(src).toContain('btn-task-spawn');
    expect(src).toContain('btn-task-queue');
  });
  it('settings: Agent > Tasks section with shared switch rows', () => {
    const h = html();
    for (const id of ['set-task-parallel', 'set-task-queued', 'set-task-subtasks', 'set-task-asksub',
      'set-task-confirm', 'set-task-resume', 'set-task-notify', 'set-task-prune']) {
      expect(h).toContain(`id="${id}"`);
    }
    expect(h).toContain('data-i18n="settings.tasks"');
    const src = appJs();
    expect(src).toContain('function paintTaskSettings(');
    expect(src).toContain('function readTaskSettings(');
  });
  it('bridge: tasks invoke + tasks-changed push, no literals', () => {
    const preload = read('src/main/preload.ts');
    expect(preload).toContain('tasks: (a: TaskAction)');
    expect(preload).toContain('onTasksChanged');
    const map = read('src/shared/ipc-channels.ts');
    expect(map).toContain('tasks: ' + "'" + IpcChannels.tasks + "'");
    expect(map).toContain('tasksChanged: ' + "'" + IpcChannels.tasksChanged + "'");
  });
  it('empty state + resume prompt strings exist in both locales', () => {
    for (const f of ['src/main/i18n/locales/en.json', 'src/main/i18n/locales/vi.json']) {
      const dict = JSON.parse(read(f));
      for (const k of ['tasks.title', 'tasks.empty', 'tasks.resumePrompt', 'tasks.queuedNotice',
        'tasks.spawnedNotice', 'tasks.parkedNotice', 'tasks.runSeparately', 'tasks.addToQueue',
        'tasks.replaceCurrent', 'tasks.dontAsk', 'tasks.reviewAll', 'tasks.undoFamily',
        'slash.spawn', 'slash.queue', 'slash.tasks', 'slash.cancel', 'slash.clearQueue',
        'settings.tasks', 'settings.taskParallel', 'settings.taskResume']) {
        expect(dict[k], `${f}:${k}`).toBeTruthy();
      }
    }
  });
});
