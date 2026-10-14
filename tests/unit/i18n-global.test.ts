import { describe, it, expect } from 'vitest';
import { FALLBACK_LOCALE, pluralKey, pseudoLocalize, resolveLocale, translate } from '../../src/shared/i18n';
import { graphemeLength, graphemes, lowerSmart, nfc, takeGraphemes, words } from '../../src/shared/text';
import { formatAttachCount, formatSize, safeName } from '../../src/shared/attachments';
import { isRtl, setLocale, t, __resetI18nForTests } from '../../src/main/i18n/index';
import { classifyMemoryIntent, loadIntentPack, matchFastPath } from '../../src/main/memory/classify';
import { heuristicIntent } from '../../src/main/agent/intent';

describe('i18n core: locale-aware plurals, fallback, pseudo', () => {
  it('uses the requested locale for plural forms, not English', () => {
    expect(FALLBACK_LOCALE).toBe('en');
    // Russian has few/many; Arabic has six forms — Intl drives them.
    expect(pluralKey('ru', 1)).toBe('one');
    expect(pluralKey('ru', 2)).toBe('few');
    expect(pluralKey('ru', 5)).toBe('many');
    expect(pluralKey('ar', 0)).toBe('zero');
    expect(pluralKey('ar', 2)).toBe('two');
    const dict = { n: { one: '{count} file', few: '{count} files (few)', many: '{count} files (many)', other: '{count} files' } };
    expect(translate({}, dict, 'n', { count: 2 }, 'ru')).toBe('2 files (few)');
    expect(translate({}, dict, 'n', { count: 5 }, 'ru')).toBe('5 files (many)');
    // Missing key falls back to the key itself; missing locale falls back to English.
    expect(translate({}, {}, 'nope')).toBe('nope');
    expect(resolveLocale('pt-BR', ['en', 'pt'])).toBe('pt');
    expect(resolveLocale('xx', ['en', 'vi'])).toBe('en');
  });
  it('pseudo-locale expands text to catch overflow', () => {
    const out = pseudoLocalize('Memory');
    expect(out.length).toBeGreaterThan('Memory'.length);
    expect(out).toMatch(/^⟦.*⟧$/);
  });
  it('knows RTL UI locales', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('he')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('vi')).toBe(false);
  });
  it('main t() resolves against shipped locales', () => {
    __resetI18nForTests();
    setLocale('vi');
    expect(t('memory.saveBtn')).toBe('Lưu');
    expect(t('memory.suggestCount', { count: 2 })).toContain('2');
    setLocale('en');
    expect(t('memory.saveBtn')).toBe('Save');
    __resetI18nForTests();
  });
});

describe('text handling: NFC, graphemes, segmenter, Turkish', () => {
  it('normalizes to NFC for comparison', () => {
    expect(nfc('café')).toBe(nfc('café'));
  });
  it('never splits emoji or combining marks', () => {
    expect(graphemes('😀a')).toEqual(['😀', 'a']);
    expect(takeGraphemes('😀😀😀', 2)).toBe('😀😀');
    expect(graphemeLength('é')).toBe(1); // e + combining acute
    expect(graphemeLength('😀'.repeat(3))).toBe(3);
  });
  it('segments CJK words via Intl.Segmenter', () => {
    expect(words('我喜欢喝茶', 'zh').length).toBeGreaterThan(1);
    expect(words('hello world')).toEqual(['hello', 'world']);
  });
  it('folds Turkish dotted I with the locale', () => {
    expect(lowerSmart('Istanbul', 'tr')).toBe('ıstanbul');
    expect(lowerSmart('Istanbul', 'en')).toBe('istanbul');
  });
});

