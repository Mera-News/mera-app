// authFetch against the gateway mock: retry budget, 401 re-mint, 429 handling, caller aborts and
// the limiter grant per attempt. Real auth (the fixture account), real limiter, real E2EE; the mock
// stands in for the gateway. Backoff is full-jitter, so nothing here asserts an exact sleep: only
// attempt counts, ceilings and lower bounds on the gaps the limiter and Retry-After impose.
import {
  authFetch,
  CallerAbortError,
  isAbortLike,
  isCallerAbort,
  MAX_ATTEMPTS,
  RateLimitedError,
  retryAfterMsFrom,
  type AuthFetchOptions,
} from '@/lib/llm/cloudComplete';
import {
  acquire,
  INTERACTIVE_MAX_PAUSE_MS,
  interactiveWaitMs,
  msUntilNextGrant,
} from '@/lib/llm/gateway-rate-limiter';
import logger from '@/lib/logger';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import {
  advanceUntil,
  CHAT_PATH,
  errorOf,
  failChatNetwork,
  failChatNetworkAlways,
  fakeClock,
  ORIGIN,
  resetTransport,
  respond,
  run,
  sealedInit,
  TOKEN_PATH,
  watchRequests,
} from './transport-kit';

const URL = `${ORIGIN}${CHAT_PATH}`;
const SENTINEL = 'SENTINEL-AUTHFETCH-3c1d what is the news';
const tooMany = (retryAfter?: string) => ({
  status: 429,
  ...(retryAfter !== undefined && { headers: { 'Retry-After': retryAfter } }),
});

/** A sealed chat request through authFetch, sealing included, so one `run` drives all of it. */
const send = (options?: AuthFetchOptions, extra?: RequestInit) =>
  sealedInit(SENTINEL, extra).then((init) => authFetch(URL, init, options));

let spies: jest.SpyInstance[] = [];

beforeEach(async () => {
  await resetTransport();
  fakeClock();
});

afterEach(() => {
  server.events.removeAllListeners();
  spies.forEach((s) => s.mockRestore());
  spies = [];
});

describe('a request that goes through', () => {
  it('returns the gateway response on the first attempt', async () => {
    server.use(...mockGateway(respond('hello')));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(1);
  });

  it('forwards the bearer and the sealed body, and the sentinel never leaves in the clear', async () => {
    server.use(...mockGateway(respond('hello')));
    const chat = watchRequests(CHAT_PATH);

    await run(send());

    const [call] = gatewayCalls('chat');
    expect(call.messages).toEqual([{ role: 'user', content: SENTINEL }]);
    expect(call.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [raw] = await chat.raw();
    expect(raw).not.toContain('SENTINEL');
    expect(JSON.parse(raw)).toMatchObject({ stream: false });
  });

  it.each([404, 400])('returns a %i without retrying', async (status) => {
    server.use(...mockGateway(respond({ status })));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(status);
    expect(chat.count()).toBe(1);
  });
});

describe('401 re-mint', () => {
  it('mints a fresh JWT ONCE and retries', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 401 } : 'ok')));
    const tokens = watchRequests(TOKEN_PATH);
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(2);
    // One mint for the first request, one re-mint after the 401.
    expect(tokens.count()).toBe(2);
  });

  it('a 401 that survives the fresh JWT is returned, not looped', async () => {
    server.use(...mockGateway(respond({ status: 401 })));
    const tokens = watchRequests(TOKEN_PATH);
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(401);
    expect(chat.count()).toBe(2);
    expect(tokens.count()).toBe(2);
  });

  it('does not count against the timeout budget', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 401 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send({ maxTimeoutAttempts: 1 }));

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(2);
  });
});

