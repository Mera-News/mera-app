// sendInferenceRequest (lib/llm/submitInferenceJob.ts) against the gateway mock's job routes, with a
// real prepareE2EEContext, the real limiter, real auth and real pako.
//
// Outcomes: ok / throttled (429) / in-progress (409, or an abort mid-POST) / no-auth (task context) /
// failed. The wire is read raw (server.events): Idempotency-Key and Authorization verbatim, the gzip
// body inflated by the test. A replay of one key and the pending-poll decode are covered by
// test/integration/harness/gateway.test.ts > async jobs; the 10s limiter pause on in-progress is the
// pipeline's (scoring-pipeline IN_PROGRESS_PAUSE_MS), so here a 409 is pinned as NOT pausing the limiter.
//
// Replaces lib/llm/__tests__/submitInferenceJob.test.ts (32 tests).
import { getJwtToken } from '@/lib/auth-client';
import * as authClient from '@/lib/auth-client';
import { _getBreakerState } from '@/lib/auth-failure-breaker';
import * as limiter from '@/lib/llm/gateway-rate-limiter';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { bytesToHex, sendInferenceRequest } from '@/lib/llm/submitInferenceJob';
import logger from '@/lib/logger';
import { delay, gatewayCalls, http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import {
  bundleOf,
  captureJobPosts,
  context,
  drive,
  PUSH_TOKEN,
  resetJobModules,
  watchAuthRequests,
  type TestCall,
} from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.setTimeout(60_000);

const JOBS = '*/v1/inference/jobs';
const raw = (status: number, headers: Record<string, string> = {}) =>
  new HttpResponse(`status ${status}`, { status, headers });

type Args = Partial<Parameters<typeof sendInferenceRequest>[0]>;

beforeEach(async () => {
  resetJobModules();
  await signInFixtureAccount();
  useStrictClock('2026-10-09T10:00:00Z');
});
afterEach(() => {
  server.events.removeAllListeners();
  jest.restoreAllMocks();
});

/** Real E2EE context, then one submit (driven on the strict clock). */
async function send(args: Args = {}, bundle: { calls: TestCall[] } = bundleOf(1)) {
  const ctx = await drive(context());
  return drive(
    sendInferenceRequest({
      bundle: bundle as never,
      ctx,
      token: null,
      model: SMALL_MODEL,
      context: 'foreground',
      ...args,
    }),
  );
}

/** Has the background lane granted a slot yet? Starts waiting now. */
function backgroundWaiter(): () => boolean {
  let granted = false;
  void limiter.acquire('background').then(() => (granted = true));
  return () => granted;
}

describe('bytesToHex', () => {
  it.each([
    [[0, 15, 255], '000fff'],
    [[1], '01'],
    [[], ''],
  ])('%j -> %j (pads single digits, empty is empty)', (bytes, hex) => {
    expect(bytesToHex(new Uint8Array(bytes))).toBe(hex);
  });
});

describe('the request on the wire', () => {
  it('is gzip, sealed end to end, and carries the push token only when there is one', async () => {
    const { posts, settled } = captureJobPosts();
    const out = await send({ token: PUSH_TOKEN }, bundleOf(2));
    await settled();

    expect(out).toMatchObject({ status: 'ok', capabilityToken: expect.stringMatching(/^cap\./) });
    expect(posts).toHaveLength(1);
    expect(posts[0].headers['content-encoding']).toBe('gzip');
    expect(posts[0].headers['content-type']).toBe('application/json');
    // The bytes that crossed the wire are gzip; the inflated JSON never holds a plaintext prompt.
    const inflated = JSON.stringify(posts[0].body);
    expect(posts[0].body?.expoPushToken).toBe(PUSH_TOKEN);
    expect(inflated).not.toContain('shared relevance system');
    expect(inflated).not.toContain('body 1');
    // ...yet the model side opened every call: the system prompt came in via sharedSystem.
    expect(gatewayCalls('job').map((c) => c.callId)).toEqual(['score:0', 'score:1']);
    expect(gatewayCalls('job')[0].messages[0]).toEqual({ role: 'system', content: 'shared relevance system' });
    expect(gatewayCalls('job')[1].messages[1].content).toContain('body 3');
  });

  it('omits expoPushToken without a token, and gzips even a tiny body', async () => {
    const { posts, settled } = captureJobPosts();
    await send({ token: null }, bundleOf(1));
    await settled();
    expect(posts[0].body).not.toBeNull();
    expect(posts[0].body).not.toHaveProperty('expoPushToken');
    // pako really compressed it: the gzip magic, and fewer bytes than the JSON it holds.
    expect(posts[0].raw.length).toBeLessThan(JSON.stringify(posts[0].body).length);
  });

  it('hoists a system prompt shared by every call into sharedSystem (sent once)', async () => {
    const { posts, settled } = captureJobPosts();
    await send({}, bundleOf(2));
    await settled();
    expect(posts[0].body?.sharedSystem).toBeTruthy();
    for (const r of posts[0].body!.requests) expect(r.body.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps each call\'s own system prompt when they differ (no sharedSystem)', async () => {
    const { posts, settled } = captureJobPosts();
    await send({}, {
      calls: [
        { id: 'c0', system: 'sys-a', prompt: 'p0' },
        { id: 'c1', system: 'sys-b', prompt: 'p1' },
      ],
    });
    await settled();
    expect(posts[0].body).not.toHaveProperty('sharedSystem');
    for (const r of posts[0].body!.requests) expect(r.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(gatewayCalls('job').map((c) => c.messages[0].content)).toEqual(['sys-a', 'sys-b']);
  });

  it('carries per-call temperature, thinking flag and max_tokens', async () => {
    const { posts, settled } = captureJobPosts();
    await send({}, { calls: [{ id: 'reason:x', system: 's', prompt: 'p', maxTokens: 77 }] });
    await settled();
    expect(posts[0].body!.requests[0].body).toMatchObject({
      model: SMALL_MODEL,
      temperature: 0.3,
      max_tokens: 77,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('sends the Idempotency-Key header verbatim, and none when no key is given', async () => {
    const { posts, settled } = captureJobPosts();
    await send({ idempotencyKey: 'run-a:3:rel:0' });
    await send({});
    await settled();
    expect(posts[0].headers['idempotency-key']).toBe('run-a:3:rel:0');
    expect(posts[1].headers).not.toHaveProperty('idempotency-key');
  });

  it('a 202 without a capability token is ok with an empty one; without a requestId it is failed and captured', async () => {
    server.use(http.post(JOBS, () => HttpResponse.json({ requestId: 'rid-1' }, { status: 202 }), { once: true }));
    expect(await send()).toEqual({ status: 'ok', requestId: 'rid-1', capabilityToken: '' });

    server.use(http.post(JOBS, () => HttpResponse.json({ capabilityToken: 'tok' }, { status: 202 }), { once: true }));
    expect(await send()).toEqual({ status: 'failed' });
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('no requestId') }),
      expect.anything(),
    );
  });
});

describe('auth per execution context', () => {
  it('foreground: the keychain JWT first, even when a capability token is passed', async () => {
    const { posts } = captureJobPosts();
    const out = await send({ capabilityToken: 'cap-should-not-be-used' });
    expect(out.status).toBe('ok');
    expect(posts[0].headers.authorization).toBe(`Bearer ${await getJwtToken()}`);
  });

  it('foreground with no JWT (signed out) falls back to the capability token', async () => {
    const ctx = await drive(context());
    server.use(http.get('*/api/auth/token', () => raw(401)));
    authClient.invalidateJwtCache();
    const { posts } = captureJobPosts();
    const out = await drive(
      sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground', capabilityToken: 'cap-tok-fallback' }),
    );
    expect(out.status).toBe('ok');
    expect(posts[0].headers.authorization).toBe('Bearer cap-tok-fallback');
  });

  it('foreground whose JWT lookup throws also falls back to the capability token', async () => {
    const ctx = await drive(context());
    jest.spyOn(authClient, 'getJwtToken').mockRejectedValueOnce(new Error('keychain unavailable'));
    const { posts } = captureJobPosts();
    const out = await drive(
      sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground', capabilityToken: 'fallback-cap' }),
    );
    expect(out.status).toBe('ok');
    expect(posts[0].headers.authorization).toBe('Bearer fallback-cap');
  });

  it('foreground with neither a JWT nor a capability token throws and sends nothing', async () => {
    const ctx = await drive(context());
    server.use(http.get('*/api/auth/token', () => raw(401)));
    authClient.invalidateJwtCache();
    await expect(
      drive(sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground' })),
    ).rejects.toThrow('foreground has no JWT and no capability token');
    expect(gatewayCalls('job')).toHaveLength(0);
  });

  it('background: the capability token only, and the auth server is never asked', async () => {
    const ctx = await drive(context());
    authClient.invalidateJwtCache();
    const authRequests = watchAuthRequests();
    const { posts } = captureJobPosts();
    const out = await drive(
      sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'background', capabilityToken: 'bg-cap-token' }),
    );
    expect(out.status).toBe('ok');
    expect(posts[0].headers.authorization).toBe('Bearer bg-cap-token');
    expect(authRequests).toEqual([]);
  });

  it('background without a capability token throws and sends nothing', async () => {
    const ctx = await drive(context());
    await expect(
      drive(sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'background' })),
    ).rejects.toThrow('no capability token (background)');
    expect(gatewayCalls('job')).toHaveLength(0);
  });

  it('task: the JWT only, never the capability token', async () => {
    const { posts } = captureJobPosts();
    const out = await send({ context: 'task', capabilityToken: 'cap' });
    expect(out.status).toBe('ok');
    expect(posts[0].headers.authorization).toBe(`Bearer ${await getJwtToken()}`);
  });

  it('task with no JWT is no-auth without a request, and does not touch the breaker', async () => {
    const ctx = await drive(context());
    server.use(http.get('*/api/auth/token', () => raw(401)));
    authClient.invalidateJwtCache();
    const out = await drive(
      sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'task', capabilityToken: 'cap' }),
    );
    expect(out).toEqual({ status: 'no-auth' });
    expect(gatewayCalls('job')).toHaveLength(0);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('task whose JWT mint is cut by the deadline is no-auth, not a throw', async () => {
    const ctx = await drive(context());
    // The mint stays in flight until the test lets it go: auth-client keeps ONE pending mint at module
    // level, so a request that never answers would hang every later test that needs a JWT.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(http.get('*/api/auth/token', async () => (await gate, raw(401))));
    authClient.invalidateJwtCache();
    const stop = new AbortController();
    const p = sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'task', signal: stop.signal });
    await jest.advanceTimersByTimeAsync(500);
    stop.abort();
    expect(await drive(p)).toEqual({ status: 'no-auth' });
    expect(gatewayCalls('job')).toHaveLength(0);
    release();
    await drive(getJwtToken());
  });

  it('task 401 is no-auth: no re-mint, no auth-breaker report, one POST', async () => {
    server.use(http.post(JOBS, () => raw(401)));
    const authRequests = watchAuthRequests();
    const { posts } = captureJobPosts();
    expect(await send({ context: 'task' })).toEqual({ status: 'no-auth' });
    expect(posts).toHaveLength(1);
    expect(authRequests.filter((p) => p.endsWith('/token'))).toHaveLength(1);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });
});

