// The session model fallback: the module's own contract (real network store, real logger watched
// through a spy) and the way cloudComplete / cloudBatchComplete drive it against the gateway mock.
// A stalled primary is a reply held past a short per-attempt timeout, or a gateway 502.
import { BIG_MODEL, MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudBatchComplete, cloudComplete } from '@/lib/llm/cloudComplete';
import {
  __resetForTests,
  fallbackFor,
  isFallbackEngaged,
  reportModelFailure,
  reportModelSlow,
  reportModelSuccess,
  resolveModel,
} from '@/lib/llm/model-fallback';
import logger from '@/lib/logger';
import { useNetworkStore } from '@/lib/stores/network-store';
import {
  attestationRequests,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
  type GatewayResponder,
} from '@/test/helpers';
import {
  CHAT_PATH,
  errorOf,
  failChatNetworkAlways,
  fakeClock,
  resetTransport,
  respond,
  run,
  serveJson,
  watchRequests,
} from './transport-kit';

const UNKNOWN_MODEL = 'some/model-with-no-fallback';
const FALLBACK_MODEL = MODEL_FALLBACKS[SMALL_MODEL];
const SECRET_SYSTEM = 'SENTINEL-SYSTEM-d41e you are the test model';
const SECRET_USER = 'SENTINEL-USER-62aa what is the news';
const REQUEST = { systemPrompt: SECRET_SYSTEM, prompt: SECRET_USER };
/** A short per-attempt timeout, so "the primary stalled" costs a stall of seconds, not 130. */
const TIMEOUT = { requestTimeoutMs: 100 };
const STALL = { chunks: ['late'], headerDelayMs: 10_000 };

let captured: jest.SpyInstance;
let breadcrumb: jest.SpyInstance;

beforeEach(async () => {
  await resetTransport({ signIn: false });
  useNetworkStore.getState().setIsConnected(true);
  captured = jest.spyOn(logger, 'captureMessage').mockImplementation(() => '');
  breadcrumb = jest.spyOn(logger, 'addBreadcrumb').mockImplementation(() => {});
});

afterEach(() => {
  server.events.removeAllListeners();
  captured.mockRestore();
  breadcrumb.mockRestore();
  useNetworkStore.getState().setIsConnected(true);
  __resetForTests();
});

describe('MODEL_FALLBACKS wiring', () => {
  it('maps each primary to its class-appropriate TEE-served fallback', () => {
    // The two primaries fall back to EACH OTHER: both are self-hosted tier, both attest, and BIG's
    // needs tools, which Qwen3.6 has. Rationale and the measured figures live in constants.ts.
    expect(MODEL_FALLBACKS[BIG_MODEL]).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    expect(MODEL_FALLBACKS[SMALL_MODEL]).toBe('Qwen/Qwen3.8-27B');
  });

  it('the two primaries fall back to each other, so no fallback is unwarmed', () => {
    // prewarmCloudChat attests BIG and SMALL only; with the swap every fallback is also a primary,
    // so it is attested every cold start and cannot rot unnoticed.
    expect(MODEL_FALLBACKS[BIG_MODEL]).toBe(SMALL_MODEL);
    expect(MODEL_FALLBACKS[SMALL_MODEL]).toBe(BIG_MODEL);
  });

  it('never falls back to a model that is its own primary', () => {
    for (const [primary, fallback] of Object.entries(MODEL_FALLBACKS)) {
      expect(fallback).not.toBe(primary);
    }
  });
});

describe('resolveModel', () => {
  it('returns the model unchanged before any failure', () => {
    expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
    expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
  });

  it('returns the fallback once engaged', () => {
    reportModelFailure(SMALL_MODEL);
    expect(resolveModel(SMALL_MODEL)).toBe(FALLBACK_MODEL);
  });

  it('engagement is per-model: other primaries are untouched', () => {
    reportModelFailure(SMALL_MODEL);
    expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
  });

  it('leaves a model with no configured fallback alone', () => {
    reportModelFailure(UNKNOWN_MODEL);
    expect(resolveModel(UNKNOWN_MODEL)).toBe(UNKNOWN_MODEL);
    expect(isFallbackEngaged(UNKNOWN_MODEL)).toBe(false);
  });
});

