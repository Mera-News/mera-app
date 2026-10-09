// The pure E2EE primitives (lib/e2ee/e2ee-crypto.ts). No mocks: @noble runs for real.
// The "model side" below is written out independently of the code under test (own HKDF info
// strings, own blob layouts), so a drifted constant in the app breaks a round trip here
// instead of being undone by the same drift on the way back.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { gcm } from '@noble/ciphers/aes.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  algoForKeyBytes,
  buildE2EEHeaders,
  bytesToHex,
  CLIENT_SECRET_LEN,
  decryptContent,
  encryptContent,
  hexToBytes,
  ModelKeyAlgoMismatchError,
  ModelKeyValidationError,
  type E2EEContext,
  type SigningAlgo,
} from '@/lib/e2ee/e2ee-crypto';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

// ---- model side, independent of lib/e2ee ------------------------------------------------

const utf8 = new TextEncoder();
const text = new TextDecoder();

function modelOpenEd25519(blobHex: string, modelSecret: Uint8Array): string {
  const blob = hexToBytes(blobHex);
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 56);
  const ct = blob.slice(56);
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(modelSecret), ephPub);
  const key = hkdf(sha256, shared, undefined, utf8.encode('ed25519_encryption'), 32);
  return text.decode(xchacha20poly1305(key, nonce).decrypt(ct));
}

function modelSealEd25519(plaintext: string, clientEdPub: Uint8Array): string {
  const ephSecret = randomBytes(32);
  const shared = x25519.getSharedSecret(ephSecret, ed25519.utils.toMontgomery(clientEdPub));
  const key = hkdf(sha256, shared, undefined, utf8.encode('ed25519_encryption'), 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8.encode(plaintext));
  return bytesToHex(Uint8Array.from([...x25519.getPublicKey(ephSecret), ...nonce, ...ct]));
}

function ecdsaKey(secret: Uint8Array, peerPub65: Uint8Array): Uint8Array {
  const x = secp256k1.getSharedSecret(secret, peerPub65).slice(1, 33);
  return hkdf(sha256, x, undefined, utf8.encode('ecdsa_encryption'), 32);
}

function modelOpenEcdsa(blobHex: string, modelSecret: Uint8Array): string {
  const blob = hexToBytes(blobHex);
  const key = ecdsaKey(modelSecret, blob.slice(0, 65));
  return text.decode(gcm(key, blob.slice(65, 77)).decrypt(blob.slice(77)));
}

/** `clientPub65` is the 0x04-prefixed point the client sends in X-Client-Pub-Key. */
function modelSealEcdsa(plaintext: string, clientPub65: Uint8Array): string {
  const ephSecret = secp256k1.utils.randomSecretKey();
  const key = ecdsaKey(ephSecret, clientPub65);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(utf8.encode(plaintext));
  return bytesToHex(Uint8Array.from([...secp256k1.getPublicKey(ephSecret, false), ...iv, ...ct]));
}

// ---- contexts -------------------------------------------------------------------------

function ctxFor(algo: SigningAlgo, modelPubKeyHex: string): E2EEContext {
  return {
    modelPubKeyHex,
    privateKey: new Uint8Array(32),
    clientPubKeyHex: 'unused',
    algo,
    headers: {} as never,
  };
}
const edCtx = () => ctxFor('ed25519', TEST_MODEL_KEYS.ed25519.publicKeyHex);
const ecCtx = () => ctxFor('ecdsa', TEST_MODEL_KEYS.ecdsa.publicKeyHex);
const EDS = TEST_MODEL_KEYS.ed25519.secret;
const ECS = TEST_MODEL_KEYS.ecdsa.secret;

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a throw');
}

// ---- ed25519 request direction ----------------------------------------------------------

