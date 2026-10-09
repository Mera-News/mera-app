// cloudChatStream's failure handling: the decrypt-failure re-attest, the stream-death retry, the
// shared latch between them, the 502 budget and the first-chunk idle window. Real stack against the
// gateway mock; the faults the responder cannot express are raw wire overrides (see support.ts).
// Cases the harness test already holds, by name:
//   harness/gateway.test.ts > chat: faults > "400 Decryption failed once: the client re-attests and recovers"
//   harness/gateway.test.ts > chat: faults > "the stream closes after one chunk: text arrived, so the error surfaces"
//   harness/gateway.test.ts > chat: faults > "502 surfaces as E2EE chat failed with the body on responseBody only"
//   harness/gateway.test.ts > chat: faults > "429 with Retry-After 1s ..." and "... a long Retry-After is not waited out"
//   harness/gateway.test.ts > chat: fake clock > a gap above / just under STREAM_IDLE_TIMEOUT_MS after the first chunk
import { invalidateJwtCache } from '@/lib/auth-client';
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, STREAM_IDLE_TIMEOUT_MS, UPSTREAM_ALIGNED_TIMEOUT_MS } from '@/lib/llm/cloudComplete';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import {
  attestationRequests,
  gatewayCalls,
  mockGateway,
  resetAuthState,
  server,
  useFakeClock,
} from '@/test/helpers';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';
import {
  abortError,
  advanceUntil,
  captureChatBodies,
  collect,
  delta,
  DONE,
  drive,
  installChatHooks,
  loggerSpies,
  MESSAGES,
  rawChat,
  respond,
  textOf,
} from './support';

installChatHooks();

const FALLBACK = MODEL_FALLBACKS[SMALL_MODEL];
const DECRYPT_400 = { status: 400, body: { error: `Provider failed for model '${SMALL_MODEL}': Decryption failed` } };
const run = () => collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error & { statusCode?: number; responseBody?: string }) => e);