describe('5xx and network retries', () => {
  it('a 500 is retried and the second attempt wins', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 500 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    expect((await run(send())).status).toBe(200);
    expect(chat.count()).toBe(2);
  });

  it('503 twice then success lands on the third attempt', async () => {
    server.use(...mockGateway((c) => (c.index < 2 ? { status: 503 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    expect((await run(send())).status).toBe(200);
    expect(chat.count()).toBe(3);
  });

  it('a 502 is retried like other 5xx under default options', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 502 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    expect((await run(send())).status).toBe(200);
    expect(chat.count()).toBe(2);
  });

  it('a persistent 5xx stops at MAX_ATTEMPTS and returns the last response', async () => {
    server.use(...mockGateway(respond({ status: 500 })));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(500);
    expect(chat.count()).toBe(MAX_ATTEMPTS);
  });

  it('a network error is retried', async () => {
    failChatNetwork(1);
    const chat = watchRequests(CHAT_PATH);

    expect((await run(send())).status).toBe(200);
    expect(chat.count()).toBe(2);
  });

  it('recovers on the LAST attempt within MAX_ATTEMPTS', async () => {
    failChatNetwork(MAX_ATTEMPTS - 1);
    const chat = watchRequests(CHAT_PATH);

    expect((await run(send())).status).toBe(200);
    expect(chat.count()).toBe(MAX_ATTEMPTS);
  });

  it('gives up at MAX_ATTEMPTS on a persistent network error', async () => {
    failChatNetworkAlways();
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send()));

    expect(err).toBeInstanceOf(Error);
    expect(chat.count()).toBe(MAX_ATTEMPTS);
  });

  it('caps 502 attempts with maxTimeoutAttempts and surfaces the 502', async () => {
    server.use(...mockGateway((c) => (c.index < 2 ? { status: 502 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send({ maxTimeoutAttempts: 2 }));

    expect(res.status).toBe(502);
    expect(chat.count()).toBe(2);
  });

  it('caps network-error attempts with maxTimeoutAttempts', async () => {
    failChatNetwork(2);
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send({ maxTimeoutAttempts: 2 })));

    expect(err).toBeInstanceOf(Error);
    expect(chat.count()).toBe(2);
  });
});

describe('timeouts', () => {
  it('a per-attempt timeout is retried and logged as a timeout, not a network error', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['late'], headerDelayMs: 60_000 } : 'ok')));
    const warn = jest.spyOn(logger, 'warn');
    spies.push(warn);
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send({ requestTimeoutMs: 200 }));

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'), { url: URL });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fetch error'),
      expect.objectContaining({ timedOut: true }),
    );
  });

  it('a plain network error is logged with timedOut false', async () => {
    failChatNetwork(1);
    const warn = jest.spyOn(logger, 'warn');
    spies.push(warn);

    await run(send());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fetch error'),
      expect.objectContaining({ timedOut: false }),
    );
  });

  it('a caller signal is added to the timeout, never a replacement for it', async () => {
    server.use(...mockGateway(respond({ chunks: ['late'], headerDelayMs: 600_000 })));
    const controller = new AbortController();
    const chat = watchRequests(CHAT_PATH);

    const err = await run(
      errorOf(send({ requestTimeoutMs: 50, maxTimeoutAttempts: 1 }, { signal: controller.signal })),
    );

    expect(err?.message).toMatch(/abort/i);
    expect(isCallerAbort(err)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(chat.count()).toBe(1);
  });
});

describe('caller aborts', () => {
  it('surface as CallerAbortError with no budget spent and no retry', async () => {
    server.use(...mockGateway(respond({ chunks: ['late'], headerDelayMs: 600_000 })));
    const controller = new AbortController();
    const chat = watchRequests(CHAT_PATH);
    // The timeout is far away and the budget allows a second attempt: only the abort can end this.
    const outcome = errorOf(
      send({ requestTimeoutMs: 590_000, maxTimeoutAttempts: 2 }, { signal: controller.signal }),
    );
    await advanceUntil(() => chat.count() === 1);

    controller.abort();
    const err = await run(outcome);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(isCallerAbort(err)).toBe(true);
    expect(err?.name).toBe('CallerAbortError');
    expect(chat.count()).toBe(1);
  });

  it('spend no request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send(undefined, { signal: controller.signal })));

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(chat.count()).toBe(0);
  });

  it('spend no request when the caller goes away while queued for a grant', async () => {
    const controller = new AbortController();
    const init = await run(sealedInit(SENTINEL, { signal: controller.signal }));
    await run(acquire('interactive')); // the next grant is now a second away
    const chat = watchRequests(CHAT_PATH);

    const outcome = errorOf(authFetch(URL, init, { lane: 'interactive' }));
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    const err = await run(outcome);

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(chat.count()).toBe(0);
  });

  it('isCallerAbort and isAbortLike classify errors by wording', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const canceled = new Error('fetch failed: Fetch request has been canceled');
    expect(isCallerAbort(abort)).toBe(false);
    expect(isCallerAbort(canceled)).toBe(false);
    expect(isCallerAbort('not an error')).toBe(false);
    expect(isAbortLike(abort)).toBe(true);
    expect(isAbortLike(new Error('The operation was aborted'))).toBe(true);
    expect(isAbortLike(canceled)).toBe(true);
    expect(isAbortLike(new Error('Request was cancelled'))).toBe(true);
    expect(isAbortLike(new Error('Network request failed'))).toBe(false);
    expect(isAbortLike('not an error')).toBe(false);
  });
});

