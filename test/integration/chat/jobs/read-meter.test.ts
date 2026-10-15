// sendInferenceRequest against the gateway mock's reading meter (setReadMeter): the request
// header, the used figure on a 202, the 429 hold and the 402 old-client refusal, and the gate
// that sends nothing while held. The pipeline side (no attempt burn, no dispatch while held,
// resume after the reset) is test/integration/persona/scoring-pipeline-read-hold.test.ts.
import * as limiter from '@/lib/llm/gateway-rate-limiter';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { sendInferenceRequest } from '@/lib/llm/submitInferenceJob';
import logger from '@/lib/logger';
import { getReadHold, isReadHeld, resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { setReadMeter } from '@/test/mock-backend/gateway/state';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import { bundleOf, captureJobPosts, context, drive, resetJobModules } from './support';

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

const NOW = Date.parse('2026-10-09T10:00:00Z');
const MIDNIGHT = Date.parse('2026-10-10T00:00:00Z');
const JOBS = '*/v1/inference/jobs';

beforeEach(async () => {
  resetJobModules();
  resetReadHold();
  await signInFixtureAccount();
  useStrictClock('2026-10-09T10:00:00Z');
});
afterEach(() => {
  server.events.removeAllListeners();
  jest.restoreAllMocks();
});

async function send() {
  const ctx = await drive(context());
  return drive(
    sendInferenceRequest({ bundle: bundleOf(1) as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground' }),
  );
}

describe('the reading meter on /v1/inference/jobs', () => {
  it('every submit says it understands the meter: X-Mera-Reading: 1', async () => {
    const { posts, settled } = captureJobPosts();
    await send();
    await settled();
    expect(posts[0].headers['x-mera-reading']).toBe('1');
  });

  it("a 202's X-Mera-Reading-Used becomes today's used figure", async () => {
    setReadMeter({ used: 0.42 });
    expect((await send()).status).toBe('ok');
    expect(getReadHold().used).toBe(0.42);
    expect(isReadHeld()).toBe(false);
  });

  it('a 429 daily-quota-exceeded holds until the reset: used = 1, nothing reported, the limiter is NOT paused', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    setReadMeter({ resetAt: MIDNIGHT });
    const pause = jest.spyOn(limiter, 'pauseFor');
    expect(await send()).toEqual({ status: 'read-held' });
    expect(getReadHold()).toEqual({ resetAt: MIDNIGHT, used: 1 });
    expect(isReadHeld(MIDNIGHT - 1)).toBe(true);
    expect(isReadHeld(MIDNIGHT + 1)).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('while held, nothing is sent at all', async () => {
    setReadMeter({ resetAt: MIDNIGHT });
    const { posts, settled } = captureJobPosts();
    expect((await send()).status).toBe('read-held');
    expect((await send()).status).toBe('read-held');
    await settled();
    expect(posts).toHaveLength(1);
  });

  it('a 402 with the same body (an old-client refusal) holds too, and is not captured', async () => {
    server.use(
      http.post(JOBS, () =>
        HttpResponse.json({ code: 'daily-quota-exceeded', resetAt: new Date(MIDNIGHT).toISOString() }, { status: 402 }),
      ),
    );
    expect(await send()).toEqual({ status: 'read-held' });
    expect(isReadHeld()).toBe(true);
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('a quota refusal without a resetAt holds until the next 00:00 UTC by the server clock', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // The server clock runs 5 minutes behind the device (a Date header has whole seconds).
    server.use(
      http.post(JOBS, () =>
        HttpResponse.json(
          { code: 'daily-quota-exceeded' },
          { status: 429, headers: { Date: new Date(Date.now() - 5 * 60_000).toUTCString(), 'Retry-After': '60' } },
        ),
      ),
    );
    expect((await send()).status).toBe('read-held');
    expect(getReadHold().resetAt).toBe(MIDNIGHT);
    // The hold end is the reset moved onto the device clock.
    expect(isReadHeld(MIDNIGHT + 4 * 60_000)).toBe(true);
    expect(isReadHeld(MIDNIGHT + 5 * 60_000 + 2_000)).toBe(false);
  });

  it('a plain 429 with any other body is still an ordinary throttle', async () => {
    server.use(http.post(JOBS, () => HttpResponse.json({ code: 'something-else' }, { status: 429, headers: { 'Retry-After': '5' } })));
    expect(await send()).toEqual({ status: 'throttled' });
    expect(isReadHeld()).toBe(false);
  });

  it('after the hold ends, submits go out again', async () => {
    await setReadHold({ resetAt: NOW + 1_000 });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(isReadHeld()).toBe(true);
    await jest.advanceTimersByTimeAsync(31 * 60_000);
    expect(isReadHeld()).toBe(false);
    expect((await send()).status).toBe('ok');
  });
});