describe('reportModelFailure', () => {
  it('engages the fallback', () => {
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    reportModelFailure(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });

  it('reports exactly once per model per session', () => {
    reportModelFailure(SMALL_MODEL);
    reportModelFailure(SMALL_MODEL);
    reportModelFailure(SMALL_MODEL);

    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith('NEAR primary model failing — session fallback engaged', {
      level: 'error',
      tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL },
      fingerprint: ['near-model-fallback', 'timeout', SMALL_MODEL],
    });
  });

  it('reports separately for a second primary', () => {
    reportModelFailure(SMALL_MODEL);
    reportModelFailure(BIG_MODEL);
    expect(captured).toHaveBeenCalledTimes(2);
  });

  it('never reports for a model with no configured fallback', () => {
    reportModelFailure(UNKNOWN_MODEL);
    expect(captured).not.toHaveBeenCalled();
  });
});

describe('fallbackFor', () => {
  it('maps a configured primary to its fallback', () => {
    expect(fallbackFor(SMALL_MODEL)).toBe(FALLBACK_MODEL);
    expect(fallbackFor(BIG_MODEL)).toBe(MODEL_FALLBACKS[BIG_MODEL]);
  });

  it('returns null for a model with no configured fallback', () => {
    expect(fallbackFor(UNKNOWN_MODEL)).toBeNull();
  });

  it('is unaffected by engagement (it reports config, not state)', () => {
    reportModelFailure(SMALL_MODEL);
    expect(fallbackFor(SMALL_MODEL)).toBe(FALLBACK_MODEL);
  });
});

describe('reportModelSlow', () => {
  it('engages the fallback, like a timeout does', () => {
    reportModelSlow(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(resolveModel(SMALL_MODEL)).toBe(FALLBACK_MODEL);
  });

  it('reports at WARNING with its own message: a slow primary is not a dead one', () => {
    reportModelSlow(SMALL_MODEL);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith('NEAR primary model slow — hedged fallback won, session fallback engaged', {
      level: 'warning',
      tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL },
      fingerprint: ['near-model-fallback', 'hedge', SMALL_MODEL],
    });
  });

  // Without an EXPLICIT fingerprint Sentry groups a message on the synthetic stacktrace it
  // attaches, and this one is emitted from an async hedge continuation: one string filed as three
  // issues titled after arbitrary frames.
  it('passes a stable fingerprint that does not depend on the call stack', () => {
    reportModelSlow(SMALL_MODEL);
    const first = captured.mock.calls[0][1].fingerprint;

    __resetForTests();
    captured.mockClear();
    reportModelSlow(SMALL_MODEL);
    const second = captured.mock.calls[0][1].fingerprint;

    expect(first).toEqual(second);
    expect(first).toEqual(['near-model-fallback', 'hedge', SMALL_MODEL]);
  });

  it('fingerprints a different primary as a different incident', () => {
    reportModelSlow(SMALL_MODEL);
    const small = captured.mock.calls[0][1].fingerprint;

    __resetForTests();
    captured.mockClear();
    reportModelSlow(BIG_MODEL);
    const big = captured.mock.calls[0][1].fingerprint;

    expect(small).not.toEqual(big);
  });

  it('fingerprints a timeout differently from a hedge win', () => {
    reportModelFailure(SMALL_MODEL);
    expect(captured.mock.calls[0][1].fingerprint).toEqual(['near-model-fallback', 'timeout', SMALL_MODEL]);
  });

  it('never engages or reports for a model with no configured fallback', () => {
    reportModelSlow(UNKNOWN_MODEL);
    expect(isFallbackEngaged(UNKNOWN_MODEL)).toBe(false);
    expect(captured).not.toHaveBeenCalled();
  });

  it('dedupes with reportModelFailure: slow then failure is ONE event', () => {
    reportModelSlow(SMALL_MODEL);
    reportModelFailure(SMALL_MODEL);
    reportModelSlow(SMALL_MODEL);

    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][1].level).toBe('warning');
  });

  it('dedupes with reportModelFailure: failure then slow is ONE event', () => {
    reportModelFailure(SMALL_MODEL);
    reportModelSlow(SMALL_MODEL);

    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][1].level).toBe('error');
  });
});

