/** Extended coverage for e2ee-service.ts — functions not covered by the
 *  existing e2ee-service.test.ts: fetchModelPublicKey, prepareE2EEContext,
 *  encryptMessages, and header construction.
 *
 *  @noble/* crypto is pure JS — runs for real. Only I/O is mocked.
 */

// ─── I/O mocks (must precede imports) ─────────────────────────────────────────

const mockGetJwtToken = jest.fn((..._args: any[]): Promise<string | null> => Promise.resolve('test-jwt'));
jest.mock('../../auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
}));

// Inline the logger object in the factory: ESM import hoisting evaluates this
// mock factory (at logger's first require) BEFORE a top-level `const mockLogger`
// would initialize, so an external variable resolves to undefined here. The
// sibling e2ee-service.test.ts uses the same inline pattern for the same reason.
jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
  },
}));

const mockGetCachedAttestation = jest.fn((..._args: any[]) => null as null | import('../e2ee-service').ModelAttestation);
const mockSetCachedAttestation = jest.fn();
jest.mock('../e2ee-cache', () => ({
  getCachedAttestation: (...args: unknown[]) => mockGetCachedAttestation(...args),
  setCachedAttestation: (...args: unknown[]) => mockSetCachedAttestation(...args),
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.example.test',
}));

// withRetry is pure logic — let it run for real, but its internal setTimeout
// will run without delays because we don't advance timers (we just want the retry
// function to call our op() the right number of times).
jest.mock('../../utils/retry', () => ({
  withRetry: jest.fn(async (op: () => Promise<unknown>) => op()),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
  fetchModelPublicKey,
  ModelKeyValidationError,
  prepareE2EEContext,
  encryptMessages,
  encryptContent,
  decryptContent,
  type ModelAttestation,
  type E2EEContext,
} from '../e2ee-service';
import { withRetry } from '../../utils/retry';
import logger from '../../logger';

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a real Ed25519 keypair and return the hex public key (server side). */
function makeModelKeyHex(): { privateKey: Uint8Array; publicKeyHex: string } {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const hex = Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { privateKey, publicKeyHex: hex };
}

/** Create a real secp256k1 keypair; return the model pubkey as the 64-byte
 *  raw x‖y hex (the encoding NEAR's attestation uses — uncompressed minus 0x04). */
function makeEcdsaModelKeyHex(): { privateKey: Uint8Array; publicKeyHex: string } {
  const privateKey = secp256k1.utils.randomSecretKey();
  const pub65 = secp256k1.getPublicKey(privateKey, false); // 0x04 ‖ x ‖ y
  return { privateKey, publicKeyHex: toHex(pub65.slice(1)) };
}

/** Server-side counterpart of the client's ecdsa scheme, used to prove wire
 *  interop: derive the AES key from the shared point x-coordinate + HKDF, then
 *  AES-256-GCM. `peerPub65` is the other party's uncompressed point. */
function ecdsaDeriveKey(secret: Uint8Array, peerPub65: Uint8Array): Uint8Array {
  const x = secp256k1.getSharedSecret(secret, peerPub65).slice(1, 33);
  return hkdf(sha256, x, undefined, new TextEncoder().encode('ecdsa_encryption'), 32);
}
/** Decrypt a blob produced by the client's encryptContent (ecdsa) as the model would. */
function ecdsaServerDecrypt(hexBlob: string, modelSecret: Uint8Array): string {
  const blob = fromHex(hexBlob);
  const ephPub = blob.slice(0, 65);
  const iv = blob.slice(65, 77);
  const ct = blob.slice(77);
  const key = ecdsaDeriveKey(modelSecret, ephPub);
  return new TextDecoder().decode(gcm(key, iv).decrypt(ct));
}
/** Encrypt a response toward the client's secp256k1 pubkey, as the server would.
 *  `clientPub65Hex` is the 65-byte uncompressed point sent in X-Client-Pub-Key. */
function ecdsaServerEncrypt(plaintext: string, clientPub65Hex: string): string {
  const clientPub65 = fromHex(clientPub65Hex);
  const ephSecret = secp256k1.utils.randomSecretKey();
  const ephPublic = secp256k1.getPublicKey(ephSecret, false);
  const key = ecdsaDeriveKey(ephSecret, clientPub65);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  const blob = new Uint8Array(65 + 12 + ct.length);
  blob.set(ephPublic, 0);
  blob.set(iv, 65);
  blob.set(ct, 77);
  return toHex(blob);
}

/** Fake a valid attestation response JSON for a given pubkey hex. */
function makeAttestationBody(pubKeyHex: string): object {
  return {
    model_attestations: [
      {
        signing_public_key: pubKeyHex,
        signing_address: 'near:test.near',
      },
    ],
  };
}

function makeResponse(
  status: number,
  body: unknown,
  opts: { text?: string } = {},
): Response {
  return {
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
    json: jest.fn(() => Promise.resolve(body)),
    text: jest.fn(() => Promise.resolve(opts.text ?? JSON.stringify(body))),
  } as unknown as Response;
}

// Replace global fetch so fetchWithTimeout works in the test environment
const mockGlobalFetch = jest.fn();
global.fetch = mockGlobalFetch as unknown as typeof fetch;

// ─── fetchModelPublicKey ───────────────────────────────────────────────────────

describe('fetchModelPublicKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: cache miss
    mockGetCachedAttestation.mockReturnValue(null);
  });

  it('returns cached attestation without fetching', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    const cached: ModelAttestation = { publicKey: publicKeyHex, algo: 'ed25519', signingId: 'near:test.near' };
    mockGetCachedAttestation.mockReturnValueOnce(cached);

    const result = await fetchModelPublicKey('test-model');

    expect(result).toBe(cached);
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it('fetches attestation and caches it on cache miss', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const result = await fetchModelPublicKey('test-model');

    expect(result.publicKey).toBe(publicKeyHex);
    expect(mockSetCachedAttestation).toHaveBeenCalledWith('test-model', result);
  });

  it('includes Authorization header when JWT is available', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    await fetchModelPublicKey('test-model');

    const [, fetchInit] = mockGlobalFetch.mock.calls[0] as [string, RequestInit];
    expect((fetchInit.headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt');
  });

  it('omits Authorization header when JWT is null', async () => {
    mockGetJwtToken.mockResolvedValueOnce(null);
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    await fetchModelPublicKey('test-model');

    const [, fetchInit] = mockGlobalFetch.mock.calls[0] as [string, RequestInit];
    const authHeader = (fetchInit.headers as Record<string, string>)?.['Authorization'];
    expect(authHeader).toBeUndefined();
  });

  it('includes model param and signing_algo in query string', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    await fetchModelPublicKey('my-model/test');

    const [url] = mockGlobalFetch.mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent('my-model/test'));
    expect(url).toContain('signing_algo=ed25519');
  });

  it('stores signingId from signing_address field', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const result = await fetchModelPublicKey('test-model');
    expect(result.signingId).toBe('near:test.near');
  });

  it('throws when signing_public_key is missing from response', async () => {
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, { model_attestations: [{}] }),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toThrow(
      /signing_public_key missing/,
    );
  });

  it('throws when model_attestations is empty', async () => {
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, { model_attestations: [] }),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toThrow(
      /signing_public_key missing/,
    );
  });

  it('throws when pubkey is an unsupported length (neither 32 nor 64)', async () => {
    // 16 bytes = 32 hex chars — too short for either curve
    const shortKey = 'aa'.repeat(16);
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, {
        model_attestations: [{ signing_public_key: shortKey }],
      }),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toThrow(
      /unsupported signing-key length 16/,
    );
  });

  it('detects ed25519 from a 32-byte key', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const result = await fetchModelPublicKey('test-model');
    expect(result.algo).toBe('ed25519');
    expect(result.publicKey).toBe(publicKeyHex);
  });

  it('detects ecdsa from a 64-byte secp256k1 key', async () => {
    const { publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const result = await fetchModelPublicKey('test-model');
    expect(result.algo).toBe('ecdsa');
    expect(result.publicKey).toBe(publicKeyHex);
  });

  // ─── Fail-fast: hostile 64-byte key that is NOT on secp256k1 (MERA-APP-39) ───

  /** A 64-byte value that is NOT a valid raw secp256k1 (x, y) point: an ed25519
   *  public key concatenated with itself. Reconstructing 0x04‖x‖y and asserting
   *  validity throws "bad point: is not on curve". */
  function makeOffCurve64Hex(): string {
    const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey()); // 32 bytes
    const off = new Uint8Array(64);
    off.set(edPub, 0);
    off.set(edPub, 32);
    return toHex(off);
  }

  it('throws a typed ModelKeyValidationError for an off-curve 64-byte key (not a deep noble throw)', async () => {
    const offCurveHex = makeOffCurve64Hex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(offCurveHex)),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toBeInstanceOf(
      ModelKeyValidationError,
    );
  });

  it('carries the raw key hex + algo + model + endpoint on the thrown error', async () => {
    const offCurveHex = makeOffCurve64Hex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(offCurveHex)),
    );

    let caught: ModelKeyValidationError | undefined;
    try {
      await fetchModelPublicKey('near-cold-model');
    } catch (err) {
      caught = err as ModelKeyValidationError;
    }
    expect(caught).toBeInstanceOf(ModelKeyValidationError);
    expect(caught!.keyHex).toBe(offCurveHex);
    expect(caught!.algo).toBe('ecdsa');
    expect(caught!.model).toBe('near-cold-model');
    expect(caught!.endpoint).toContain('/api/attestation/report');
  });

  it('captures the off-curve key to Sentry ONCE with the raw hex in extras', async () => {
    const offCurveHex = makeOffCurve64Hex();
    // Two fetches of the SAME bad key → still exactly one capture (deduped by hex).
    mockGlobalFetch
      .mockResolvedValueOnce(makeResponse(200, makeAttestationBody(offCurveHex)))
      .mockResolvedValueOnce(makeResponse(200, makeAttestationBody(offCurveHex)));

    await expect(fetchModelPublicKey('m')).rejects.toBeInstanceOf(ModelKeyValidationError);
    await expect(fetchModelPublicKey('m')).rejects.toBeInstanceOf(ModelKeyValidationError);

    expect(logger.captureException).toHaveBeenCalledTimes(1);
    const [, meta] = (logger.captureException as jest.Mock).mock.calls[0] as [
      unknown,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(meta.tags).toMatchObject({ service: 'e2ee', step: 'model-key-validate' });
    expect(meta.extra).toMatchObject({ keyHex: offCurveHex, algo: 'ecdsa', model: 'm' });
  });

  it('does NOT cache an off-curve key (a later fetch can still succeed)', async () => {
    const offCurveHex = makeOffCurve64Hex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(offCurveHex)),
    );
    await expect(fetchModelPublicKey('m')).rejects.toBeInstanceOf(ModelKeyValidationError);
    expect(mockSetCachedAttestation).not.toHaveBeenCalled();
  });

  it('still accepts a valid secp256k1 raw (x, y) key', async () => {
    const { publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const result = await fetchModelPublicKey('test-model');
    expect(result.algo).toBe('ecdsa');
    expect(result.publicKey).toBe(publicKeyHex);
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('throws when HTTP response is not ok (non-5xx, e.g. 403)', async () => {
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(403, {}, { text: 'Forbidden' }),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toThrow(
      /NEAR attestation failed \(403\)/,
    );
  });

  it('uses withRetry for the fetch call', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    await fetchModelPublicKey('test-model');
    expect(withRetry).toHaveBeenCalledTimes(1);
  });

  it('throws when fetch returns 5xx (op throws inside withRetry)', async () => {
    // The op inside withRetry checks r.status >= 500 and throws.
    // Our withRetry mock calls op() once, so the throw propagates.
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(500, {}, { text: 'Internal Server Error' }),
    );

    await expect(fetchModelPublicKey('test-model')).rejects.toThrow(
      /NEAR attestation failed \(500\)/,
    );
  });

  it('strips 0x prefix from pubkey hex (hexToBytes handles 0x-prefixed strings)', async () => {
    // Build a valid 32-byte Ed25519 pubkey as hex WITHOUT 0x prefix, then wrap in 0x.
    const { publicKeyHex } = makeModelKeyHex();
    const pubKeyWith0x = '0x' + publicKeyHex;
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, {
        model_attestations: [
          { signing_public_key: pubKeyWith0x, signing_address: 'near:test.near' },
        ],
      }),
    );

    const result = await fetchModelPublicKey('test-model');
    // Should succeed — 0x prefix should be stripped before parsing
    expect(result.publicKey).toBe(pubKeyWith0x);
  });

  it('sets signingId to undefined when signing_address is absent', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, {
        model_attestations: [
          { signing_public_key: publicKeyHex /* no signing_address */ },
        ],
      }),
    );

    const result = await fetchModelPublicKey('test-model');
    expect(result.signingId).toBeUndefined();
  });
});

