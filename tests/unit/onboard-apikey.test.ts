import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const appJs = () => read('src/renderer/app.js');
const css = () => read('src/renderer/styles.css');

describe('onboarding: one screen (provider + key)', () => {
  it('has no multi-step flow: no step state, progress bar, or dead steps', () => {
    const src = appJs();
    for (const dead of ['OB_STEPS', 'obStep', 'obShell', 'ob-progress', 'ob-seg',
      'onboard.stepOf', 'id="ob-skip"', 'ob-done', 'data-mem="', 'data-try="',
      'ob-roots', 'Choose allowed folders', 'Try Nexio', 'Let Nexio remember',
      'Yes, ask me each time', 'hotkeyCapsHtml']) {
      expect(src, dead).not.toContain(dead);
    }
    for (const dead of ['.ob-progress', '.ob-seg', '.ob-key-row']) {
      expect(css(), dead).not.toContain(dead);
    }
  });
  it('Skip completes onboarding (flag + close), same path Continue reuses', () => {
    const src = appJs();
    const at = src.indexOf('async function skipOnboard()');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, at + 400);
    expect(fn).toContain('setSettings({ onboarded: true })');
    expect(fn).toContain('showView(defaultView())');
    expect(src).toContain('skipInline.onclick = () => void skipOnboard()');
    expect(src).toContain('await skipOnboard();');
  });
  it('Continue is disabled until the key is non-empty', () => {
    const src = appJs();
    expect(src).toContain('id="ob-next" type="button" class="btn-primary ob-continue" disabled');
    expect(src).toContain('next.disabled = empty');
    expect(src).toContain("if ($('ob-next').disabled) return;");
    expect(src).toContain('await window.nexio.setApiKey(prov, k)');
    expect(css()).toContain('.ob-actions .btn-primary:disabled');
    expect(css()).toContain('min-width: 120px');
  });
  it('shows OpenAI (display text only, id stays openai) with per-provider placeholders', () => {
    const src = appJs();
    expect(src).toContain("label: 'OpenAI'");
    expect(src).toContain("ph: 'sk-…'");
    expect(src).toContain("ph: 'sk-ant-…'");
    expect(src).toContain("ph: 'AIza…'");
    expect(src).toContain('https://platform.openai.com/api-keys');
    expect(src).toContain('https://console.anthropic.com/settings/keys');
    expect(src).toContain('https://aistudio.google.com/apikey');
    expect(src).not.toContain('>Openai<');
  });
  it('key field: one 44px control, password by default, mono, labelled, described, eye inside', () => {
    const src = appJs();
    expect(src).toContain('id="ob-key" type="password"');
    expect(src).toContain('for="ob-key"');
    expect(src).toContain('aria-describedby="ob-key-help"');
    expect(src).toContain('aria-pressed="false"');
    expect(src).toContain('onboard.showKey');
    expect(src).toContain('onboard.hideKey');
    expect(src).toContain("key.type = show ? 'text' : 'password'");
    expect(src).toContain('class="ob-field"');
    expect(src).toContain('class="ob-div"');
    expect(src).toContain('id="ob-eye"');
    expect(src).toContain('id="ob-test"');
    expect(css()).toContain('.ob-field');
    expect(css()).toContain('height: 44px');
    expect(css()).toContain('border-radius: 8px');
  });
  it('helper row: encrypted note plus per-provider key link (hidden for Custom)', () => {
    const src = appJs();
    expect(src).toContain('onboard.encryptedNote');
    expect(src).toContain('onboard.getKey');
    expect(src).toContain('target="_blank" rel="noopener"');
    expect(src).toContain('link.classList');
    expect(css()).toContain('.ob-key-link:hover');
  });
  it('Test states render in the helper row: idle, loading spinner, success check, error border+message', () => {
    const src = appJs();
    expect(src).toContain('function setObTestState(');
    expect(src).toContain('ob-spin');
    expect(src).toContain('onboard.keyValid');
    expect(src).toContain('onboard.keyInvalid');
    expect(src).toContain("test.disabled = empty");
    expect(src).toContain("ob-field')?.classList.toggle('error'");
    expect(css()).toContain('.ob-field.error');
    expect(css()).toContain('.ob-spin');
  });
  it('footer actions share one right-aligned row: plain Skip, solid Continue with arrow', () => {
    const src = appJs();
    expect(src).toContain('row ob-actions');
    expect(src).toContain('ob-skip-inline');
    expect(src).toContain('ob-continue');
    expect(css()).toContain('.ob-actions');
    expect(css()).toContain('justify-content: flex-end');
    expect(css()).toContain('.ob-skip');
  });
  it('keyboard: Enter submits when enabled, IME never submits, tab order is input-eye-Test-Skip-Continue', () => {
    const src = appJs();
    expect(src).toContain("keyInput.addEventListener('keydown'");
    expect(src).toContain('e.keyCode === 229');
    expect(src).toContain('if (next && !next.disabled) next.click()');
    const tpl = src.slice(src.indexOf('class="ob-field"'), src.indexOf('row ob-actions'));
    for (const id of ['ob-key"', 'ob-eye', 'ob-test']) expect(tpl).toContain(id);
    expect(src.indexOf('ob-skip-inline')).toBeGreaterThan(src.indexOf('row ob-actions'));
  });
  it('a11y: labelled input, live region, icon-button names, focus rings', () => {
    const src = appJs();
    expect(src).toContain('role="status" aria-live="polite"');
    expect(src).toContain('aria-label="${esc(t(');
    expect(css()).toMatch(/input:focus-visible/);
    expect(css()).toContain('.ob-field:focus-within');
  });
  it('locale loads before first paint (raw-key root cause)', () => {
    const src = appJs();
    const anchor = "mode = s.mode === 'agent' ? 'agent' : 'chat';";
    const boot = src.slice(src.indexOf(anchor), src.indexOf(anchor) + 400);
    expect(boot).toContain('await loadLocale()');
    expect(boot).toContain('applyLocale()');
    expect(boot.indexOf('loadLocale()')).toBeLessThan(boot.indexOf('applyLocale()'));
  });
  it('new onboard keys exist in every shipped locale; no key value leaks', () => {
    for (const f of ['src/main/i18n/locales/en.json', 'src/main/i18n/locales/vi.json']) {
      const dict = JSON.parse(read(f));
      for (const k of ['onboard.title', 'onboard.subtitle', 'onboard.showKey', 'onboard.hideKey',
        'onboard.encryptedNote', 'onboard.getKey', 'onboard.keyValid', 'onboard.keyInvalid',
        'onboard.skip', 'onboard.testing']) {
        expect(typeof dict[k], `${f}:${k}`).toBe('string');
      }
      for (const k of ['onboard.stepOf', 'onboard.memoryTitle', 'onboard.folders', 'onboard.try',
        'onboard.provider', 'onboard.providerLabel']) {
        expect(k in dict, `${f}:${k}`).toBe(false);
      }
      // footer + composer keys the raw-key fix depends on
      for (const k of ['tasks.title', 'composer.placeholder.ask', 'composer.placeholder.do']) {
        expect(typeof dict[k], `${f}:${k}`).toBe('string');
      }
    }
    const src = appJs();
    // why: the key value only ever sits in the input element, never in markup or messages.
    expect(src).not.toMatch(/textContent = .*ob-key.*value/);
    expect(src).not.toMatch(/innerHTML = .*ob-key.*value/);
  });
  it('footer tasks icon button keeps its badge spans and repaints after locale apply', () => {
    const src = appJs();
    const html = read('src/renderer/index.html');
    const fn = src.slice(src.indexOf('function paintTasksButton()'), src.indexOf('function openTasksView()'));
    expect(fn).not.toContain("innerHTML = ''");
    // icon button: status goes to aria-label/title, never button text
    expect(fn).not.toContain('task-label');
    expect(fn).toContain("btn.setAttribute('aria-label'");
    expect(src).toContain('paintTasksButton(); } catch');
    expect(html).not.toContain('task-label');
    expect(html).toContain('id="task-badge"');
  });
});
