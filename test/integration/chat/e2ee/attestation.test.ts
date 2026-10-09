// lib/e2ee/e2ee-service.ts against the gateway mock: attestation fetch, cache, context build and
// rebuild, and message encryption. Real auth (the fixture account), the real limiter, the real
// attestation cache and the real logger; only the network is the mock. The model side opens
// envelopes with the fixed test keys.
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as Sentry from '@sentry/react-native';
import { _getBreakerState, _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { setSetting } from '@/lib/database/services/setting-service';
import { clearAttestationCache, getCachedAttestation, setCachedAttestation } from '@/lib/e2ee/e2ee-cache';
import {
  bytesToHex,
  decryptContent,
  encryptContent,
  hexToBytes,
  type E2EEContext,
} from '@/lib/e2ee/e2ee-crypto';
import {
  encryptMessages,
  fetchModelPublicKey,
  ModelKeyAlgoMismatchError,
  ModelKeyValidationError,
  NoCredentialError,
  prepareE2EEContext,
  rebuildE2EEContext,
  type ModelAttestation,
} from '@/lib/e2ee/e2ee-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import {
  _resetForTests as resetLimiter,
  INTERACTIVE_MAX_PAUSE_MS,
  interactiveWaitMs,
  msUntilNextGrant,
} from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests, OnDeviceModeError } from '@/lib/llm/on-device-gate';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  attestationRequests,
  defaultResponder,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
} from '@/test/helpers';
import { driveUntilDone, useStrictClock } from '@/test/integration/chat/_helpers';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const ROUTE = '*/api/attestation/report';
const ENDPOINT = 'http://127.0.0.1:8790/api/attestation/report';
const MODEL = 'test-model';
const ED = TEST_MODEL_KEYS.ed25519.publicKeyHex;
const EC = TEST_MODEL_KEYS.ecdsa.publicKeyHex;

interface Seen {
  model: string | null;
  algo: string | null;
  nonce: string | null;
  authorization: string | null;
  rawUrl: string;
  at: number;
}
let seen: Seen[] = [];

function watchAttestation(): void {
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/api/attestation/report')) return;
    seen.push({
      model: url.searchParams.get('model'),
      algo: url.searchParams.get('signing_algo'),
      nonce: url.searchParams.get('nonce'),
      authorization: request.headers.get('authorization'),
      rawUrl: request.url,
      at: Date.now(),
    });
  });
}

/** Serve `body` on the attestation route for the rest of the test (or once). */
function serve(body: unknown, opts: { status?: number; once?: boolean } = {}): void {
  server.use(
    http.get(ROUTE, () => HttpResponse.json(body as Record<string, unknown>, { status: opts.status ?? 200 }), {
      once: opts.once ?? false,
    }),
  );
}
const serveKey = (key: string, extra: Record<string, unknown> = {}, opts: { once?: boolean } = {}) =>
  serve({ model_attestations: [{ signing_public_key: key, ...extra }] }, opts);
const serveText = (text: string, status: number, headers: Record<string, string> = {}, once = false) =>
  server.use(http.get(ROUTE, () => new HttpResponse(text, { status, headers }), { once }));

function curve(map: Record<string, 'ed25519' | 'ecdsa'>): void {
  server.use(...mockGateway(defaultResponder, { curve: map }));
}

/** A 64-byte value that is not a point on secp256k1 (an ed25519 key doubled). Fresh per call:
 *  the capture-once set is module state, so each test needs its own bad key. */
function offCurveHex(): string {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  return bytesToHex(Uint8Array.from([...pub, ...pub]));
}

/** Runs a promise to completion on the fake clock and returns its rejection (or null). */
async function errorOf(p: Promise<unknown>): Promise<Error | null> {
  return driveUntilDone(p).then(
    () => null,
    (e: Error) => e,
  );
}

const run = <T,>(p: Promise<T>) => driveUntilDone(p);

const sentryCapture = Sentry.captureException as jest.Mock;
let captureSpy: jest.SpyInstance | undefined;

beforeEach(() => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  resetBreaker();
  __resetOnDeviceGateForTests();
  sentryCapture.mockClear();
  seen = [];
  watchAttestation();
});

