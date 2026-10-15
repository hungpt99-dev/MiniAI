import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openTestDb } from '../../src/main/db/db';
import { createConversation, addMessage, getMessages } from '../../src/main/db/conversations';
import { render } from '../../src/main/db/templates';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const css = () => read('src/renderer/styles.css');
const html = () => read('src/renderer/index.html');

describe('dividers: lazy, one before a differently-moded message, never stored', () => {
  it('toggling mode renders nothing; sends derive the divider', () => {
    const src = appJs();
    const setMode = src.slice(src.indexOf('function setMode(m, persist)'), src.indexOf('// --- lazy mode dividers'));
    expect(setMode).not.toContain('mode-div');
    expect(setMode).not.toContain('appendChild');
    // every send path freezes the turn mode and asks for at most one divider
    for (const anchor of ['maybeModeDivider(turnMode);', "turnMode = storeModeOf(mode);", "turnMode = 'do';"]) {
      expect(src).toContain(anchor);
    }
    expect(src).toContain('function storeModeOf(m)');
    // rows carry the mode; dividers derive from it
    expect(src).toContain('div.dataset.mode');
    // insert-only-on-change + relabel-instead-of-double + collapse + no-trailing
    expect(src).toContain('prev === newMode');
    expect(src).toContain('dataset.modeDiv');
    expect(src).toContain('function normalizeDividers()');
  });
  it('message rows store mode/command/args; dividers are not items', () => {
    const db = openTestDb();
    const c = createConversation(db, 't-modes').id;
    addMessage(db, c, 'user', 'hello', { mode: 'ask' });
    addMessage(db, c, 'assistant', 'hi', { mode: 'ask' });
    addMessage(db, c, 'user', 'do things', { mode: 'do' });
    const msgs = getMessages(db, c);
    expect(msgs.map((m) => m.mode)).toEqual(['ask', 'ask', 'do']);
    // exactly one mode change between messages 2 and 3 → one divider at render
    const changes = msgs.slice(1).filter((m, i) => m.mode && msgs[i].mode && m.mode !== msgs[i].mode).length;
    expect(changes).toBe(1);
    // legacy rows without a mode never force a divider
    addMessage(db, c, 'user', 'old row');
    expect(getMessages(db, c).at(-1)?.mode ?? null).toBeNull();
    db.close();
  });
  it('slash send stores trigger and args as separate fields', () => {
    const db = openTestDb();
    const c = createConversation(db, 't-slash').id;
    addMessage(db, c, 'user', 'Translate the following text into English,\n\nText:\nhello', {
      mode: 'ask', command: 'translate', args: 'hello',
    });
    const m = getMessages(db, c)[0];
    expect(m.command).toBe('translate');
    expect(m.args).toBe('hello');
    expect(m.command + m.args).not.toBe('/translatehello');
    db.close();
  });
});

describe('slash display: chip + 8px gap + args, never concatenated', () => {
  it('chip style carries the gap; row keeps two nodes', () => {
    const c = css();
    expect(c).toContain('.slash-chip {');
    expect(c).toContain("font-family: 'JetBrains Mono', monospace; font-size: 12px;");
    expect(c).toContain('background: var(--surface);');
    expect(c).toContain('border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; color: var(--text-soft);');
    expect(c).toContain('margin-inline-end: 8px;');
    const src = appJs();
    // chip node + separate args text node (args win over rendered template text)
    expect(src).toContain("chip.className = 'slash-chip'");
    expect(src).toContain('opts.args != null ? opts.args');
    // stored template sends still go over send() as the rendered text
    expect(src).toContain('window.nexio.send(id, rendered, sendOpts)');
    expect(src).toContain('sendOpts.slash = { command:');
  });
  it('provider request is template text + user text separated by a newline', async () => {
    const { seedBuiltins, listTemplates } = await import('../../src/main/db/templates');
    const db = openTestDb();
    seedBuiltins(db);
    const tpl = listTemplates(db).find((t) => t.trigger === '/translate')!;
    for (const args of ['hello', 'vi: xin chào', '日本語を翻訳して', 'עברית RTL בדיקה']) {
      const rendered = render(tpl.body, { text: args });
      expect(rendered).toContain(args);
      const i = rendered.indexOf(args);
      // template text and args are newline-separated, never glued to the trigger
      expect(rendered.slice(0, i)).toMatch(/\n\nText:\n$/);
      expect(rendered).not.toContain('/translate' + args);
    }
    db.close();
  });
});

