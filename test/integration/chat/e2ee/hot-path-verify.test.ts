// Hot-path attestation verification (route1 P6): the key fetch verifies the TDX quote and that it
// binds the key the app encrypts to, fail-closed, before the key is cached or used. Real NEAR and
// RedPill reports (public data); the mock gateway's own test keys carry no quote and are accepted
// by the verifier test/mock-backend/gateway/crypto.ts installs, which defers every other key to the
// real one. Plus the RedPill v2 codec end to end against a v2 route on the mock.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { invalidateJwtCache } from '@/lib/auth-client';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import * as verifier from '@/lib/algorithms/attestation-verify';
import { verifyAttestation, type CheckId } from '@/lib/algorithms/attestation-verify';
import { clearAttestationCache, getCachedAttestation, invalidateCachedAttestation } from '@/lib/e2ee/e2ee-cache';
import { bytesToHex, openField } from '@/lib/e2ee/e2ee-crypto';
import {
  AttestationVerifyError,
  encryptMessages,
  fetchAttestationForVerification,
  fetchModelPublicKey,
  prepareE2EEContext,
  rebuildE2EEContext,
} from '@/lib/e2ee/e2ee-service';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import nearFixture from '@/test/fixtures/attestation-report.json';
import redpillFixture from '@/test/fixtures/attestation-redpill-report.json';
import { http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { advanceUntilDone as driveUntilDone, useStrictClock } from '@/test/helpers/clock';
import { openFromClientV2, redpillAttestationBody, sealForClientV2 } from '@/test/mock-backend/gateway/crypto';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const ROUTE = '*/api/attestation/report';
const RP_MODEL = 'qwen/qwen3.8-27b';
/** The nonce sent when the RedPill fixture was captured: from outside the response, as in the NEAR test. */
const RP_NONCE = '273c99d76634b5a496cea7c982021760477a96dde9a0e2e349e7c0befe3dae8a';
const NEAR_NONCE = '5ec0ffee'.repeat(8);
const near = nearFixture.model_attestations[0];
const run = <T,>(p: Promise<T>) => driveUntilDone(p);
const fakeClock = useStrictClock;

/** One byte of a hex key flipped: still a valid point is not required, the binding must fail. */
function tamper(hex: string): string {
  const i = hex.length - 2;
  return hex.slice(0, i) + (hex.slice(i) === '00' ? '01' : '00');
}
const statusOf = (r: ReturnType<typeof verifyAttestation>, id: CheckId) => r.checks.find(c => c.id === id)?.status;

let providers: (string | null)[] = [];
function serve(body: unknown): void {
  server.use(
    http.get(ROUTE, ({ request }) => {
      providers.push(request.headers.get('x-mera-provider'));
      return HttpResponse.json(body as Record<string, unknown>);
    }),
  );
}

beforeEach(async () => {
  resetLimiter();
  clearAttestationCache();
  invalidateJwtCache();
  resetBreaker();
  __resetOnDeviceGateForTests();
  providers = [];
  await signInFixtureAccount();
  fakeClock(Date.now());
});

describe('verifyAttestation: key binding', () => {
  it('a real NEAR ed25519 report still binds its key', () => {
    const r = verifyAttestation({ quoteHex: near.intel_quote, signingPublicKey: near.signing_public_key, signingAlgo: near.signing_algo, expectedNonce: NEAR_NONCE });
    expect(statusOf(r, 'report-data-key')).toBe('pass');
  });

  it('a real RedPill report binds its 65-byte secp256k1 key (eth address in report_data)', () => {
    const r = verifyAttestation({
      quoteHex: redpillFixture.intel_quote,
      signingPublicKey: redpillFixture.signing_public_key,
      signingAlgo: redpillFixture.signing_algo,
      expectedNonce: RP_NONCE,
    });
    for (const id of ['quote-structure', 'report-data-key', 'freshness-nonce', 'signing-algo', 'qe-report-signature', 'attestation-key-binding', 'quote-signature', 'pck-chain', 'root-ca-pin'] as CheckId[]) {
      expect([id, statusOf(r, id)]).toEqual([id, 'pass']);
    }
  });

  it('the same key in its raw 64-byte form binds too', () => {
    const r = verifyAttestation({ quoteHex: redpillFixture.intel_quote, signingPublicKey: redpillFixture.signing_public_key.slice(2) });
    expect(statusOf(r, 'report-data-key')).toBe('pass');
  });

  it('a tampered secp256k1 key fails the binding', () => {
    const r = verifyAttestation({ quoteHex: redpillFixture.intel_quote, signingPublicKey: tamper(redpillFixture.signing_public_key) });
    expect(statusOf(r, 'report-data-key')).toBe('fail');
  });

  it('a different real secp256k1 key fails the binding', () => {
    const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false));
    expect(statusOf(verifyAttestation({ quoteHex: redpillFixture.intel_quote, signingPublicKey: other }), 'report-data-key')).toBe('fail');
  });
});