describe('encryptContent / decryptContent: ed25519', () => {
  it('round-trips (the model opens what the client seals, with its own HKDF info)', () => {
    const blob = encryptContent('hello secure world', edCtx());
    expect(modelOpenEd25519(blob, EDS)).toBe('hello secure world');
    expect(decryptContent(blob, EDS)).toBe('hello secure world');
  });

  it('round-trips unicode and multibyte content', () => {
    const plaintext = '你好 — café ☕ \u{1F600}';
    const blob = encryptContent(plaintext, edCtx());
    expect(decryptContent(blob, EDS)).toBe(plaintext);
    expect(modelOpenEd25519(blob, EDS)).toBe(plaintext);
  });

  it('round-trips a very long plaintext', () => {
    const longText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(100);
    expect(decryptContent(encryptContent(longText, edCtx()), EDS)).toBe(longText);
  });

  it('round-trips a JSON-serialised object', () => {
    const payload = JSON.stringify({ scores: [0.8, 0.5, 0.1], model: 'test' });
    expect(JSON.parse(decryptContent(encryptContent(payload, edCtx()), EDS))).toEqual({
      scores: [0.8, 0.5, 0.1],
      model: 'test',
    });
  });

  it('seals toward a freshly generated model key too', () => {
    const secret = ed25519.utils.randomSecretKey();
    const blob = encryptContent('fresh key', ctxFor('ed25519', bytesToHex(ed25519.getPublicKey(secret))));
    expect(decryptContent(blob, secret)).toBe('fresh key');
  });

  it('produces ciphertext that differs from the plaintext and is longer than header + nonce', () => {
    const blob = encryptContent('visible text', edCtx());
    expect(blob).not.toContain('visible text');
    expect(blob.length).toBeGreaterThan((32 + 24) * 2);
  });

  it('is a lower-case hex string of at least 72 bytes even for an empty message', () => {
    // 32 (eph pub) + 24 (nonce) + 16 (poly1305 tag) + 0 (empty message)
    const blob = encryptContent('', edCtx());
    expect(blob).toMatch(/^[0-9a-f]+$/);
    expect(blob.length).toBe(144);
    expect(encryptContent('test', edCtx())).toMatch(/^[0-9a-f]+$/);
  });

  it('adds exactly the 72-byte envelope overhead to the plaintext bytes', () => {
    expect(encryptContent('abcde', edCtx()).length).toBe((72 + 5) * 2);
    expect(encryptContent('é', edCtx()).length).toBe((72 + 2) * 2);
  });

  it('uses a fresh ephemeral key and nonce per call (non-deterministic output)', () => {
    const a = encryptContent('same input', edCtx());
    const b = encryptContent('same input', edCtx());
    expect(a).not.toBe(b);
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
    expect(a.slice(64, 112)).not.toBe(b.slice(64, 112));
  });

  it('fails to decrypt with the wrong secret', () => {
    const blob = encryptContent('top secret', edCtx());
    expect(() => decryptContent(blob, ed25519.utils.randomSecretKey())).toThrow();
  });

  it('fails when the ciphertext is tampered with', () => {
    const blob = encryptContent('top secret', edCtx());
    const flipped = blob.slice(0, -2) + (blob.endsWith('00') ? '01' : '00');
    expect(() => decryptContent(flipped, EDS)).toThrow();
  });

  it('response direction: opens a reply the model sealed toward the client public key', () => {
    const clientSecret = ed25519.utils.randomSecretKey();
    const blob = modelSealEd25519('The model reply.', ed25519.getPublicKey(clientSecret));
    expect(decryptContent(blob, clientSecret, 'ed25519')).toBe('The model reply.');
    // 'ed25519' is the default algo (legacy callers and jobs written before the ecdsa split).
    expect(decryptContent(blob, clientSecret)).toBe('The model reply.');
  });
});

describe('decryptContent: ed25519 blob boundaries', () => {
  it('throws "too short" on a tiny blob', () => {
    expect(() => decryptContent('00ff', EDS)).toThrow(/too short/);
  });

  it('throws on an odd-length hex string', () => {
    expect(() => decryptContent('abc', new Uint8Array(32))).toThrow('Invalid hex string');
  });

  it('throws "too short" for 56 bytes, one under the 57 minimum', () => {
    expect(() => decryptContent('ab'.repeat(56), new Uint8Array(32))).toThrow('NEAR decrypt: blob too short (56 bytes)');
  });

  it('accepts 57 bytes past the length check and fails in the cipher instead', () => {
    const message = messageOf(() => decryptContent('cc'.repeat(57), new Uint8Array(32)));
    expect(message).not.toMatch(/too short/);
  });
});