describe('decrypt-failure re-attest', () => {
  it('invalidates that model\'s attestation, rebuilds the envelope with a fresh keypair, and never engages the fallback', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway((c) => (c.index === 0 ? DECRYPT_400 : 'recovered')));
    const events = await run();

    expect(textOf(events)).toBe('recovered');
    const [first, second] = gatewayCalls('chat');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(attestationRequests(SMALL_MODEL)).toBe(2);
    // A fresh client keypair: replaying the refused body would have sent the same one.
    expect(second.headers['x-client-pub-key']).not.toBe(first.headers['x-client-pub-key']);
    expect(second.model).toBe(SMALL_MODEL);
    // A 4xx is not model evidence.
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).not.toContain('SENTINEL');
  });

  it('a second decrypt failure surfaces as E2EE chat failed with the body on a field, and there is no third request', async () => {
    server.use(...mockGateway(respond(DECRYPT_400)));
    const err = await fail(run());

    expect(err?.message).toBe('E2EE chat failed: 400');
    expect(err).toMatchObject({ statusCode: 400 });
    expect(err?.responseBody).toContain('Decryption failed');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('records the curve and a model-key prefix on the breadcrumb of the refused request', async () => {
    server.use(...mockGateway(respond(DECRYPT_400)));
    await fail(run());
    // The datum MERA-APP-72 could not be triaged without: which curve built the envelope upstream refused.
    expect(loggerSpies().addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('cloudChatStream HTTP error'),
      'cloud-chat',
      expect.objectContaining({
        status: 400,
        algo: 'ed25519',
        modelKeyFp: TEST_MODEL_KEYS.ed25519.publicKeyHex.slice(0, 8),
      }),
      'error',
    );
  });

  it('leaves a 400 that is not a decrypt verdict alone: no re-attest, no second request', async () => {
    server.use(...mockGateway(respond({ status: 400, body: 'Bad request' })));
    const err = await fail(run());

    expect(err?.message).toBe('E2EE chat failed: 400');
    expect(err).toMatchObject({ statusCode: 400, responseBody: 'Bad request' });
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(attestationRequests(SMALL_MODEL)).toBe(1);
  });

  it('keeps the provider\'s body out of the thrown message, breadcrumbs the failure and does not capture it', async () => {
    const body = { error: { message: "Provider failed for model 'm': boom" } };
    server.use(...mockGateway(respond({ status: 400, body })));
    const err = await fail(run());

    expect(err?.message).toBe('E2EE chat failed: 400');
    expect(err?.message).not.toContain('Provider failed');
    expect(err?.responseBody).toContain('boom');
    const { addBreadcrumb, captureException, captureMessage } = loggerSpies();
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('cloudChatStream HTTP error'),
      'cloud-chat',
      expect.objectContaining({ status: 400 }),
      'error',
    );
    // One failure, one Sentry issue: the caller reports it, this site must not.
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('a signed-out device', () => {
  it('fails before any request: no attestation fetch, no chat call', async () => {
    resetAuthState();
    invalidateJwtCache();
    const err = await fail(run());
    expect(err).not.toBeNull();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
  });
});

describe('a 502 from the gateway', () => {
  it('spends the primary budget (2), then ONE attempt on the session fallback, and surfaces the original 502', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    server.use(...mockGateway(respond({ status: 502, body: { error: 'upstream gone' } })));
    const outcome = fail(run());
    await drive(outcome);
    const err = await outcome;

    expect(err?.message).toBe('E2EE chat failed: 502');
    expect(err?.responseBody).toContain('upstream gone');
    // Not an 11-attempt storm: 3 requests, the last on the fallback.
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('the stream dies', () => {
  it('before any text: ONE fresh request on the same model, and a non-timeout death engages nothing', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['never seen'], closeAfter: 0 } : 'second try')));
    const events = await run();

    expect(events).toEqual([
      { type: 'text-delta', delta: 'second try' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('before any text, as a cancelled body (timeout-class): the retry goes to the session fallback', async () => {
    const { handler, requests } = rawChat(() => [{ fail: abortError() }], { once: true });
    server.use(handler, ...mockGateway(respond('second try')));
    const events = await run();

    expect(textOf(events)).toBe('second try');
    expect(requests()).toBe(1);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([FALLBACK]);
    expect(loggerSpies().captureMessage).toHaveBeenCalledWith(
      'NEAR primary model failing — session fallback engaged',
      expect.objectContaining({ fingerprint: ['near-model-fallback', 'timeout', SMALL_MODEL] }),
    );
  });

  it('a corrupt chunk (decrypt failure) before any text retries on the PRIMARY and never engages the fallback', async () => {
    const { handler, requests } = rawChat(() => [delta({ content: 'zz-not-an-envelope' }, 'stop'), DONE], { once: true });
    server.use(handler, ...mockGateway(respond('clean')));
    const events = await run();

    expect(events).toEqual([
      { type: 'text-delta', delta: 'clean' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(requests()).toBe(1);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });

  it('after text, even as a cancelled body: the error surfaces, nothing is re-sent, nothing engages', async () => {
    const { handler, requests } = rawChat((seal) => [delta({ content: seal('half an answer') }), { fail: abortError() }]);
    server.use(handler);
    const seen: string[] = [];
    const err = await fail(
      (async () => {
        for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })) {
          if (e.type === 'text-delta') seen.push(e.delta);
        }
      })(),
    );

    expect(err?.message).toMatch(/cancel/);
    expect(seen).toEqual(['half an answer']);
    expect(requests()).toBe(1);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });
});

describe('the two retries share one latch', () => {
  it('a re-attested request that then dies mid-stream does NOT issue a third call', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? DECRYPT_400 : { chunks: ['never seen'], closeAfter: 0 })),
    );
    const err = await fail(run());

    expect(err).not.toBeNull();
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(attestationRequests(SMALL_MODEL)).toBe(2);
  });

  it('and neither does a stream-death retry that is then refused: one turn is at most two upstream calls', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? { chunks: ['never seen'], closeAfter: 0 } : DECRYPT_400)),
    );
    const err = await fail(run());

    // The retry's 400 is surfaced as is: the decrypt re-attest has no latch left to spend.
    expect(err?.message).toBe('E2EE chat failed: 400');
    expect(gatewayCalls('chat')).toHaveLength(2);
  });
});

