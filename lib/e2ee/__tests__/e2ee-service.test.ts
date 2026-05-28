/* eslint-disable @typescript-eslint/no-require-imports */
// Mock the module's I/O + env-coupled imports so the pure crypto path runs in
// jest. The @noble/* crypto itself is pure JS and runs natively.
jest.mock('../../auth-client', () => ({
  getJwtToken: jest.fn(() => Promise.resolve('test-jwt')),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../e2ee-cache', () => ({
  getCachedAttestation: jest.fn(() => null),
  setCachedAttestation: jest.fn(),
}));
jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.example.test',
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  encryptContent,
  decryptContent,
  type E2EEContext,
} from '../e2ee-service';

function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}

// Stand in for the server/model: an Ed25519 keypair. encryptContent targets the
// public key; decryptContent uses the matching secret (server's role here).
function makeContextForModel(modelEdSecret: Uint8Array): E2EEContext {
  const modelEdPublic = ed25519.getPublicKey(modelEdSecret);
  return {
    modelPubKeyHex: bytesToHex(modelEdPublic),
    privateKey: new Uint8Array(32), // unused on the encrypt side
    clientPubKeyHex: 'unused',
    headers: {
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': 'unused',
      'X-Model-Pub-Key': bytesToHex(modelEdPublic),
      'X-Encryption-Version': '2',
    },
  };
}

describe('e2ee encrypt/decrypt round-trip', () => {
  it('decrypts what it encrypts', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    const ctx = makeContextForModel(modelSecret);

    const plaintext = 'hello secure world';
    const blob = encryptContent(plaintext, ctx);
    const recovered = decryptContent(blob, modelSecret);

    expect(recovered).toBe(plaintext);
  });

  it('round-trips unicode / multibyte content', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    const ctx = makeContextForModel(modelSecret);

    const plaintext = '你好 — café ☕ \u{1F600}';
    const recovered = decryptContent(encryptContent(plaintext, ctx), modelSecret);

    expect(recovered).toBe(plaintext);
  });

  it('produces ciphertext that differs from the plaintext', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    const ctx = makeContextForModel(modelSecret);

    const plaintext = 'visible text';
    const blob = encryptContent(plaintext, ctx);

    expect(blob).not.toContain(plaintext);
    // hex blob = 32 (eph pub) + 24 (nonce) + ciphertext, all hex-encoded.
    expect(blob.length).toBeGreaterThan((32 + 24) * 2);
  });

  it('uses a fresh ephemeral key + nonce per call (non-deterministic output)', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    const ctx = makeContextForModel(modelSecret);

    const a = encryptContent('same input', ctx);
    const b = encryptContent('same input', ctx);

    expect(a).not.toBe(b);
    // First 32 bytes (64 hex chars) are the ephemeral pubkey — must differ.
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });

  it('throws on a blob that is too short to contain header + tag', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    expect(() => decryptContent('00ff', modelSecret)).toThrow(/too short/);
  });

  it('fails to decrypt with the wrong model secret', () => {
    const modelSecret = ed25519.utils.randomSecretKey();
    const wrongSecret = ed25519.utils.randomSecretKey();
    const ctx = makeContextForModel(modelSecret);

    const blob = encryptContent('top secret', ctx);
    expect(() => decryptContent(blob, wrongSecret)).toThrow();
  });
});