describe('fetchModelPublicKey: NEAR hot path, fail-closed', () => {
  it('a real NEAR report verifies and its key is used', async () => {
    serve(nearFixture);
    const att = await run(fetchModelPublicKey('Qwen/Qwen3.6-35B-A3B-FP8'));
    expect(att).toEqual({ publicKey: near.signing_public_key, algo: 'ed25519', signingId: near.signing_address });
    expect(providers).toEqual([null]);
  });

  it('a tampered key next to a genuine quote throws AttestationVerifyError and caches nothing', async () => {
    serve({ model_attestations: [{ ...near, signing_public_key: tamper(near.signing_public_key) }] });
    const err = await run(fetchModelPublicKey('Qwen/Qwen3.6-35B-A3B-FP8')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttestationVerifyError);
    expect((err as AttestationVerifyError).failedChecks).toContain('report-data-key');
    expect(getCachedAttestation('Qwen/Qwen3.6-35B-A3B-FP8')).toBeNull();
  });

  it('verifies once per key: a refetch serving the same key does not re-run the quote check', async () => {
    serve(nearFixture);
    const spy = jest.spyOn(verifier, 'verifyAttestation');
    await run(fetchModelPublicKey('Qwen/Qwen3.6-35B-A3B-FP8'));
    invalidateCachedAttestation('Qwen/Qwen3.6-35B-A3B-FP8');
    await run(fetchModelPublicKey('Qwen/Qwen3.6-35B-A3B-FP8'));
    expect(providers).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a key served with no quote at all fails closed', async () => {
    const { intel_quote: _drop, ...noQuote } = near;
    serve({ model_attestations: [noQuote] });
    await expect(run(fetchModelPublicKey('m-noquote'))).rejects.toBeInstanceOf(AttestationVerifyError);
  });
});

describe('fetchModelPublicKey: RedPill hot path', () => {
  it('reads the keyset secp256k1 key, verifies it, and asks the gateway for RedPill', async () => {
    serve(redpillFixture);
    const att = await run(fetchModelPublicKey(RP_MODEL, 'background', {}, 'redpill'));
    expect(att.algo).toBe('ecdsa');
    expect('04' + att.publicKey).toBe(redpillFixture.attestation.workload_keyset.e2ee_public_keys[0].public_key);
    expect(providers).toEqual(['redpill']);
  });

  it('caches per provider: a NEAR fetch of the same model id is its own request', async () => {
    serve(redpillFixture);
    await run(fetchModelPublicKey(RP_MODEL, 'background', {}, 'redpill'));
    await run(fetchModelPublicKey(RP_MODEL, 'background', {}, 'redpill'));
    expect(providers).toEqual(['redpill']);
    expect(getCachedAttestation(RP_MODEL)).toBeNull();
  });

  it('a keyset key the quote does not bind fails closed', async () => {
    const ks = redpillFixture.attestation.workload_keyset;
    const forged = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false));
    serve({
      ...redpillFixture,
      attestation: {
        ...redpillFixture.attestation,
        workload_keyset: { ...ks, e2ee_public_keys: [{ ...ks.e2ee_public_keys[0], public_key: forged }, ks.e2ee_public_keys[1]] },
      },
    });
    await expect(run(fetchModelPublicKey(RP_MODEL, 'background', {}, 'redpill'))).rejects.toBeInstanceOf(AttestationVerifyError);
  });

  it('a report without E2EE v2 support is refused', async () => {
    serve({ ...redpillFixture, service_capabilities: { supported_e2ee_versions: [] } });
    await expect(run(fetchModelPublicKey(RP_MODEL, 'background', {}, 'redpill'))).rejects.toThrow(/E2EE v2/);
  });
});