describe('the first chunk gets the full upstream budget', () => {
  it('a silent open stream is waited out for UPSTREAM_ALIGNED_TIMEOUT_MS, not the 30s idle window, then retried once', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['never'], stallAfter: 0 } : 'recovered')));
    const outcome = run();
    const settled = outcome.then(
      (e) => e,
      (e: Error) => e,
    );
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    const openedAt = Date.now();

    await advanceUntil(() => Date.now() - openedAt >= STREAM_IDLE_TIMEOUT_MS + 1000);
    expect(gatewayCalls('chat')[0].aborted).toBe(false);

    await advanceUntil(() => gatewayCalls('chat')[0].aborted, 2 * UPSTREAM_ALIGNED_TIMEOUT_MS);
    const waited = Date.now() - openedAt;
    expect(waited).toBeGreaterThanOrEqual(UPSTREAM_ALIGNED_TIMEOUT_MS - 1000);
    expect(waited).toBeLessThan(UPSTREAM_ALIGNED_TIMEOUT_MS + 5000);

    await drive(settled);
    const events = await settled;
    expect(textOf(events as never)).toBe('recovered');
    expect(gatewayCalls('chat')).toHaveLength(2);
  });
});

describe('the idle window after the first chunk', () => {
  beforeEach(() => useFakeClock('2026-10-09T00:00:00Z'));

  it('a first chunk with no text, then 30s of silence, ends the stream and retries once', async () => {
    // reasoning:true puts one chunk on the wire (no visible text), stallAfter:0 then goes silent.
    server.use(
      ...mockGateway((c) => (c.index === 0 ? { chunks: ['never'], reasoning: true, stallAfter: 0 } : 'recovered')),
    );
    const settled = run();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    const openedAt = Date.now();
    await advanceUntil(() => gatewayCalls('chat')[0].aborted, 2 * UPSTREAM_ALIGNED_TIMEOUT_MS);
    const waited = Date.now() - openedAt;
    // The tightened window, not the 130s first-chunk budget.
    expect(waited).toBeGreaterThanOrEqual(STREAM_IDLE_TIMEOUT_MS - 2000);
    expect(waited).toBeLessThan(STREAM_IDLE_TIMEOUT_MS + 3000);

    const events = await drive(settled);
    expect(textOf(events)).toBe('recovered');
    expect(gatewayCalls('chat')).toHaveLength(2);
  });
});

// IDLE1 (candidate, found writing this file): the catch in cloudChatStream says an idle stall is
// model evidence ("Only an abort-class death (idle stall, cancelled body)"), and the old mocked test
// asserted the retry goes to the fallback. But a cancelled reader ends its loop CLEANLY (the comment in
// consumeSseChat says so), so the death that surfaces is `chat stream went idle`, which isAbortLike
// does not match: reportModelFailure never runs, and a model that stalls open with no first chunk
// is retried on the same dead primary every turn. Whether Hermes' fetch ends the body cleanly or
// rejects with AbortError on cancel is unverified; the wire here ends it cleanly.
describe('IDLE1: a stall before the first chunk', () => {
  beforeEach(() => useFakeClock('2026-10-09T00:00:00Z'));

  async function stallThenRecover() {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['never'], stallAfter: 0 } : 'recovered')));
    const settled = run();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    await advanceUntil(() => gatewayCalls('chat')[0].aborted, 2 * UPSTREAM_ALIGNED_TIMEOUT_MS);
    const events = await drive(settled);
    expect(textOf(events)).toBe('recovered');
    expect(gatewayCalls('chat')).toHaveLength(2);
  }

  it('retries on the same primary and engages nothing (today)', async () => {
    await stallThenRecover();
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  test.failing('is timeout-class evidence: the retry goes to the session fallback', async () => {
    await stallThenRecover();
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, FALLBACK]);
  });
});