describe('reportModelSuccess', () => {
  it('never engages anything', () => {
    reportModelSuccess(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
    expect(captured).not.toHaveBeenCalled();
  });

  it('does NOT un-engage an engaged fallback: the session keeps it', () => {
    reportModelFailure(SMALL_MODEL);
    reportModelSuccess(SMALL_MODEL);
    reportModelSuccess(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(resolveModel(SMALL_MODEL)).toBe(FALLBACK_MODEL);
  });
});

describe('a fresh process always retries the primary', () => {
  it('holds engagement in module memory only: nothing is persisted', () => {
    // "Once the app restarts, always use the primary model first again." A regression here would be
    // someone adding storage or hydration; a fresh module registry stands in for the relaunch.
    reportModelFailure(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);

    let fresh!: typeof import('@/lib/llm/model-fallback');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fresh = require('@/lib/llm/model-fallback');
    });

    expect(fresh.isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(fresh.resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
  });
});

describe('__resetForTests', () => {
  it('isolates sessions: engagement and the once-per-session report both reset', () => {
    reportModelFailure(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);

    __resetForTests();

    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
    reportModelFailure(SMALL_MODEL);
    // A reset simulates a fresh app launch, which is how the primary gets retried in production.
    expect(captured).toHaveBeenCalledTimes(2);
  });

  it('clears a hedge engagement too (both causes share one guard set)', () => {
    reportModelSlow(SMALL_MODEL);
    __resetForTests();
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(resolveModel(SMALL_MODEL)).toBe(SMALL_MODEL);
  });
});

// MERA-APP-6Y. Only timeout-class failures reach reportModelFailure, but an offline device on a
// stalled socket produces a timeout too, so a backgrounded phone with no link concluded the NEAR
// primary was down and demoted the whole session. Engagement is sticky, so one tunnel cost every
// later call.
describe('reportModelFailure connectivity gate', () => {
  it('does not engage the fallback while the device is offline', () => {
    useNetworkStore.getState().setIsConnected(false);

    reportModelFailure(BIG_MODEL);

    expect(isFallbackEngaged(BIG_MODEL)).toBe(false);
    expect(resolveModel(BIG_MODEL)).toBe(BIG_MODEL);
    expect(captured).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('device offline'),
      'model-fallback',
      expect.objectContaining({ model: BIG_MODEL }),
      'info',
    );
  });

  it('still engages once the device is back online', () => {
    useNetworkStore.getState().setIsConnected(false);
    reportModelFailure(BIG_MODEL);
    expect(isFallbackEngaged(BIG_MODEL)).toBe(false);

    useNetworkStore.getState().setIsConnected(true);
    reportModelFailure(BIG_MODEL);

    expect(isFallbackEngaged(BIG_MODEL)).toBe(true);
    expect(resolveModel(BIG_MODEL)).toBe(MODEL_FALLBACKS[BIG_MODEL]);
  });

  // isConnected is seeded optimistically true, so an unknown connectivity state must still report.
  it('engages when connectivity is unknown-but-optimistic', () => {
    reportModelFailure(SMALL_MODEL);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('through cloudComplete and cloudBatchComplete', () => {
  const stalled = new Set<string>();
  const script: GatewayResponder = (c) => (stalled.has(c.model) ? STALL : 'recovered');
  const bodiesOf = () => gatewayCalls('chat').map((c) => c.model);

  beforeEach(async () => {
    stalled.clear();
    stalled.add(SMALL_MODEL);
    server.use(...mockGateway(script));
    await signInFixtureAccount();
    fakeClock();
  });

  it('exhausted timeout attempts engage the fallback and retry the SAME call once', async () => {
    const chat = watchRequests(CHAT_PATH);

    const result = await run(cloudComplete(REQUEST, TIMEOUT));

    expect(result).toBe('recovered');
    expect(bodiesOf()).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect((await chat.raw()).join('')).not.toContain('SENTINEL');
  });

  it('encrypts the retry under the RESOLVED fallback model, from fresh plaintext (never double-encrypted)', async () => {
    await run(cloudComplete(REQUEST, TIMEOUT));

    // The mock opens each request with the key it served for that model, so a retry sealed for the
    // wrong key or sealed twice would never decrypt back to the prompt.
    expect(attestationRequests(FALLBACK_MODEL)).toBe(1);
    expect(gatewayCalls('chat')[2].messages).toEqual([
      { role: 'system', content: SECRET_SYSTEM },
      { role: 'user', content: SECRET_USER },
    ]);
  });

  it('a gateway 502 (its own upstream-timeout verdict) engages the fallback too', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? { status: 502 } : 'ok')));

    const result = await run(cloudComplete(REQUEST));

    expect(result).toBe('ok');
    expect(bodiesOf()).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });

  it('substitutes the fallback on SUBSEQUENT calls, batch included', async () => {
    await run(cloudComplete(REQUEST, TIMEOUT));

    await run(cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }]));

    expect(gatewayCalls('batch').map((c) => c.model)).toEqual([FALLBACK_MODEL]);
  });

  it('batch: rebuilds the E2EE context for the fallback attempt', async () => {
    const result = await run(
      cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }], SMALL_MODEL, TIMEOUT),
    );

    expect(result).toEqual([{ id: 'c1', output: 'recovered' }]);
    expect(gatewayCalls('batch').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK_MODEL]);
    expect(attestationRequests(FALLBACK_MODEL)).toBe(1);
  });

  it('does NOT engage on a plain network error', async () => {
    failChatNetworkAlways();
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST, { maxTimeoutAttempts: 1 })));

    expect(err).toBeInstanceOf(Error);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(chat.count()).toBe(1);
  });

  it('does NOT engage on a 4xx', async () => {
    server.use(...mockGateway(respond({ status: 400, body: 'nope' })));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err?.message).toMatch(/E2EE completion failed/);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(chat.count()).toBe(1);
  });

  it('does NOT engage on a 401 that survives the re-mint', async () => {
    server.use(...mockGateway(respond({ status: 401 })));

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err?.message).toMatch(/E2EE completion failed: 401/);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('does NOT engage on a decrypt error', async () => {
    serveJson(CHAT_PATH, () => ({ choices: [{ message: { content: 'not-a-valid-envelope' } }] }));

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err).toBeInstanceOf(Error);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('does NOT engage on success', async () => {
    stalled.clear();

    await run(cloudComplete(REQUEST));

    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(captured).not.toHaveBeenCalled();
  });

  it('a later success never un-engages the fallback', async () => {
    await run(cloudComplete(REQUEST, TIMEOUT));
    stalled.clear();

    await run(cloudComplete(REQUEST));
    await run(cloudComplete(REQUEST));

    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(bodiesOf().slice(3)).toEqual([FALLBACK_MODEL, FALLBACK_MODEL]);
  });

  it('surfaces the ORIGINAL error when the fallback retry also fails', async () => {
    let seen = 0;
    server.use(
      http.post(`*${CHAT_PATH}`, async () => {
        // The two primary attempts hang past the timeout; the fallback attempt drops the connection.
        if (seen++ < 2) await new Promise((resolve) => setTimeout(resolve, 10_000));
        return seen > 2 ? HttpResponse.error() : HttpResponse.json({});
      }),
    );

    const err = await run(errorOf(cloudComplete(REQUEST, TIMEOUT)));

    expect(err?.message).toMatch(/abort|cancel/i);
    expect(seen).toBe(3);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });

  it('reports exactly once per model per session, with a fingerprint keyed on cause and model', async () => {
    await run(cloudComplete(REQUEST, TIMEOUT));
    // The second call is already on the fallback, which now stalls too.
    stalled.add(FALLBACK_MODEL);
    await run(errorOf(cloudComplete(REQUEST, TIMEOUT)));

    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith('NEAR primary model failing — session fallback engaged', {
      level: 'error',
      tags: { model: SMALL_MODEL, fallback: FALLBACK_MODEL },
      fingerprint: ['near-model-fallback', 'timeout', SMALL_MODEL],
    });
  });

  it('fires no pointless extra attempt once already on the fallback', async () => {
    await run(cloudComplete(REQUEST, TIMEOUT));
    stalled.add(FALLBACK_MODEL);
    const before = gatewayCalls('chat').length;

    const err = await run(errorOf(cloudComplete(REQUEST, TIMEOUT)));

    expect(err).toBeInstanceOf(Error);
    // The primary now resolves to the fallback, so a timeout has nowhere else to go: 2 and out.
    expect(gatewayCalls('chat').length - before).toBe(2);
  });

  it('an offline device does not engage the fallback, and the next online stall does', async () => {
    useNetworkStore.getState().setIsConnected(false);

    const err = await run(errorOf(cloudComplete(REQUEST, TIMEOUT)));

    expect(err).toBeInstanceOf(Error);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(captured).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('device offline'),
      'model-fallback',
      expect.objectContaining({ model: SMALL_MODEL }),
      'info',
    );

    useNetworkStore.getState().setIsConnected(true);
    expect(await run(cloudComplete(REQUEST, TIMEOUT))).toBe('recovered');
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('signed out', () => {
  beforeEach(fakeClock);

  it('does NOT engage on a missing credential, and sends nothing', async () => {
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err).toBeInstanceOf(Error);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(chat.count()).toBe(0);
  });
});
