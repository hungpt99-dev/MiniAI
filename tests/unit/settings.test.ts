import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateSettings, DEFAULT_SETTINGS } from '../../src/main/store/settings';
import { openTestDb } from '../../src/main/db/db';
import { updateSettings, getSettings } from '../../src/main/store/settings';

describe('settings validation', () => {
  it('accepts defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it('rejects bad provider / empty model / bad url / bad hotkey', () => {
    expect(validateSettings({ provider: 'x' as never })).toHaveLength(1);
    expect(validateSettings({ model: '' })).toHaveLength(1);
    expect(validateSettings({ baseUrl: 'notaurl' })).toHaveLength(1);
    expect(validateSettings({ hotkey: '!!!' })).toHaveLength(1);
  });
  it('persists round-trip in sqlite', () => {
    const db = openTestDb();
    updateSettings(db, { model: 'gpt-x', theme: 'dark' });
    const s = getSettings(db);
    expect(s.model).toBe('gpt-x');
    expect(s.theme).toBe('dark');
    expect(() => updateSettings(db, { model: '' })).toThrow();
    db.close();
  });
  it('renderer save clears stale custom baseUrl when leaving compatible', () => {
    // why: app.js builds the patch inline (no DOM import); assert the source
    // clears baseUrl so a stale localhost URL never follows to other providers
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'app.js'), 'utf8');
    expect(src).toMatch(/settingsProvider !== 'compatible'\) patch\.baseUrl = ''/);
  });
});