describe('401 / 403 recovery (foreground)', () => {
  it('401 then a fresh JWT retries the POST once and succeeds, without a breaker report', async () => {
    server.use(http.post(JOBS, () => raw(401), { once: true }));
    const authRequests = watchAuthRequests();
    const { posts } = captureJobPosts();
    const out = await send();
    expect(out.status).toBe('ok');
    expect(posts).toHaveLength(2);
    // The JWT was invalidated and minted again.
    expect(authRequests.filter((p) => p.endsWith('/token'))).toHaveLength(2);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it.each([401, 403])('%i after the re-mint is failed and recorded once with the breaker', async (status) => {
    server.use(http.post(JOBS, () => raw(status)));
    const { posts } = captureJobPosts();
    expect(await send()).toEqual({ status: 'failed' });
    expect(posts).toHaveLength(2);
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('401 with no fresh JWT sends no second POST and still records the failure', async () => {
    const ctx = await drive(context());
    authClient.invalidateJwtCache();
    await getJwtToken();
    server.use(http.post(JOBS, () => raw(401)));
    // The first mint worked (cached); the re-mint after invalidation is refused.
    server.use(http.get('*/api/auth/token', () => raw(401)));
    const { posts } = captureJobPosts();
    const out = await drive(sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground' }));
    expect(out).toEqual({ status: 'failed' });
    expect(posts).toHaveLength(1);
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('background 401 never re-mints or reports: a stale capability token says nothing about the session', async () => {
    const ctx = await drive(context());
    server.use(http.post(JOBS, () => raw(401)));
    const authRequests = watchAuthRequests();
    const { posts } = captureJobPosts();
    const out = await drive(
      sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'background', capabilityToken: 'bg-cap-token' }),
    );
    expect(out).toEqual({ status: 'failed' });
    expect(posts).toHaveLength(1);
    expect(authRequests).toEqual([]);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });
});

describe('status mapping', () => {
  it('a non-202 is failed and captured with its status as a field', async () => {
    server.use(http.post(JOBS, () => raw(400)));
    expect(await send()).toEqual({ status: 'failed' });
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
      expect.objectContaining({ tags: expect.objectContaining({ service: 'submitInferenceJob', status: '400' }) }),
    );
  });

  it('429 is throttled and pauses the background lane for Retry-After seconds', async () => {
    server.use(http.post(JOBS, () => raw(429, { 'Retry-After': '5' })));
    expect(await send()).toEqual({ status: 'throttled' });
    const granted = backgroundWaiter();
    await jest.advanceTimersByTimeAsync(4_500);
    expect(granted()).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(granted()).toBe(true);
  });

  it('429 without a usable Retry-After pauses for 30s', async () => {
    server.use(http.post(JOBS, () => raw(429)));
    expect(await send()).toEqual({ status: 'throttled' });
    const granted = backgroundWaiter();
    await jest.advanceTimersByTimeAsync(29_000);
    expect(granted()).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(granted()).toBe(true);
  });

  // CO2 (core): the 429 pause is Retry-After verbatim. Every other Retry-After reader caps it.
  test.failing('a 429 Retry-After pause is capped at 60s', async () => {
    server.use(http.post(JOBS, () => raw(429, { 'Retry-After': '3600' })));
    expect(await send()).toEqual({ status: 'throttled' });
    const granted = backgroundWaiter();
    await jest.advanceTimersByTimeAsync(61_000);
    expect(granted()).toBe(true);
  });

  it('today a 429 Retry-After of 3600s still holds the background lane for the full hour (CO2 sibling)', async () => {
    server.use(http.post(JOBS, () => raw(429, { 'Retry-After': '3600' })));
    expect(await send()).toEqual({ status: 'throttled' });
    const granted = backgroundWaiter();
    await jest.advanceTimersByTimeAsync(61_000);
    expect(granted()).toBe(false);
    // The pause still has almost the whole hour to run.
    expect(limiter.msUntilNextGrant()).toBeGreaterThan(3_400_000);
  });

  it('409 is in-progress (the key is still reserved), not failed, and does not itself pause the limiter', async () => {
    server.use(http.post(JOBS, () => raw(409)));
    expect(await send({ idempotencyKey: 'k' })).toEqual({ status: 'in-progress' });
    expect(logger.captureException).not.toHaveBeenCalled();
    const granted = backgroundWaiter();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(granted()).toBe(true);
  });
});

describe('retries, deadlines and the limiter', () => {
  it('retries a 5xx up to four times: five POSTs, then failed and captured', async () => {
    server.use(http.post(JOBS, () => raw(503)));
    const { posts } = captureJobPosts();
    expect(await send()).toEqual({ status: 'failed' });
    expect(posts).toHaveLength(5);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('submit failed (503)') }),
      expect.objectContaining({ tags: expect.objectContaining({ status: 'retry-exhausted' }) }),
    );
  });

  it('a 5xx that clears on the second try is ok', async () => {
    server.use(http.post(JOBS, () => raw(503), { once: true }));
    const { posts } = captureJobPosts();
    expect((await send()).status).toBe('ok');
    expect(posts).toHaveLength(2);
  });

  it('singleAttempt makes exactly one POST', async () => {
    server.use(http.post(JOBS, () => raw(503)));
    const { posts } = captureJobPosts();
    expect(await send({ singleAttempt: true })).toEqual({ status: 'failed' });
    expect(posts).toHaveLength(1);
  });

  it('a POST that hangs is cut at 30s: our own timeout is benign (warned, not captured)', async () => {
    server.use(http.post(JOBS, () => delay('infinite')));
    expect(await send({ singleAttempt: true })).toEqual({ status: 'failed' });
    expect(logger.captureException).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('transient network/abort'), expect.anything());
  });

  it('the caller\'s deadline firing mid-POST is in-progress, never failed (the job may exist)', async () => {
    const ctx = await drive(context());
    server.use(http.post(JOBS, () => delay('infinite')));
    const stop = new AbortController();
    const p = sendInferenceRequest({
      bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'task',
      idempotencyKey: 'k', singleAttempt: true, signal: stop.signal,
    });
    await jest.advanceTimersByTimeAsync(3_000);
    stop.abort();
    expect(await drive(p)).toEqual({ status: 'in-progress' });
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('a deadline that passes while waiting for a limiter slot is failed with nothing sent', async () => {
    const ctx = await drive(context());
    limiter.pauseFor(600_000);
    const stop = new AbortController();
    const p = sendInferenceRequest({
      bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground', signal: stop.signal,
    });
    await jest.advanceTimersByTimeAsync(5_000);
    stop.abort();
    expect(await drive(p)).toEqual({ status: 'failed' });
    expect(gatewayCalls('job')).toHaveLength(0);
  });

  it('waits for its own limiter slot, but not when the caller already holds a grant', async () => {
    const ctx = await drive(context());
    limiter.pauseFor(20_000);
    const args = { bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground' as const };

    const waits = sendInferenceRequest(args);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(gatewayCalls('job')).toHaveLength(0);
    await drive(waits);
    expect(gatewayCalls('job')).toHaveLength(1);

    limiter.pauseFor(600_000);
    const held = sendInferenceRequest({ ...args, grantAlreadyHeld: true });
    expect((await drive(held, 5_000)).status).toBe('ok');
    expect(gatewayCalls('job')).toHaveLength(2);
  });
});
