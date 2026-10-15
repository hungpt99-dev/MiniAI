import { __setBackendForTests, __resetSecretsForTests } from '../src/main/secrets/index';

// Deterministic XOR backend for unit tests (plain node has no Electron
// safeStorage). Production never uses this: writes without a real backend
// refuse loudly instead of persisting insecure fallbacks.
const XOR = 0x5a;
function xorBytes(b: Buffer): Buffer {
  const c = Buffer.from(b);
  for (let i = 0; i < c.length; i++) c[i] ^= XOR;
  return c;
}

__setBackendForTests({
  // why: crypto ops without claiming an OS store — memory tests encrypt like
  // production while isEncryptionAvailable() stays honestly false.
  available: () => false,
  encrypt: (s: string) => xorBytes(Buffer.from(s, 'utf8')),
  decrypt: (b: Buffer) => xorBytes(Buffer.from(b)).toString('utf8'),
});
__resetSecretsForTests();