afterEach(() => {
  server.events.removeAllListeners();
  captureSpy?.mockRestore();
  captureSpy = undefined;
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

// Aliased: a function named use* trips react-hooks/rules-of-hooks wherever it is called.
const fakeClock = useStrictClock;

async function signedIn(): Promise<void> {
  await signInFixtureAccount();
  // The real clock's value, so the JWT cache and the cookie lifetimes agree with the fake one.
  fakeClock(Date.now());
}

// ---------------------------------------------------------------------------------------------

describe('fetchModelPublicKey: cache and dedupe', () => {
  beforeEach(signedIn);

  it('returns a cached attestation without any request', async () => {
    const cached: ModelAttestation = { publicKey: ED, algo: 'ed25519', signingId: 'near:test.near' };
    setCachedAttestation(MODEL, cached);

    const result = await run(fetchModelPublicKey(MODEL));

    expect(result).toBe(cached);
    expect(seen).toHaveLength(0);
    expect(attestationRequests()).toBe(0);
  });

  it('fetches once on a miss, caches the result, and serves the second call from the cache', async () => {
    const first = await run(fetchModelPublicKey(MODEL));

    expect(first).toEqual({ publicKey: ED, algo: 'ed25519', signingId: '0xe2e' });
    expect(getCachedAttestation(MODEL)).toBe(first);
    expect(attestationRequests(MODEL)).toBe(1);

    const second = await run(fetchModelPublicKey(MODEL));
    expect(second).toBe(first);
    expect(attestationRequests(MODEL)).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('collapses concurrent cold-cache callers onto ONE request (MERA-APP-71)', async () => {
    const [a, b, c] = await run(
      Promise.all([fetchModelPublicKey(MODEL), fetchModelPublicKey(MODEL), fetchModelPublicKey(MODEL)]),
    );

    expect(attestationRequests(MODEL)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not collapse different models: one request each', async () => {
    await run(Promise.all([fetchModelPublicKey('model-a'), fetchModelPublicKey('model-b')]));

    expect(attestationRequests('model-a')).toBe(1);
    expect(attestationRequests('model-b')).toBe(1);
    expect(seen.map((s) => s.model).sort()).toEqual(['model-a', 'model-b']);
  });

  it('does not cache a failed fetch, and the next call succeeds', async () => {
    serveText('Forbidden', 403, {}, true);

    const err = await errorOf(fetchModelPublicKey(MODEL));

    expect(err).toMatchObject({ name: 'NearAttestationError', statusCode: 403 });
    expect(getCachedAttestation(MODEL)).toBeNull();

    const result = await run(fetchModelPublicKey(MODEL));
    expect(result.publicKey).toBe(ED);
    expect(getCachedAttestation(MODEL)).toBe(result);
    expect(seen).toHaveLength(2);
  });

  it('a throttled in-flight fetch does not wedge the model: the next caller retries (MERA-APP-71)', async () => {
    serveText('ThrottlerException', 429, {}, true);

    await expect(run(fetchModelPublicKey(MODEL))).rejects.toThrow(/NEAR attestation failed \(429\)/);
    const result = await run(fetchModelPublicKey(MODEL));

    expect(result.publicKey).toBe(ED);
    expect(seen).toHaveLength(2);
  });
});

describe('fetchModelPublicKey: the request', () => {
  beforeEach(signedIn);

  it('carries the bearer token, the model and signing_algo=ed25519, and no nonce', async () => {
    await run(fetchModelPublicKey('my-model/test'));

    const token = await run(getJwtToken());
    expect(token).toEqual(expect.any(String));
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe(`Bearer ${token}`);
    expect(seen[0].model).toBe('my-model/test');
    expect(seen[0].algo).toBe('ed25519');
    expect(seen[0].nonce).toBeNull();
    expect(seen[0].rawUrl).toContain(`model=${encodeURIComponent('my-model/test')}`);
    expect(seen[0].rawUrl).toContain('signing_algo=ed25519');
  });
});

describe('fetchModelPublicKey: response shapes', () => {
  beforeEach(signedIn);

  it('signingId comes from signing_address', async () => {
    serveKey(ED, { signing_address: 'near:test.near' });
    expect((await run(fetchModelPublicKey(MODEL))).signingId).toBe('near:test.near');
  });

  it('signingId is undefined when signing_address is absent (the slim gateway shape)', async () => {
    serveKey(ED);
    const result = await run(fetchModelPublicKey(MODEL));
    expect(result.signingId).toBeUndefined();
    expect(result).toEqual({ publicKey: ED, algo: 'ed25519', signingId: undefined });
  });

  it('throws when signing_public_key is missing', async () => {
    serve({ model_attestations: [{}] });
    await expect(run(fetchModelPublicKey(MODEL))).rejects.toThrow(
      'NEAR attestation: signing_public_key missing. top=model_attestations',
    );
  });

  it('throws when model_attestations is empty', async () => {
    serve({ model_attestations: [] });
    await expect(run(fetchModelPublicKey(MODEL))).rejects.toThrow(/signing_public_key missing/);
  });

  it('throws on a 3p-shaped body (e2e_pubkey, no signing_public_key) and names its top-level keys', async () => {
    serve({ model_attestations: [{ e2e_pubkey: 'ab'.repeat(32), certificate_b64: 'x', quote_b64: 'y' }], extra: 1 });
    await expect(run(fetchModelPublicKey(MODEL))).rejects.toThrow(
      'NEAR attestation: signing_public_key missing. top=model_attestations,extra',
    );
  });

  it('throws on a key that is neither 32 nor 64 bytes', async () => {
    serveKey('aa'.repeat(16));
    await expect(run(fetchModelPublicKey(MODEL))).rejects.toThrow(/unsupported signing-key length 16/);
    expect(getCachedAttestation(MODEL)).toBeNull();
  });

  it('accepts a 0x-prefixed key and returns it unchanged', async () => {
    serveKey('0x' + ED, { signing_address: 'near:test.near' });
    const result = await run(fetchModelPublicKey(MODEL));
    expect(result.publicKey).toBe('0x' + ED);
    expect(result.algo).toBe('ed25519');
  });

  it('detects ed25519 from a 32-byte key', async () => {
    const result = await run(fetchModelPublicKey(MODEL));
    expect(result.algo).toBe('ed25519');
    expect(result.publicKey).toBe(ED);
  });

  it('detects ecdsa from a 64-byte secp256k1 key (the mock serving the other curve)', async () => {
    curve({ [MODEL]: 'ecdsa' });
    const result = await run(fetchModelPublicKey(MODEL));
    expect(result.algo).toBe('ecdsa');
    expect(result.publicKey).toBe(EC);
    expect(hexToBytes(result.publicKey)).toHaveLength(64);
  });

  it('a valid ecdsa key reaches Sentry with nothing', async () => {
    captureSpy = jest.spyOn(logger, 'captureException');
    curve({ [MODEL]: 'ecdsa' });
    await run(fetchModelPublicKey(MODEL));
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe('fetchModelPublicKey: an off-curve 64-byte key (MERA-APP-39)', () => {
  beforeEach(signedIn);

  it('throws a typed ModelKeyValidationError carrying the key, algo, model and endpoint', async () => {
    const bad = offCurveHex();
    serveKey(bad);

    const err = (await errorOf(fetchModelPublicKey('near-cold-model'))) as ModelKeyValidationError;

    expect(err).toBeInstanceOf(ModelKeyValidationError);
    expect(err).not.toBeInstanceOf(ModelKeyAlgoMismatchError);
    expect(err.name).toBe('ModelKeyValidationError');
    expect(err.keyHex).toBe(bad);
    expect(err.algo).toBe('ecdsa');
    expect(err.model).toBe('near-cold-model');
    expect(err.endpoint).toBe(ENDPOINT);
    expect(err.message).toBe(
      'NEAR attestation: 64-byte ecdsa key is not a valid secp256k1 point (model=near-cold-model)',
    );
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('captures to Sentry ONCE per distinct key, with the raw hex in extras', async () => {
    captureSpy = jest.spyOn(logger, 'captureException');
    const bad = offCurveHex();
    serveKey(bad);

    await expect(run(fetchModelPublicKey('m'))).rejects.toBeInstanceOf(ModelKeyValidationError);
    await expect(run(fetchModelPublicKey('m'))).rejects.toBeInstanceOf(ModelKeyValidationError);

    expect(seen).toHaveLength(2);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [captured, meta] = captureSpy.mock.calls[0] as [unknown, { tags: object; extra: object }];
    expect(captured).toBeInstanceOf(ModelKeyValidationError);
    expect(meta.tags).toEqual({ service: 'e2ee', step: 'model-key-validate' });
    expect(meta.extra).toEqual({ keyHex: bad, algo: 'ecdsa', model: 'm', endpoint: ENDPOINT });
  });

  it('captures again for a different bad key', async () => {
    captureSpy = jest.spyOn(logger, 'captureException');
    serveKey(offCurveHex(), {}, { once: true });
    await expect(run(fetchModelPublicKey('m'))).rejects.toBeInstanceOf(ModelKeyValidationError);
    serveKey(offCurveHex(), {}, { once: true });
    await expect(run(fetchModelPublicKey('m'))).rejects.toBeInstanceOf(ModelKeyValidationError);
    expect(captureSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache an off-curve key: a later valid attestation succeeds', async () => {
    serveKey(offCurveHex(), {}, { once: true });

    await expect(run(fetchModelPublicKey('m'))).rejects.toBeInstanceOf(ModelKeyValidationError);
    expect(getCachedAttestation('m')).toBeNull();

    const result = await run(fetchModelPublicKey('m'));
    expect(result.publicKey).toBe(ED);
    expect(getCachedAttestation('m')).toBe(result);
  });
});

describe('fetchModelPublicKey: HTTP failures', () => {
  beforeEach(signedIn);

  it('a 403 is a NearAttestationError carrying statusCode and the body, and is not retried', async () => {
    serveText('Forbidden', 403);

    const err = await errorOf(fetchModelPublicKey(MODEL));

    expect(err).toMatchObject({
      name: 'NearAttestationError',
      statusCode: 403,
      message: 'NEAR attestation failed (403): Forbidden',
    });
    expect(seen).toHaveLength(1);
  });

  it('truncates the body in the message to 200 characters', async () => {
    serveText('x'.repeat(500), 403);
    const err = await errorOf(fetchModelPublicKey(MODEL));
    expect(err!.message).toBe(`NEAR attestation failed (403): ${'x'.repeat(200)}`);
  });

  it('retries a 5xx twice (three requests in all), then throws with the status as a field', async () => {
    serveText('Internal Server Error', 500);

    const err = await errorOf(fetchModelPublicKey(MODEL));

    expect(seen).toHaveLength(3);
    expect(err).toMatchObject({
      name: 'NearAttestationError',
      statusCode: 500,
      message: 'NEAR attestation failed (500): Internal Server Error',
    });
    expect(getCachedAttestation(MODEL)).toBeNull();
  });

  it('succeeds when a 5xx clears on the retry', async () => {
    serveText('bad gateway', 502, {}, true);

    const result = await run(fetchModelPublicKey(MODEL));

    expect(result.publicKey).toBe(ED);
    expect(seen).toHaveLength(2);
  });

  it('singleAttempt drops the retries', async () => {
    serveText('Internal Server Error', 500);

    const err = await errorOf(fetchModelPublicKey(MODEL, 'background', { singleAttempt: true }));

    expect(err).toMatchObject({ statusCode: 500 });
    expect(seen).toHaveLength(1);
  });

  it('a 5xx on the retry path is spaced by backoff (100ms, then 200ms)', async () => {
    serveText('Internal Server Error', 500);
    await errorOf(fetchModelPublicKey(MODEL));
    const gaps = [seen[1].at - seen[0].at, seen[2].at - seen[1].at];
    expect(gaps[0]).toBeGreaterThanOrEqual(100);
    expect(gaps[1]).toBeGreaterThanOrEqual(200);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
  });

  it.each([
    ['5', 5_000],
    ['120', 60_000],
    ['0', 30_000],
    ['abc', 30_000],
    [undefined, 30_000],
  ] as const)('a 429 with Retry-After %s pauses the background lane for %i ms and throws', async (header, ms) => {
    serveText('ThrottlerException', 429, header === undefined ? {} : { 'Retry-After': header }, true);

    const err = await errorOf(fetchModelPublicKey(MODEL));

    expect(err).toMatchObject({ name: 'NearAttestationError', statusCode: 429 });
    expect(err!.message).toMatch(/NEAR attestation failed \(429\)/);
    // The pause was armed a few fake milliseconds ago.
    expect(msUntilNextGrant()).toBeGreaterThan(ms - 200);
    expect(msUntilNextGrant()).toBeLessThanOrEqual(ms);
    // Chat is not frozen for the whole tail: the interactive lane honours at most its own cap.
    expect(interactiveWaitMs()).toBeLessThanOrEqual(INTERACTIVE_MAX_PAUSE_MS);
    expect(interactiveWaitMs()).toBeGreaterThan(INTERACTIVE_MAX_PAUSE_MS - 200);
  });

  it('after a 429 the next attestation request waits out the Retry-After', async () => {
    serveText('ThrottlerException', 429, { 'Retry-After': '5' }, true);

    await errorOf(fetchModelPublicKey(MODEL));
    await run(fetchModelPublicKey(MODEL));

    expect(seen).toHaveLength(2);
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(5_000);
  });

  it('a 4xx other than 429 leaves the limiter alone', async () => {
    serveText('Forbidden', 403);
    await errorOf(fetchModelPublicKey(MODEL));
    expect(msUntilNextGrant()).toBeLessThanOrEqual(1_000);
  });
});

describe('prepareE2EEContext', () => {
  beforeEach(signedIn);

  it('builds an ed25519 context: model key, a 32-byte secret, the derived client key, exact headers', async () => {
    const ctx = await run(prepareE2EEContext(MODEL));

    expect(ctx.algo).toBe('ed25519');
    expect(ctx.modelPubKeyHex).toBe(ED);
    expect(ctx.privateKey).toBeInstanceOf(Uint8Array);
    expect(ctx.privateKey).toHaveLength(32);
    expect(ctx.clientPubKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.clientPubKeyHex).toBe(bytesToHex(ed25519.getPublicKey(ctx.privateKey)));
    expect(ctx.headers).toEqual({
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': ctx.clientPubKeyHex,
      'X-Model-Pub-Key': ED,
      'X-Encryption-Version': '2',
    });
  });

  it('mints a fresh keypair on every call while the attestation comes from the cache', async () => {
    const a = await run(prepareE2EEContext(MODEL));
    const b = await run(prepareE2EEContext(MODEL));

    expect(a.clientPubKeyHex).not.toBe(b.clientPubKeyHex);
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
    expect(attestationRequests(MODEL)).toBe(1);
  });

  it('builds an ecdsa context: 65-byte client point, no version header', async () => {
    curve({ [MODEL]: 'ecdsa' });

    const ctx = await run(prepareE2EEContext(MODEL));

    expect(ctx.algo).toBe('ecdsa');
    expect(ctx.modelPubKeyHex).toBe(EC);
    expect(ctx.privateKey).toHaveLength(32);
    expect(ctx.clientPubKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(ctx.clientPubKeyHex).toBe(bytesToHex(secp256k1.getPublicKey(ctx.privateKey, false)));
    expect(ctx.headers).toEqual({
      'X-Signing-Algo': 'ecdsa',
      'X-Client-Pub-Key': ctx.clientPubKeyHex,
      'X-Model-Pub-Key': EC,
    });
    expect(Object.keys(ctx.headers)).not.toContain('X-Encryption-Version');
  });

  it.each(['ed25519', 'ecdsa'] as const)('%s: request direction, the model opens what the context seals', async (algo) => {
    curve({ [MODEL]: algo });
    const ctx = await run(prepareE2EEContext(MODEL));

    const plaintext = JSON.stringify({ q: 'generate topics', n: 42 });
    const blob = encryptContent(plaintext, ctx);

    expect(blob).toMatch(/^[0-9a-f]+$/);
    expect(decryptContent(blob, TEST_MODEL_KEYS[algo].secret, algo)).toBe(plaintext);
  });

  it.each(['ed25519', 'ecdsa'] as const)('%s: response direction, the context opens a reply sealed toward its client key', async (algo) => {
    curve({ [MODEL]: algo });
    const ctx = await run(prepareE2EEContext(MODEL));

    // The server seals toward X-Client-Pub-Key; for ecdsa that is the point without its 04 prefix.
    const clientKey = algo === 'ecdsa' ? ctx.clientPubKeyHex.slice(2) : ctx.clientPubKeyHex;
    const reply = 'The model reply, encrypted toward the client pubkey.';
    const blob = encryptContent(reply, { ...(ctx as E2EEContext), modelPubKeyHex: clientKey });

    expect(decryptContent(blob, ctx.privateKey, ctx.algo)).toBe(reply);
  });
});

describe('rebuildE2EEContext: algo/key coherence (MERA-APP-39)', () => {
  beforeEach(signedIn);

  it('rebuilds with the same client public key derived from the stored ed25519 secret', async () => {
    const secret = ed25519.utils.randomSecretKey();

    const ctx = await run(rebuildE2EEContext(MODEL, bytesToHex(secret), 'ed25519'));

    expect(ctx.algo).toBe('ed25519');
    expect(ctx.modelPubKeyHex).toBe(ED);
    expect(ctx.clientPubKeyHex).toBe(bytesToHex(ed25519.getPublicKey(secret)));
    expect(Array.from(ctx.privateKey)).toEqual(Array.from(secret));
    expect(ctx.headers).toEqual({
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': ctx.clientPubKeyHex,
      'X-Model-Pub-Key': ED,
      'X-Encryption-Version': '2',
    });
  });

  it('rebuilds an ecdsa context from the stored secp256k1 secret, without the version header', async () => {
    curve({ [MODEL]: 'ecdsa' });
    const secret = secp256k1.utils.randomSecretKey();

    const ctx = await run(rebuildE2EEContext(MODEL, bytesToHex(secret), 'ecdsa'));

    expect(ctx.algo).toBe('ecdsa');
    expect(ctx.clientPubKeyHex).toBe(bytesToHex(secp256k1.getPublicKey(secret, false)));
    expect(ctx.clientPubKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(ctx.headers).toEqual({
      'X-Signing-Algo': 'ecdsa',
      'X-Client-Pub-Key': ctx.clientPubKeyHex,
      'X-Model-Pub-Key': EC,
    });
  });

  it('is deterministic for a given stored secret: two rebuilds give the same client key', async () => {
    const hex = bytesToHex(ed25519.utils.randomSecretKey());
    const a = await run(rebuildE2EEContext(MODEL, hex, 'ed25519'));
    const b = await run(rebuildE2EEContext(MODEL, hex, 'ed25519'));
    expect(a.clientPubKeyHex).toBe(b.clientPubKeyHex);
  });

  it('throws typed when the stored algo is ed25519 but the fleet attests a 64-byte ecdsa key', async () => {
    curve({ [MODEL]: 'ecdsa' });
    const stored = bytesToHex(ed25519.utils.randomSecretKey());

    const err = (await errorOf(rebuildE2EEContext(MODEL, stored, 'ed25519'))) as ModelKeyAlgoMismatchError;

    expect(err).toBeInstanceOf(ModelKeyAlgoMismatchError);
    expect(err).toBeInstanceOf(ModelKeyValidationError);
    expect(err.name).toBe('ModelKeyAlgoMismatchError');
    expect(err.message).toBe(
      `[E2EE] rebuildE2EEContext: attested algo ecdsa != stored ed25519 (model=${MODEL}); cannot pair a ed25519 keypair with a ecdsa model key`,
    );
    expect(err.keyHex).toBe(EC);
    expect(err.algo).toBe('ed25519');
    expect(err.model).toBe(MODEL);
    expect(err.endpoint).toBe(ENDPOINT);
  });

  it('throws typed in the reverse direction too (stored ecdsa, attested ed25519)', async () => {
    const stored = bytesToHex(secp256k1.utils.randomSecretKey());

    const err = (await errorOf(rebuildE2EEContext(MODEL, stored, 'ecdsa'))) as ModelKeyAlgoMismatchError;

    expect(err).toBeInstanceOf(ModelKeyAlgoMismatchError);
    expect(err).toBeInstanceOf(ModelKeyValidationError);
    expect(err.message).toContain('attested algo ed25519 != stored ecdsa');
    expect(err.keyHex).toBe(ED);
    expect(err.algo).toBe('ecdsa');
  });

  it.each([
    [16, 'ed25519'],
    [33, 'ed25519'],
    [31, 'ecdsa'],
  ] as const)('rejects a corrupt %i-byte stored secret (%s) with a typed error', async (len, algo) => {
    curve({ [MODEL]: algo });

    const err = (await errorOf(rebuildE2EEContext(MODEL, bytesToHex(new Uint8Array(len)), algo))) as ModelKeyAlgoMismatchError;

    expect(err).toBeInstanceOf(ModelKeyAlgoMismatchError);
    expect(err.message).toBe(
      `[E2EE] rebuildE2EEContext: stored client secret is ${len} bytes, expected 32 (model=${MODEL}, algo=${algo})`,
    );
    expect(err.keyHex).toBe(TEST_MODEL_KEYS[algo].publicKeyHex);
    expect(err.algo).toBe(algo);
    expect(err.model).toBe(MODEL);
    expect(err.endpoint).toBe(ENDPOINT);
  });
});

describe('encryptMessages', () => {
  beforeEach(signedIn);

  it.each(['ed25519', 'ecdsa'] as const)('%s: encrypts every non-empty content in place; the model opens each one', async (algo) => {
    curve({ [MODEL]: algo });
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Tell me something.' },
    ];

    const ctx = await run(encryptMessages(messages, MODEL));

    expect(ctx.algo).toBe(algo);
    expect(ctx.privateKey).toHaveLength(32);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    for (const m of messages) expect(m.content).toMatch(/^[0-9a-f]+$/);
    expect(decryptContent(messages[0].content, TEST_MODEL_KEYS[algo].secret, algo)).toBe('You are helpful.');
    expect(decryptContent(messages[1].content, TEST_MODEL_KEYS[algo].secret, algo)).toBe('Tell me something.');
    expect(attestationRequests(MODEL)).toBe(1);
  });

  it('skips empty-content messages and leaves them empty', async () => {
    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
    ];

    await run(encryptMessages(messages, MODEL));

    expect(messages[0].content).toBe('');
    expect(decryptContent(messages[1].content, TEST_MODEL_KEYS.ed25519.secret)).toBe('Hello');
  });

  it('CH18 today: a non-string content is left as is', async () => {
    const messages = [{ role: 'assistant', content: null as unknown as string }];
    await run(encryptMessages(messages, MODEL));
    expect(messages[0].content).toBeNull();
  });

  it('CH18 today: extra fields are left in clear', async () => {
    const toolCalls = [{ id: 'tc1', name: 'f' }];
    const messages = [{ role: 'assistant', content: 'result', tool_calls: toolCalls }];

    await run(encryptMessages(messages, MODEL));

    expect(messages[0].tool_calls).toBe(toolCalls);
    expect(decryptContent(messages[0].content, TEST_MODEL_KEYS.ed25519.secret)).toBe('result');
  });

  // CH18: a field the envelope does not cover would travel in clear, so only {role, content: string}
  // may be sealed. Latent: every live caller sends exactly that.
  test.failing('CH18: encryptMessages refuses a non-string content or any field besides role and content', async () => {
    const cases: Record<string, object> = {
      'null content': { role: 'assistant', content: null },
      'array content': { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      'a tool_calls field': { role: 'assistant', content: 'result', tool_calls: [{ id: 'tc1' }] },
      'a name field': { role: 'user', content: 'result', name: 'someone' },
    };
    for (const [label, bad] of Object.entries(cases)) {
      const messages = [{ role: 'system', content: 'PLAIN-SYSTEM' }, bad as { role: string; content: string }];

      const err = await errorOf(encryptMessages(messages, MODEL));

      expect([label, err]).toEqual([label, expect.any(Error)]);
      // Nothing is sealed: the good message beside the bad one is still readable text.
      expect(messages[0].content).toBe('PLAIN-SYSTEM');
    }
  });

  it('an EMPTY string content stays allowed, with only role and content', async () => {
    const messages = [{ role: 'assistant', content: '' }];

    await run(encryptMessages(messages, MODEL));

    expect(messages).toEqual([{ role: 'assistant', content: '' }]);
  });

  it('returns the context whose secret opens a reply sealed toward its client key', async () => {
    const ctx = await run(encryptMessages([{ role: 'user', content: 'Secret text' }], MODEL));
    const reply = encryptContent('reply', { ...ctx, modelPubKeyHex: ctx.clientPubKeyHex });
    expect(decryptContent(reply, ctx.privateKey, ctx.algo)).toBe('reply');
  });
});

describe('on-device mode', () => {
  beforeEach(signedIn);

  it('prepareE2EEContext refuses before any request when the store says on-device', async () => {
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);

    const err = await errorOf(prepareE2EEContext(MODEL));

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(err!.name).toBe('OnDeviceModeError');
    expect(seen).toHaveLength(0);
    expect(attestationRequests()).toBe(0);
  });

  it('rebuildE2EEContext refuses before any request', async () => {
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);

    const err = await errorOf(rebuildE2EEContext(MODEL, 'ab'.repeat(32), 'ed25519'));

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(seen).toHaveLength(0);
    expect(attestationRequests()).toBe(0);
  });

  it('refuses on the persisted setting while the store still says Cloud (before hydration)', async () => {
    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.Cloud);
    await setSetting('mera_processing_mode', ProcessingMode.OnDevice);

    const err = await errorOf(prepareE2EEContext(MODEL));

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(seen).toHaveLength(0);
  });

  it('encryptMessages refuses too, leaving the messages in the clear and sending nothing', async () => {
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
    const messages = [{ role: 'user', content: 'stay local' }];

    const err = await errorOf(encryptMessages(messages, MODEL));

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(messages[0].content).toBe('stay local');
    expect(seen).toHaveLength(0);
  });

  it('cloud mode (the control) goes through', async () => {
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    await run(prepareE2EEContext(MODEL));
    expect(seen).toHaveLength(1);
  });
});

describe('no session: NoCredentialError (MERA-APP-16)', () => {
  // Deliberately no sign-in: the cookie quarantine is engaged and the mock auth has no session.
  beforeEach(() => {
    fakeClock(Date.now());
  });

  const breakerFailures = () => _getBreakerState().consecutiveFailures;

  it('fetchModelPublicKey throws it without issuing a request', async () => {
    const err = await errorOf(fetchModelPublicKey(MODEL));

    expect(err).toBeInstanceOf(NoCredentialError);
    expect(err!.name).toBe('NoCredentialError');
    expect(err!.message).toBe('NEAR attestation skipped: no session token, request not attempted');
    expect(seen).toHaveLength(0);
    expect(attestationRequests()).toBe(0);
    expect(getCachedAttestation(MODEL)).toBeNull();
  });

  it('is not dressed up as a 401: it carries no statusCode', async () => {
    const err = await errorOf(fetchModelPublicKey(MODEL));
    expect(err).not.toHaveProperty('statusCode');
    expect(err).not.toHaveProperty('response');
  });

  it('prepareE2EEContext and rebuildE2EEContext raise it as well', async () => {
    expect(await errorOf(prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8'))).toBeInstanceOf(NoCredentialError);
    expect(await errorOf(rebuildE2EEContext(MODEL, 'ab'.repeat(32), 'ed25519'))).toBeInstanceOf(NoCredentialError);
    expect(seen).toHaveLength(0);
  });

  it('spends no limiter grant: the gateway budget is untouched', async () => {
    await errorOf(fetchModelPublicKey(MODEL));
    expect(msUntilNextGrant()).toBe(0);
    expect(interactiveWaitMs()).toBe(0);
  });

  it('does NOT reach Sentry when captured the way the weekly audit captures it', async () => {
    const err = await errorOf(prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8'));

    logger.captureException(err, { tags: { service: 'topic-sanity-service', method: 'runSanityAudit' } });

    expect(sentryCapture).not.toHaveBeenCalled();
  });

  // Negative control: without it the test above would also pass if the classifier swallowed
  // everything or Sentry were silent for an unrelated reason.
  it('still reports an ordinary failure raised from the same call site', async () => {
    logger.captureException(new Error('attestation exploded'), {
      tags: { service: 'topic-sanity-service', method: 'runSanityAudit' },
    });
    expect(sentryCapture).toHaveBeenCalledTimes(1);
  });

  it('does NOT count as an auth failure: no request was ever sent', async () => {
    const before = breakerFailures();
    const err = await errorOf(prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8'));

    logger.captureException(err, { tags: { service: 'e2ee-service' } });

    expect(breakerFailures()).toBe(before);
  });
});

describe('a real 401 from the attestation route (positive control for the join above)', () => {
  beforeEach(signedIn);

  it('is classified as an auth failure by the logger: suppressed from Sentry, fed to the breaker', async () => {
    serveText('Unauthorized', 401);
    const before = _getBreakerState().consecutiveFailures;

    const err = await errorOf(fetchModelPublicKey(MODEL));
    expect(err).toMatchObject({ name: 'NearAttestationError', statusCode: 401 });

    logger.captureException(err, { tags: { service: 'e2ee-service' } });

    expect(sentryCapture).not.toHaveBeenCalled();
    expect(_getBreakerState().consecutiveFailures).toBe(before + 1);
  });
});