describe('RedPill v2 codec against the mock gateway', () => {
  it('prepareE2EEContext builds v2 headers with a fresh nonce per context and no X-Signing-Algo', async () => {
    serve(redpillAttestationBody());
    const a = await run(prepareE2EEContext(RP_MODEL, 'interactive', {}, 'chat', 'redpill'));
    const b = await run(prepareE2EEContext(RP_MODEL, 'interactive', {}, 'chat', 'redpill'));
    expect(Object.keys(a.headers).sort()).toEqual(
      ['X-Client-Pub-Key', 'X-E2EE-Nonce', 'X-E2EE-Timestamp', 'X-E2EE-Version', 'X-Mera-Provider', 'X-Model-Pub-Key'],
    );
    expect(a.headers).toMatchObject({ 'X-E2EE-Version': '2', 'X-Mera-Provider': 'redpill', 'X-Model-Pub-Key': '04' + TEST_MODEL_KEYS.ecdsa.publicKeyHex });
    expect(a.v2?.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.v2?.nonce).not.toBe(b.v2?.nonce);
    expect(a.v2?.model).toBe(RP_MODEL);
  });

  it('an encrypted turn round-trips: the mock opens every message, the app opens the reply', async () => {
    serve(redpillAttestationBody());
    server.use(
      http.post('*/v1/redpill-test/chat', async ({ request }) => {
        const h = request.headers;
        const body = (await request.json()) as { model: string; messages: { content: string }[] };
        const p = { model: body.model, nonce: h.get('x-e2ee-nonce') ?? '', ts: Number(h.get('x-e2ee-timestamp')) };
        const opened = body.messages.map((m, i) => openFromClientV2(m.content, p, `messages.${i}.content`));
        const id = 'req_mock';
        const content = sealForClientV2(`echo:${opened.join('|')}`, h.get('x-client-pub-key') ?? '', p, 'choices.0.message.content', id);
        return HttpResponse.json({ id, choices: [{ index: 0, message: { role: 'assistant', content } }] });
      }),
    );
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const ctx = await run(encryptMessages(messages, RP_MODEL, 'interactive', 'chat', 'redpill'));
    const res = await fetch('http://127.0.0.1:8790/v1/redpill-test/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ctx.headers },
      body: JSON.stringify({ model: RP_MODEL, messages }),
    });
    const json = (await res.json()) as { id: string; choices: { message: { content: string } }[] };
    expect(openField(json.choices[0].message.content, ctx, 'choices.0.message.content', json.id)).toBe('echo:sys|hi');
  });

  it('rebuildE2EEContext keeps the stored client key and mints a fresh nonce', async () => {
    serve(redpillAttestationBody());
    const secret = secp256k1.utils.randomSecretKey();
    const ctx = await run(rebuildE2EEContext(RP_MODEL, bytesToHex(secret), 'ecdsa', 'background', {}, 'redpill'));
    expect(ctx.clientPubKeyHex).toBe(bytesToHex(secp256k1.getPublicKey(secret, false)));
    expect(ctx.headers['X-Client-Pub-Key']).toBe(ctx.clientPubKeyHex);
    expect(ctx.v2?.nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fetchAttestationForVerification: RedPill', () => {
  it('maps the report onto the verify row shape, and it verifies with the nonce that was sent', async () => {
    serve(redpillFixture);
    const { attestation } = await run(fetchAttestationForVerification(RP_MODEL, RP_NONCE, 'redpill'));
    const r = verifyAttestation({
      quoteHex: attestation.intel_quote ?? '',
      signingPublicKey: attestation.signing_public_key ?? '',
      signingAlgo: attestation.signing_algo,
      expectedNonce: RP_NONCE,
    });
    expect(statusOf(r, 'report-data-key')).toBe('pass');
    expect(statusOf(r, 'freshness-nonce')).toBe('pass');
    expect(providers).toEqual(['redpill']);
  });
});