// ---- ecdsa -----------------------------------------------------------------------------

describe('encryptContent / decryptContent: ecdsa', () => {
  it('request direction: the model opens what the client seals', () => {
    const plaintext = JSON.stringify({ q: 'generate topics', n: 42 });
    const blob = encryptContent(plaintext, ecCtx());
    expect(blob).toMatch(/^[0-9a-f]+$/);
    expect(modelOpenEcdsa(blob, ECS)).toBe(plaintext);
    expect(decryptContent(blob, ECS, 'ecdsa')).toBe(plaintext);
  });

  it('request direction: a long plaintext round-trips', () => {
    const longText = 'Lorem ipsum dolor sit amet. '.repeat(200);
    expect(modelOpenEcdsa(encryptContent(longText, ecCtx()), ECS)).toBe(longText);
  });

  it('request direction: unicode round-trips', () => {
    const plaintext = '你好 — café ☕ \u{1F600}';
    expect(modelOpenEcdsa(encryptContent(plaintext, ecCtx()), ECS)).toBe(plaintext);
  });

  it('adds exactly the 93-byte envelope overhead (65 point + 12 iv + 16 tag)', () => {
    expect(encryptContent('', ecCtx()).length).toBe(93 * 2);
    expect(encryptContent('abcde', ecCtx()).length).toBe((93 + 5) * 2);
  });

  it('uses a fresh ephemeral key and iv per call', () => {
    const a = encryptContent('same input', ecCtx());
    const b = encryptContent('same input', ecCtx());
    expect(a).not.toBe(b);
    expect(a.slice(0, 130)).not.toBe(b.slice(0, 130));
    // the ephemeral key is an uncompressed secp256k1 point
    expect(a.slice(0, 2)).toBe('04');
  });

  it('response direction: opens a reply sealed toward the client 65-byte point', () => {
    const clientSecret = secp256k1.utils.randomSecretKey();
    const blob = modelSealEcdsa(
      'The model reply, encrypted toward the client pubkey.',
      secp256k1.getPublicKey(clientSecret, false),
    );
    expect(decryptContent(blob, clientSecret, 'ecdsa')).toBe('The model reply, encrypted toward the client pubkey.');
  });

  it('fails to decrypt with the wrong secret', () => {
    const blob = encryptContent('top secret', ecCtx());
    expect(() => decryptContent(blob, secp256k1.utils.randomSecretKey(), 'ecdsa')).toThrow();
  });

  it('throws "ecdsa blob too short" for 92 bytes, one under the 93 minimum', () => {
    expect(() => decryptContent('ab'.repeat(92), new Uint8Array(32), 'ecdsa')).toThrow(
      'NEAR decrypt: ecdsa blob too short (92 bytes)',
    );
  });

  it('accepts 93 bytes past the length check and fails in the cipher instead', () => {
    // 65-byte point header + 28 bytes: past the 93-byte minimum, so the point parse or the tag check throws
    const blob = bytesToHex(Uint8Array.from([0x04, ...secp256k1.getPublicKey(ECS, false).slice(1), ...new Uint8Array(28)]));
    const message = messageOf(() => decryptContent(blob, ECS, 'ecdsa'));
    expect(message).not.toMatch(/too short/);
  });
});

// ---- algo / key coherence (MERA-APP-39) ---------------------------------------------------

describe('algoForKeyBytes', () => {
  it('maps 32 to ed25519 and 64 to ecdsa', () => {
    expect(algoForKeyBytes(32)).toBe('ed25519');
    expect(algoForKeyBytes(64)).toBe('ecdsa');
  });

  it.each([0, 31, 33, 63, 65])('throws on length %i', (len) => {
    expect(() => algoForKeyBytes(len)).toThrow(`unsupported signing-key length ${len} (expected 32 Ed25519 or 64 secp256k1)`);
  });
});