describe('steps: only real tool calls earn the toggle', () => {
  it('Ask sends clear stale rows; memory lookups never make rows', () => {
    const src = appJs();
    expect(src).toContain('function clearSteps()');
    // template branch, plain branch, workflow branch, Do beginRun
    expect(src.match(/clearSteps\(\);/g)!.length).toBeGreaterThanOrEqual(4);
    expect(src).toContain("if (ev.tool === 'memory_search') { memSuppressed.add(ev.id); return; }");
    // the toggle counts .tool-name only — plan rows carry none
    const sync = src.slice(src.indexOf('function syncSteps()'), src.indexOf('function renderRunChips(runId)'));
    expect(sync).toContain("querySelectorAll('.tool-name').length");
    expect(sync).toContain('if (!tools) {');
  });
  it('plan narration rows carry no tool name', () => {
    const src = appJs();
    const planRow = src.slice(src.indexOf("row.className = 'astep plan-row'") - 200, src.indexOf("row.className = 'astep plan-row'") + 120);
    expect(planRow).not.toContain('tool-name');
  });
});

describe('scroll area and typography', () => {
  it('first row clears the header line; .view is the only scroller; jump floats', () => {
    const c = css();
    expect(c).toContain('padding: calc(var(--popup-pad-y) * var(--space-scale)) calc(22px * var(--space-scale)) calc(var(--popup-pad-y) * var(--space-scale));');
    expect(c).toContain('.view { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; border-top: 1px solid var(--divider);');
    expect(c).toContain('#jump-latest { position: absolute;');
  });
  it('answer 400/15px/1.5; emphasis uses bundled 600 (no faux bold)', () => {
    const c = css();
    expect(c).toContain('.msg.assistant { color: var(--text-body); font-size: 15px; line-height: 1.5; font-weight: 400;');
    expect(c).toContain('.msg.assistant b, .msg.assistant strong { font-weight: 600; }');
    // all three Geist weights are declared and shipped
    for (const w of ['400', '500', '600']) {
      expect(c).toContain(`font-weight: ${w}; font-display: swap; src: url("fonts/geist-${w}.woff2")`);
      expect(fs.existsSync(path.join(root, `src/renderer/fonts/geist-${w}.woff2`))).toBe(true);
    }
    // whole-answer **bold** unwraps at display; inline emphasis stays
    const src = appJs();
    expect(src).toContain('models wrap whole short answers');
  });
});

describe('footer hints per state (Ask and Do)', () => {
  it('one state machine: empty+focused = Tab/Enter/Esc, typing = Enter/Esc, runs hide them', () => {
    const src = appJs();
    const fn = src.slice(src.indexOf('function syncAgentFooter()'), src.indexOf('function paintChip()'));
    expect(fn).toContain("['hint-tab', 'hint-enter', 'hint-queue']");
    expect(fn).toContain("else if (id === 'hint-tab') el.classList.toggle('hidden', quiet || !empty || !focused);");
    expect(fn).toContain("$('hint-esc')) $('hint-esc').classList.toggle('hidden', running);");
    expect(fn).toContain("if (id === 'hint-queue' && askMode) el.classList.add('hidden')");
    // Tab tracks focus moves, not just input/mode changes
    expect(src).toContain("inputEl.addEventListener('focus'");
    expect(src).toContain("inputEl.addEventListener('blur'");
    // hints hide from the right under crowding, never wrap
    expect(src).toContain("['hint-queue', 'hint-esc', 'hint-enter', 'hint-tab']");
    expect(css()).toContain('#hints .crowd-hide { display: none !important; }');
    expect(html()).toContain('id="hint-readonly"');
  });
});
