import { describe, it, expect } from 'vitest';
import {
  scanSecretsText,
  formatAttachCount,
  isLocalProvider,
  attachNoticeText,
} from '../../src/shared/attachments';

describe('scanSecretsText: evidence-based matches', () => {
  it('matches known secret samples', () => {
    expect(scanSecretsText('key = "sk-test-abc123def456ghi789"')).toBe(true);
    expect(scanSecretsText('openai key sk-proj-0123456789abcdefghi')).toBe(true);
    expect(scanSecretsText('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(scanSecretsText('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(true);
    expect(scanSecretsText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')).toBe(true);
    expect(scanSecretsText('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl...')).toBe(true);
    expect(scanSecretsText('db password=hunter2-secret')).toBe(true);
    expect(scanSecretsText('password: "correct horse battery staple"')).toBe(true);
    expect(scanSecretsText('api_key=abcdef1234567890')).toBe(true);
    expect(scanSecretsText('Authorization: Bearer ya29.secret-token-123')).toBe(true);
  });
  it('does not match empty text, prose, or clean code', () => {
    expect(scanSecretsText('')).toBe(false);
    expect(scanSecretsText('short')).toBe(false);
    expect(scanSecretsText('Meeting notes: discuss the API key rotation policy next quarter.')).toBe(false);
    expect(scanSecretsText('function login(user, password) { return check(user, password); }')).toBe(false);
    expect(scanSecretsText('const password = getPassword();')).toBe(false);
    expect(scanSecretsText('const apiKey = process.env.MY_KEY;')).toBe(false);
    expect(scanSecretsText('if (a === b) { return c; }')).toBe(false);
    expect(scanSecretsText('0'.repeat(3))).toBe(false);
  });
});

describe('formatAttachCount: proper plurals', () => {
  it('uses singular for one, plural otherwise', () => {
    expect(formatAttachCount(1)).toBe('1 attachment added');
    expect(formatAttachCount(3)).toBe('3 attachments added');
  });
});

describe('isLocalProvider + attachNoticeText: one sentence from provider type', () => {
  it('treats loopback and LAN custom endpoints as local', () => {
    for (const base of [
      'http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1',
      'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.20.4.9/v1',
      'http://mymac.local:8080/v1',
    ]) {
      expect(isLocalProvider('compatible', base)).toBe(true);
    }
  });
  it('treats hosted providers and public URLs as remote', () => {
    expect(isLocalProvider('openai', '')).toBe(false);
    expect(isLocalProvider('anthropic', '')).toBe(false);
    expect(isLocalProvider('compatible', 'https://api.example.com/v1')).toBe(false);
    expect(isLocalProvider('compatible', '')).toBe(false);
    expect(isLocalProvider('compatible', 'not a url')).toBe(false);
  });
  it('renders the single notice sentence', () => {
    expect(attachNoticeText('compatible', 'http://localhost:11434/v1')).toBe('Stays on this computer.');
    expect(attachNoticeText('openai', '')).toBe('Sent to OpenAI when you press Enter.');
    expect(attachNoticeText('anthropic', '')).toBe('Sent to Anthropic when you press Enter.');
    expect(attachNoticeText('compatible', 'https://api.example.com/v1')).toBe('Sent to Custom when you press Enter.');
  });
});