describe('429', () => {
  const gap = (times: number[]) => times[1] - times[0];

  it('pauses the device and retries ONCE on a background 429', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? tooMany('5') : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send());

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(2);
    expect(gap(chat.times())).toBeGreaterThanOrEqual(5_000);
    expect(gap(chat.times())).toBeLessThan(7_000);
  });

  it('surfaces RateLimitedError on a SECOND 429 rather than looping, and never retries it as a network error', async () => {
    server.use(...mockGateway(respond(tooMany('5'))));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send()));

    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ statusCode: 429, retryAfterMs: 5_000 });
    expect(chat.count()).toBe(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(chat.count()).toBe(2);
  });

  it('clamps a huge Retry-After to 60s', async () => {
    expect(retryAfterMsFrom(new Headers({ 'Retry-After': '86400' }))).toBe(60_000);
    server.use(...mockGateway(respond(tooMany('86400'))));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send()));

    expect(err).toMatchObject({ retryAfterMs: 60_000 });
    expect(gap(chat.times())).toBeGreaterThanOrEqual(60_000);
    expect(gap(chat.times())).toBeLessThan(62_000);
  });

  it('falls back to a 30s default when Retry-After is absent', async () => {
    server.use(...mockGateway(respond(tooMany())));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send()));

    expect(err).toMatchObject({ retryAfterMs: 30_000 });
    expect(gap(chat.times())).toBeGreaterThanOrEqual(30_000);
    expect(gap(chat.times())).toBeLessThan(32_000);
  });

  it.each([
    ['5', 5_000],
    ['120', 60_000],
    ['0', 30_000],
    ['-3', 30_000],
    ['abc', 30_000],
  ])('retryAfterMsFrom reads Retry-After %s as %i ms', (header, ms) => {
    expect(retryAfterMsFrom(new Headers({ 'Retry-After': header }))).toBe(ms);
  });

  it('retryAfterMsFrom defaults to 30s with no header or no headers', () => {
    expect(retryAfterMsFrom(new Headers())).toBe(30_000);
    expect(retryAfterMsFrom(undefined)).toBe(30_000);
  });

  it('an interactive 429 whose Retry-After exceeds the cap throws at once, after pausing the device', async () => {
    server.use(...mockGateway(respond(tooMany('30'))));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(send({ lane: 'interactive' })));

    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ statusCode: 429, retryAfterMs: 30_000 });
    // The turn ends instead of waiting, and the RateLimitedError is not retried as a network error.
    expect(chat.count()).toBe(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(chat.count()).toBe(1);
  });

  it('pauses background in full and chat for at most INTERACTIVE_MAX_PAUSE_MS', async () => {
    server.use(...mockGateway(respond(tooMany('30'))));

    await run(errorOf(send({ lane: 'interactive' })));

    expect(msUntilNextGrant()).toBeGreaterThan(29_000);
    expect(interactiveWaitMs()).toBeLessThanOrEqual(INTERACTIVE_MAX_PAUSE_MS);
  });

  it('retries an interactive 429 whose Retry-After is within the cap', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? tooMany('1') : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    const res = await run(send({ lane: 'interactive' }));

    expect(res.status).toBe(200);
    expect(chat.count()).toBe(2);
  });
});

describe('the limiter grant', () => {
  it('is taken for EVERY attempt, retries included', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 503 } : 'ok')));
    const chat = watchRequests(CHAT_PATH);

    await run(send({ lane: 'interactive' }));

    // Backoff after attempt one is under 500ms, so a gap of a second is the limiter's spacing.
    expect(chat.times()[1] - chat.times()[0]).toBeGreaterThanOrEqual(1_000);
  });

  it('defaults to the background lane: an interactive caller queued later is granted first', async () => {
    const init = await run(sealedInit(SENTINEL));
    await run(acquire('interactive'));
    const chat = watchRequests(CHAT_PATH);
    let interactiveAt = 0;

    const sent = authFetch(URL, init);
    const interactive = acquire('interactive').then(() => (interactiveAt = Date.now()));
    await run(Promise.all([sent, interactive]));

    expect(chat.times()[0] - interactiveAt).toBeGreaterThanOrEqual(900);
  });

  it('uses the lane the caller asks for: an interactive authFetch jumps a queued background caller', async () => {
    const init = await run(sealedInit(SENTINEL));
    await run(acquire('interactive'));
    const chat = watchRequests(CHAT_PATH);
    let backgroundAt = 0;

    const background = acquire('background').then(() => (backgroundAt = Date.now()));
    const sent = authFetch(URL, init, { lane: 'interactive' });
    await run(Promise.all([sent, background]));

    expect(backgroundAt - chat.times()[0]).toBeGreaterThanOrEqual(900);
  });

  it('is skipped for the first attempt when the caller already holds one', async () => {
    const init = await run(sealedInit(SENTINEL));
    await run(acquire('interactive'));
    const heldAt = Date.now();
    const chat = watchRequests(CHAT_PATH);

    await run(authFetch(URL, init, { grantAlreadyHeld: true }));
    expect(chat.times()[0] - heldAt).toBeLessThan(500);

    // The control: without the flag the same call waits out the spacing.
    await run(acquire('interactive'));
    const anchor = Date.now();
    await run(authFetch(URL, init));
    expect(chat.times()[1] - anchor).toBeGreaterThanOrEqual(900);
  });
});
