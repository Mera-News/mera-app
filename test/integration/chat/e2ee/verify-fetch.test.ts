// The Settings "Verify attestation" path: fetchAttestationForVerification (nonce'd, uncached) and the
// verifier over the report the gateway mock serves. Mirrors AttestationVerificationRow.run().
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { verifyAttestation, type VerificationReport } from '@/lib/algorithms/attestation-verify';
import { clearAttestationCache, getCachedAttestation, setCachedAttestation } from '@/lib/e2ee/e2ee-cache';
import {
  fetchAttestationForVerification,
  generateAttestationNonce,
  NoCredentialError,
  type ModelAttestation,
} from '@/lib/e2ee/e2ee-service';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { attestationRequests, http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { driveUntilDone, useStrictClock } from '@/test/integration/chat/_helpers';
import capturedReport from '@/test/fixtures/attestation-report.json';

const ROUTE = '*/api/attestation/report';
const MODEL = 'some/model';
const NONCE = 'a1'.repeat(32);
const captured = capturedReport.model_attestations[0];

/** The nonce the client sent when the fixture was captured (see attestation-verify.test.ts). */
const CAPTURE_NONCE = '5ec0ffee'.repeat(8);
/** Inside the fixture's certificate validity windows. */
const NOW = new Date('2026-08-08T00:00:00Z');

interface Seen {
  model: string | null;
  algo: string | null;
  nonce: string | null;
  authorization: string | null;
  rawUrl: string;
  at: number;
}
let seen: Seen[] = [];

const run = <T,>(p: Promise<T>) => driveUntilDone(p);
const errorOf = (p: Promise<unknown>) =>
  driveUntilDone(p).then(
    () => null,
    (e: Error) => e,
  );

beforeEach(() => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  seen = [];
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
});

afterEach(() => {
  server.events.removeAllListeners();
});

// Aliased: a function named use* trips react-hooks/rules-of-hooks wherever it is called.
const fakeClock = useStrictClock;

async function signedIn(): Promise<void> {
  await signInFixtureAccount();
  fakeClock(Date.now());
}

describe('fetchAttestationForVerification', () => {
  beforeEach(signedIn);

  it('sends the client nonce, the model and signing_algo in the query, and a bearer token', async () => {
    // The nonce is the whole freshness mechanism: NEAR echoes it into the quote's report_data.
    const { attestation, nonce } = await run(fetchAttestationForVerification(MODEL, NONCE));

    const token = await run(getJwtToken());
    expect(seen).toHaveLength(1);
    expect(seen[0].nonce).toBe(NONCE);
    expect(seen[0].model).toBe(MODEL);
    expect(seen[0].algo).toBe('ed25519');
    expect(seen[0].rawUrl).toContain(`nonce=${NONCE}`);
    expect(seen[0].rawUrl).toContain('model=some%2Fmodel');
    expect(seen[0].authorization).toBe(`Bearer ${token}`);
    expect(nonce).toBe(NONCE);
    expect(attestation).toEqual(captured);
    expect(attestation.signing_public_key).toBe(captured.signing_public_key);
  });

  it('bypasses the attestation cache: two calls, two requests on the nonce route', async () => {
    await run(fetchAttestationForVerification(MODEL, NONCE));
    await run(fetchAttestationForVerification(MODEL, NONCE));

    expect(seen).toHaveLength(2);
    // The mock counts the no-nonce (hot path) route only.
    expect(attestationRequests()).toBe(0);
  });

  it('neither reads nor writes the 30-minute hot-path cache', async () => {
    const hot: ModelAttestation = { publicKey: 'ab'.repeat(32), algo: 'ed25519' };
    setCachedAttestation(MODEL, hot);

    await run(fetchAttestationForVerification(MODEL, NONCE));

    expect(seen).toHaveLength(1);
    expect(getCachedAttestation(MODEL)).toBe(hot);

    clearAttestationCache();
    await run(fetchAttestationForVerification(MODEL, NONCE));
    expect(getCachedAttestation(MODEL)).toBeNull();
  });

  it('takes a limiter grant: back-to-back verifies are at least a second apart', async () => {
    await run(fetchAttestationForVerification(MODEL, NONCE));
    await run(fetchAttestationForVerification(MODEL, NONCE));
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(1_000);
  });

  it('throws NearAttestationError carrying the status on a non-ok response, without retrying', async () => {
    server.use(http.get(ROUTE, () => new HttpResponse('upstream down', { status: 503 })));

    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));

    expect(err).toMatchObject({
      name: 'NearAttestationError',
      statusCode: 503,
      message: 'NEAR attestation failed (503): upstream down',
    });
    expect(seen).toHaveLength(1);
  });

  it('throws when model_attestations is missing', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json({ gateway_attestation: {} })));
    await expect(run(fetchAttestationForVerification(MODEL, NONCE))).rejects.toThrow(
      'NEAR attestation: model_attestations missing. top=gateway_attestation',
    );
  });

  it('throws when model_attestations is present but empty', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json({ model_attestations: [] })));
    await expect(run(fetchAttestationForVerification(MODEL, NONCE))).rejects.toThrow(/model_attestations missing/);
  });
});

describe('fetchAttestationForVerification: no session', () => {
  beforeEach(() => {
    fakeClock(Date.now());
  });

  it('throws NoCredentialError without issuing a request', async () => {
    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));

    expect(err).toBeInstanceOf(NoCredentialError);
    expect(err!.name).toBe('NoCredentialError');
    expect(seen).toHaveLength(0);
  });

  // The verify tap's catch maps any throw to its own error state, so the type is what tells it apart.
  it('does not dress the missing credential up as a 401', async () => {
    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));
    expect(err).not.toHaveProperty('statusCode');
  });
});

describe('generateAttestationNonce', () => {
  it('is 32 random bytes as lower-case hex', () => {
    expect(generateAttestationNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs on every call: a constant nonce would defeat the freshness check', () => {
    expect(generateAttestationNonce()).not.toBe(generateAttestationNonce());
  });
});

describe('verifyAttestation over the served report (what the Settings row does)', () => {
  beforeEach(signedIn);

  async function verifyWith(nonce: string): Promise<VerificationReport> {
    const { attestation } = await run(fetchAttestationForVerification('Qwen/Qwen3.8-27B', nonce));
    return verifyAttestation({
      quoteHex: attestation.intel_quote ?? '',
      signingPublicKey: attestation.signing_public_key ?? '',
      signingAlgo: attestation.signing_algo,
      expectedNonce: nonce,
      hasGpuPayload: Boolean(attestation.nvidia_payload),
      now: NOW,
    });
  }
  const status = (r: VerificationReport, id: string) => r.checks.find((c) => c.id === id)?.status;

  it('with the nonce the report was captured under it never throws and is incomplete, not verified', async () => {
    const report = await verifyWith(CAPTURE_NONCE);

    expect(report.verdict).toBe('incomplete');
    expect(report.verdict).not.toBe('verified');
    // The honest gaps: both need collateral the app does not fetch.
    expect(status(report, 'tcb-status')).toBe('not-checked');
    expect(status(report, 'gpu-attestation')).toBe('not-checked');
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('with the app\'s fresh random nonce the replayed report FAILS freshness and the verdict is failed', async () => {
    const report = await verifyWith(generateAttestationNonce());

    expect(status(report, 'freshness-nonce')).toBe('fail');
    expect(report.verdict).toBe('failed');
    expect(status(report, 'tcb-status')).toBe('not-checked');
    expect(status(report, 'gpu-attestation')).toBe('not-checked');
  });
});
