import { describe, it, expect } from 'vitest';
import { openTestDb } from '../../src/main/db/db';
import { setSecret, getSecret, deleteSecret, redact } from '../../src/main/store/secrets';

describe('secrets redaction', () => {
  it('never leaves raw key in redacted text', () => {
    const db = openTestDb();
    setSecret(db, 'apikey:openai', 'sk-abcdefgh12345678');
    const raw = getSecret(db, 'apikey:openai');
    expect(raw).toBe('sk-abcdefgh12345678');
    const logged = redact(`key=sk-abcdefgh12345678 and Bearer abc.def.ghi`);
    expect(logged).not.toContain('sk-abcdefgh12345678');
    expect(logged).toContain('***');
    deleteSecret(db, 'apikey:openai');
    expect(getSecret(db, 'apikey:openai')).toBeUndefined();
    db.close();
  });
  it('redacts api_key assignments', () => {
    expect(redact('api_key: "secret123"')).toBe('api_key: "***"');
  });
});