describe('encryptContent: algo/key mismatch guard', () => {
  it('throws typed when a 64-byte key is paired with an ed25519 context', () => {
    const ctx = ctxFor('ed25519', TEST_MODEL_KEYS.ecdsa.publicKeyHex);
    expect(() => encryptContent('hello', ctx)).toThrow(ModelKeyAlgoMismatchError);
    expect(() => encryptContent('hello', ctx)).toThrow('encryptContent: model key is ecdsa but context algo is ed25519');
  });

  it('throws typed for the reverse pairing (32-byte key, ecdsa context)', () => {
    const ctx = ctxFor('ecdsa', TEST_MODEL_KEYS.ed25519.publicKeyHex);
    expect(() => encryptContent('hello', ctx)).toThrow(ModelKeyAlgoMismatchError);
    expect(() => encryptContent('hello', ctx)).toThrow('encryptContent: model key is ed25519 but context algo is ecdsa');
  });

  it('carries the key hex, algo and endpoint on the error, and is a ModelKeyValidationError', () => {
    const ctx = ctxFor('ed25519', TEST_MODEL_KEYS.ecdsa.publicKeyHex);
    let caught: ModelKeyAlgoMismatchError | undefined;
    try {
      encryptContent('hello', ctx, 'https://gw.example/api/attestation/report');
    } catch (e) {
      caught = e as ModelKeyAlgoMismatchError;
    }
    expect(caught).toBeInstanceOf(ModelKeyAlgoMismatchError);
    expect(caught).toBeInstanceOf(ModelKeyValidationError);
    expect(caught!.name).toBe('ModelKeyAlgoMismatchError');
    expect(caught!.keyHex).toBe(TEST_MODEL_KEYS.ecdsa.publicKeyHex);
    expect(caught!.algo).toBe('ed25519');
    expect(caught!.model).toBe('(unknown)');
    expect(caught!.endpoint).toBe('https://gw.example/api/attestation/report');
  });

  it('throws the length error for a key that is neither 32 nor 64 bytes', () => {
    expect(() => encryptContent('x', ctxFor('ed25519', 'aa'.repeat(16)))).toThrow(
      'unsupported signing-key length 16',
    );
  });
});

describe('decryptContent: client secret length guard', () => {
  it('throws typed on a truncated persisted secret instead of an untyped noble error', () => {
    expect(() => decryptContent('00'.repeat(80), new Uint8Array(16), 'ed25519')).toThrow(ModelKeyAlgoMismatchError);
    expect(() => decryptContent('00'.repeat(120), new Uint8Array(16), 'ecdsa')).toThrow(
      'decryptContent: client secret is 16 bytes, expected 32 (algo=ecdsa)',
    );
  });

  it('guards an over-long secret as well', () => {
    expect(() => decryptContent('00'.repeat(80), new Uint8Array(33))).toThrow(
      `client secret is 33 bytes, expected ${CLIENT_SECRET_LEN}`,
    );
  });
});

// ---- headers ---------------------------------------------------------------------------

describe('buildE2EEHeaders', () => {
  it('ed25519 carries the version header', () => {
    expect(buildE2EEHeaders('ed25519', 'c1', 'm1')).toEqual({
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': 'c1',
      'X-Model-Pub-Key': 'm1',
      'X-Encryption-Version': '2',
    });
  });

  it('ecdsa omits the version header entirely (the key is absent, not undefined)', () => {
    const headers = buildE2EEHeaders('ecdsa', 'c2', 'm2');
    expect(headers).toEqual({ 'X-Signing-Algo': 'ecdsa', 'X-Client-Pub-Key': 'c2', 'X-Model-Pub-Key': 'm2' });
    expect(Object.keys(headers)).not.toContain('X-Encryption-Version');
  });
});

// ---- hex helpers -----------------------------------------------------------------------

describe('hexToBytes / bytesToHex', () => {
  it('round-trips, zero-padding single digits', () => {
    expect(bytesToHex(Uint8Array.from([0, 1, 15, 16, 255]))).toBe('00010f10ff');
    expect(Array.from(hexToBytes('00010f10ff'))).toEqual([0, 1, 15, 16, 255]);
  });

  it('strips a 0x prefix', () => {
    expect(Array.from(hexToBytes('0xabcd'))).toEqual([0xab, 0xcd]);
  });

  it('rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string');
    expect(() => hexToBytes('0xabc')).toThrow('Invalid hex string');
  });
});
