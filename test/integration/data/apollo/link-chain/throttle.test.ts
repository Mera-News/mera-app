// Throttle handling in errorLink, in all three shapes a 429 can arrive in. The re-send, the
// Retry-After rules and the backoff are observed as timestamps at the server under the fake clock.
import { advanceUntilDone, server, useFakeClock } from '@/test/helpers';
import {
    client,
    crumbs,
    failureOf,
    PROBE,
    recordRequests,
    resetLinkState,
    spyLogger,
    THROTTLE_SHAPES,
    throttleThenData,
} from './kit';

// Whole second, so an HTTP-date header (second resolution) is exact.
const START = Math.floor(Date.now() / 1000) * 1000;
// advanceUntilDone steps 50ms and the fake clock also drifts with real time, so allow a little slop.
const SLOP = 150;

beforeEach(() => {
    resetLinkState();
    useFakeClock(START);
});

const query = () => client.query({ query: PROBE, fetchPolicy: 'no-cache' });

describe.each(THROTTLE_SHAPES)('throttle as %s', (shape) => {
    it('re-sends once after the wait and resolves with the data', async () => {
        spyLogger();
        const seen = recordRequests();
        server.use(throttleThenData(shape, { 'Retry-After': '2' }, 1));

        const result = await advanceUntilDone(query());

        expect(result.data).toEqual({ probe: 'finally' });
        expect(seen).toHaveLength(2);
    });

    it('honours Retry-After in delta-seconds: never early, at most 20 percent late', async () => {
        spyLogger();
        const seen = recordRequests();
        server.use(throttleThenData(shape, { 'Retry-After': '2' }, 1));

        await advanceUntilDone(query());

        const waited = seen[1].at - seen[0].at;
        expect(waited).toBeGreaterThanOrEqual(2000);
        expect(waited).toBeLessThanOrEqual(2400 + SLOP);
    });

    it('honours Retry-After in HTTP-date form: never before the named instant', async () => {
        spyLogger();
        const seen = recordRequests();
        const instant = START + 5000;
        server.use(throttleThenData(shape, { 'Retry-After': new Date(instant).toUTCString() }, 1));

        await advanceUntilDone(query());

        expect(seen[1].at).toBeGreaterThanOrEqual(instant);
        expect(seen[1].at).toBeLessThanOrEqual(instant + 1000 + SLOP);
    });

    it('caps a long Retry-After at 30s', async () => {
        spyLogger();
        const seen = recordRequests();
        server.use(throttleThenData(shape, { 'Retry-After': '600' }, 1));

        await advanceUntilDone(query());

        const waited = seen[1].at - seen[0].at;
        expect(waited).toBeGreaterThanOrEqual(30_000);
        expect(waited).toBeLessThanOrEqual(30_000 + SLOP);
    });

    it('without the header, backs off 500ms before the first re-send', async () => {
        spyLogger();
        const seen = recordRequests();
        server.use(throttleThenData(shape, {}, 1));

        await advanceUntilDone(query());

        const waited = seen[1].at - seen[0].at;
        expect(waited).toBeGreaterThanOrEqual(500);
        expect(waited).toBeLessThanOrEqual(500 + SLOP);
    });

    // DATA-U4-1 (DA5). ErrorLink hands a re-send's outcome to the caller, so the re-send is routed
    // back through the throttle decision: MAX_THROTTLE_RETRIES re-sends, not one.
    it('DATA-U4-1: a server that keeps throttling is re-sent three times, four requests in all', async () => {
        spyLogger();
        const seen = recordRequests();
        server.use(throttleThenData(shape, { 'Retry-After': '1' }));

        const err = await advanceUntilDone(failureOf(query()));

        expect(err).toBeTruthy();
        expect(seen).toHaveLength(4);
    });
});

describe('the backing-off breadcrumb', () => {
    it('an HTTP 429 leaves the breadcrumb, naming the wait and whether Retry-After was honoured', async () => {
        const logs = spyLogger();
        server.use(throttleThenData('HTTP 429 with an empty body', { 'Retry-After': '2' }, 1));

        await advanceUntilDone(query());

        expect(crumbs(logs.crumb)).toContain('HTTP 429 — backing off');
        const data = logs.crumb.mock.calls.find((c) => c[0] === 'HTTP 429 — backing off')![2];
        expect(data).toMatchObject({ operationName: 'LinkProbe', attempt: 0, honouredRetryAfter: true });
        expect(data!.delayMs).toBeGreaterThanOrEqual(2000);
        expect(data!.delayMs).toBeLessThanOrEqual(2400);
    });

    it('without Retry-After the breadcrumb says the backoff, not the header, set the wait', async () => {
        const logs = spyLogger();
        server.use(throttleThenData('HTTP 429 with an empty body', {}, 1));

        await advanceUntilDone(query());

        const data = logs.crumb.mock.calls.find((c) => c[0] === 'HTTP 429 — backing off')![2];
        expect(data).toMatchObject({ attempt: 0, delayMs: 500, honouredRetryAfter: false });
    });
});