describe('attachments: Unicode names, Intl sizes and counts', () => {
  it('keeps non-Latin scripts intact (spaces still sanitize)', () => {
    // Letters in any script survive; separators become _; traversal drops.
    expect(safeName('山田太郎.docx')).toBe('山田太郎.docx');
    expect(safeName('محمد.txt')).toBe('محمد.txt');
    expect(safeName('Müller.png')).toBe('Müller.png');
    expect(safeName('фото.jpg')).toBe('фото.jpg');
    expect(safeName('Phạm Thanh Hùng.pdf')).toBe('Phạm_Thanh_Hùng.pdf');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('')).toBe('file');
  });
  it('formats sizes and counts with Intl', () => {
    expect(formatSize(512)).toContain('B');
    expect(formatSize(2048)).toContain('KB');
    expect(formatSize(3 * 1024 * 1024)).toContain('MB');
    expect(formatSize(1536, 'de')).toContain('1,5');
    expect(formatSize(1536, 'en')).toContain('1.5');
    expect(formatAttachCount(1)).toContain('1');
    expect(formatAttachCount(3)).toContain('3');
  });
});

describe('memory intent: data packs + model call, no per-language regex', () => {
  it('fast-path packs match their own phrases and never fire on unrelated text', () => {
    expect(matchFastPath('please remember that I prefer PDFs', ['en'])?.intent).toBe('remember');
    expect(matchFastPath('hãy nhớ rằng tôi thích cà phê', ['vi'])?.intent).toBe('remember');
    expect(matchFastPath('recuerda que hablo español', ['es'])?.intent).toBe('remember');
    expect(matchFastPath('请记住我喜欢喝茶', ['zh'])?.intent).toBe('remember');
    expect(matchFastPath("I can't remember where I put it", ['en'])).toBeNull();
    expect(matchFastPath('do you remember my name?', ['en'])).toBeNull();
    expect(matchFastPath('私の名前は田中です', ['ja'])).toBeNull(); // statement -> model call
    expect(matchFastPath('/remember my name is X', ['en'])).toBeNull();
    expect(matchFastPath('お名前は何ですか？', ['ja'])).toBeNull(); // fullwidth ? never stores
    expect(matchFastPath('ما هي عاصمة فرنسا؟', ['ar'])).toBeNull(); // Arabic ? never stores
  });
  it('a missing locale falls back to the model call without breaking', () => {
    expect(loadIntentPack('xx-none')).toBeNull();
    expect(matchFastPath('remember that X', ['xx-none'])).not.toBeNull(); // 'en' fallback
    expect(matchFastPath('something entirely else', ['xx-none'])).toBeNull();
  });
  it('offline means no guessing: null askModel -> null verdict', async () => {
    expect(await classifyMemoryIntent('my name is Ana', [], null)).toBeNull();
    expect(await classifyMemoryIntent('tôi tên là Hưng', [], null)).toBeNull();
  });
  it('injection-shaped model text in any language is still secrets-blocked', async () => {
    const ask = (reply: string) => async (_p: string) => reply;
    const v = await classifyMemoryIntent('x', [], ask('{"intent":"remember","text":"api key sk-abc123XYZ456789DEF012345","kind":"fact","language":"en"}'));
    expect(v?.intent).toBe('none');
    expect(v?.blocked).toBeTruthy();
    // Classifier output is schema-validated and grapheme-capped.
    const emoji = await classifyMemoryIntent('x', [], ask(`{"intent":"remember","text":"${'😀'.repeat(400)}","kind":"fact","language":"und"}`));
    expect(graphemeLength(emoji?.text || '')).toBeLessThanOrEqual(300);
  });
});

describe('router: structural signals only, model decides meaning', () => {
  it('path-like text acts in any language; questions answer; verbs alone abstain', () => {
    expect(heuristicIntent('mở file report.pdf giúp tôi')).toBe('act');
    expect(heuristicIntent('ما هي عاصمة فرنسا؟')).toBe('answer');
    expect(heuristicIntent('法国的首都是哪里？')).toBe('answer');
    expect(heuristicIntent('find files I changed today')).toBeNull();
    expect(heuristicIntent('write a haiku about rain')).toBeNull();
  });
});