// ─── prepareE2EEContext ────────────────────────────────────────────────────────

describe('prepareE2EEContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedAttestation.mockReturnValue(null);
  });

  function setupAttestationFetch(): { publicKeyHex: string; privateKey: Uint8Array } {
    const { publicKeyHex, privateKey } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );
    return { publicKeyHex, privateKey };
  }

  it('returns an E2EEContext with required fields', async () => {
    const { publicKeyHex } = setupAttestationFetch();
    const ctx = await prepareE2EEContext('test-model');

    expect(ctx.modelPubKeyHex).toBe(publicKeyHex);
    expect(ctx.privateKey).toBeInstanceOf(Uint8Array);
    expect(ctx.privateKey.length).toBe(32);
    expect(typeof ctx.clientPubKeyHex).toBe('string');
    expect(ctx.clientPubKeyHex.length).toBeGreaterThan(0);
  });

  it('constructs correct E2EE headers', async () => {
    const { publicKeyHex } = setupAttestationFetch();
    const ctx = await prepareE2EEContext('test-model');

    expect(ctx.headers['X-Signing-Algo']).toBe('ed25519');
    expect(ctx.headers['X-Client-Pub-Key']).toBe(ctx.clientPubKeyHex);
    expect(ctx.headers['X-Model-Pub-Key']).toBe(publicKeyHex);
    expect(ctx.headers['X-Encryption-Version']).toBe('2');
  });

  it('generates a fresh Ed25519 keypair each call (non-deterministic)', async () => {
    const { publicKeyHex: pkHex1 } = makeModelKeyHex();
    const { publicKeyHex: pkHex2 } = makeModelKeyHex();
    mockGlobalFetch
      .mockResolvedValueOnce(makeResponse(200, makeAttestationBody(pkHex1)))
      .mockResolvedValueOnce(makeResponse(200, makeAttestationBody(pkHex2)));
    // Both fetches will cache-miss
    mockGetCachedAttestation.mockReturnValue(null);

    const ctx1 = await prepareE2EEContext('model-1');
    const ctx2 = await prepareE2EEContext('model-2');

    // Different models → different contexts; even same model produces different keys
    expect(ctx1.clientPubKeyHex).not.toBe(ctx2.clientPubKeyHex);
  });

  it('clientPubKeyHex is a valid 32-byte Ed25519 pubkey (64 hex chars)', async () => {
    setupAttestationFetch();
    const ctx = await prepareE2EEContext('test-model');

    // Ed25519 public key is 32 bytes → 64 hex chars
    expect(ctx.clientPubKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── encryptMessages ───────────────────────────────────────────────────────────

describe('encryptMessages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedAttestation.mockReturnValue(null);
  });

  it('encrypts all non-empty message contents in-place', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Tell me something.' },
    ];

    await encryptMessages(messages, 'test-model');

    // Contents should be encrypted (no longer the original plaintext)
    expect(messages[0].content).not.toBe('You are helpful.');
    expect(messages[1].content).not.toBe('Tell me something.');
    // Encrypted content is a hex string (32+24+... bytes encoded)
    expect(messages[0].content).toMatch(/^[0-9a-f]+$/);
    expect(messages[1].content).toMatch(/^[0-9a-f]+$/);
  });

  it('skips empty-content messages', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
    ];

    await encryptMessages(messages, 'test-model');

    // Empty content must stay empty
    expect(messages[0].content).toBe('');
    // Non-empty must be encrypted
    expect(messages[1].content).not.toBe('Hello');
  });

  it('returns E2EEContext with a 32-byte Ed25519 private key', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const messages = [{ role: 'user', content: 'Secret text' }];
    const ctx = await encryptMessages(messages, 'test-model');

    // The returned privateKey is the client's Ed25519 secret (32 bytes).
    // decryptContent is for decrypting server→client responses (different ECDH
    // direction), so we only verify the key shape here, not a round-trip.
    expect(ctx.privateKey).toBeInstanceOf(Uint8Array);
    expect(ctx.privateKey.length).toBe(32);
    // Content was encrypted (not plaintext) and is a hex blob
    expect(messages[0].content).toMatch(/^[0-9a-f]+$/);
    expect(messages[0].content).not.toBe('Secret text');
  });

  it('works with additional message fields (e.g. tool_calls)', async () => {
    const { publicKeyHex } = makeModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const messages = [
      { role: 'assistant', content: 'result', tool_calls: [{ id: 'tc1', name: 'f' }] },
    ];

    const ctx = await encryptMessages(messages, 'test-model');
    // Content should be encrypted; extra fields preserved
    expect(messages[0].content).not.toBe('result');
    expect((messages[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
  });
});

// ─── encryptContent + decryptContent — additional edge cases ──────────────────

describe('encryptContent — additional edge cases', () => {
  it('produces a hex string of expected minimum length', () => {
    const { privateKey: modelPrivKey, publicKeyHex: modelPubKeyHex } = makeModelKeyHex();
    const ctx: E2EEContext = {
      modelPubKeyHex,
      privateKey: new Uint8Array(32),
      clientPubKeyHex: 'unused',
      algo: 'ed25519',
      headers: {
        'X-Signing-Algo': 'ed25519',
        'X-Client-Pub-Key': 'unused',
        'X-Model-Pub-Key': modelPubKeyHex,
        'X-Encryption-Version': '2',
      },
    };
    // Minimum blob: 32 (eph pub) + 24 (nonce) + 16 (poly1305 tag) + 0 (empty msg) = 72 bytes → 144 hex chars
    const blob = encryptContent('', ctx);
    expect(blob.length).toBeGreaterThanOrEqual(144);
  });

  it('is a valid hex string (only 0-9, a-f characters)', () => {
    const { publicKeyHex: modelPubKeyHex } = makeModelKeyHex();
    const ctx: E2EEContext = {
      modelPubKeyHex,
      privateKey: new Uint8Array(32),
      clientPubKeyHex: 'unused',
      algo: 'ed25519',
      headers: {
        'X-Signing-Algo': 'ed25519',
        'X-Client-Pub-Key': 'unused',
        'X-Model-Pub-Key': modelPubKeyHex,
        'X-Encryption-Version': '2',
      },
    };
    const blob = encryptContent('test', ctx);
    expect(blob).toMatch(/^[0-9a-f]+$/);
  });
});

describe('decryptContent — additional edge cases', () => {
  it('throws on odd-length hex string', () => {
    expect(() => decryptContent('abc', new Uint8Array(32))).toThrow();
  });

  it('throws on blob shorter than 57 bytes (114 hex chars)', () => {
    // 56 bytes = 112 hex chars — one byte too short
    const shortBlob = 'ab'.repeat(56);
    expect(() => decryptContent(shortBlob, new Uint8Array(32))).toThrow(/too short/);
  });

  it('throws on blob exactly 56 bytes (boundary: one below minimum)', () => {
    const blob = 'ff'.repeat(56);
    expect(() => decryptContent(blob, new Uint8Array(32))).toThrow(/too short/);
  });

  it('accepts blob of exactly 57 bytes but fails auth-tag check with wrong key', () => {
    // 57 bytes = 32 (eph pub) + 24 (nonce) + 1 (minimal ct) — but wrong key → crypto error
    const blob = 'cc'.repeat(57);
    // Should get past the length check but fail decryption
    expect(() => decryptContent(blob, new Uint8Array(32))).toThrow();
  });

  it('round-trips a very long plaintext', () => {
    const { privateKey: modelPrivKey, publicKeyHex: modelPubKeyHex } = makeModelKeyHex();
    const ctx: E2EEContext = {
      modelPubKeyHex,
      privateKey: modelPrivKey,
      clientPubKeyHex: 'unused',
      algo: 'ed25519',
      headers: {
        'X-Signing-Algo': 'ed25519',
        'X-Client-Pub-Key': 'unused',
        'X-Model-Pub-Key': modelPubKeyHex,
        'X-Encryption-Version': '2',
      },
    };

    const longText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(100);
    const blob = encryptContent(longText, ctx);
    const decrypted = decryptContent(blob, modelPrivKey);
    expect(decrypted).toBe(longText);
  });

  it('round-trips a JSON-serialised object', () => {
    const { privateKey: modelPrivKey, publicKeyHex: modelPubKeyHex } = makeModelKeyHex();
    const ctx: E2EEContext = {
      modelPubKeyHex,
      privateKey: modelPrivKey,
      clientPubKeyHex: 'unused',
      algo: 'ed25519',
      headers: {
        'X-Signing-Algo': 'ed25519',
        'X-Client-Pub-Key': 'unused',
        'X-Model-Pub-Key': modelPubKeyHex,
        'X-Encryption-Version': '2',
      },
    };

    const payload = JSON.stringify({ scores: [0.8, 0.5, 0.1], model: 'test' });
    const blob = encryptContent(payload, ctx);
    expect(JSON.parse(decryptContent(blob, modelPrivKey))).toEqual(JSON.parse(payload));
  });
});

// ─── ecdsa (secp256k1) path ────────────────────────────────────────────────────

describe('ecdsa (secp256k1) E2EE path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedAttestation.mockReturnValue(null);
  });

  it('prepareE2EEContext builds an ecdsa context with correct headers', async () => {
    const { publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );

    const ctx = await prepareE2EEContext('ecdsa-model');

    expect(ctx.algo).toBe('ecdsa');
    expect(ctx.headers['X-Signing-Algo']).toBe('ecdsa');
    expect(ctx.headers['X-Model-Pub-Key']).toBe(publicKeyHex);
    // Legacy ecdsa scheme is unversioned — the header must be absent.
    expect(ctx.headers['X-Encryption-Version']).toBeUndefined();
    // secp256k1 secret is 32 bytes; client pubkey header is the 65-byte
    // uncompressed point (0x04 ‖ x ‖ y) → 130 hex chars starting with '04'.
    expect(ctx.privateKey.length).toBe(32);
    expect(ctx.clientPubKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(ctx.headers['X-Client-Pub-Key']).toBe(ctx.clientPubKeyHex);
  });

  it('request direction: encryptContent → the model can decrypt', async () => {
    const { privateKey: modelSecret, publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );
    const ctx = await prepareE2EEContext('ecdsa-model');

    const plaintext = JSON.stringify({ q: 'generate topics', n: 42 });
    const blob = encryptContent(plaintext, ctx);
    expect(blob).toMatch(/^[0-9a-f]+$/);
    // The model (server side) decrypts with its secp256k1 secret.
    expect(ecdsaServerDecrypt(blob, modelSecret)).toBe(plaintext);
  });

  it('response direction: decryptContent recovers a server-encrypted reply', async () => {
    const { publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );
    const ctx = await prepareE2EEContext('ecdsa-model');

    const response = 'The model reply, encrypted toward the client pubkey.';
    // Server encrypts toward the client's advertised secp256k1 pubkey.
    const blob = ecdsaServerEncrypt(response, ctx.clientPubKeyHex);
    expect(decryptContent(blob, ctx.privateKey, 'ecdsa')).toBe(response);
  });

  it('round-trips a long plaintext through the client encrypt path', async () => {
    const { privateKey: modelSecret, publicKeyHex } = makeEcdsaModelKeyHex();
    mockGlobalFetch.mockResolvedValueOnce(
      makeResponse(200, makeAttestationBody(publicKeyHex)),
    );
    const ctx = await prepareE2EEContext('ecdsa-model');

    const longText = 'Lorem ipsum dolor sit amet. '.repeat(200);
    expect(ecdsaServerDecrypt(encryptContent(longText, ctx), modelSecret)).toBe(longText);
  });

  it('throws on an ecdsa blob shorter than the minimum', () => {
    // header (65+12) + tag (16) = 93 bytes minimum; 92 bytes → too short
    const shortBlob = 'ab'.repeat(92);
    expect(() => decryptContent(shortBlob, new Uint8Array(32), 'ecdsa')).toThrow(
      /ecdsa blob too short/,
    );
  });
});
