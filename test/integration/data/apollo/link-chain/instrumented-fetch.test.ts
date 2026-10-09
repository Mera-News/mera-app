// instrumentedFetch against MSW: the 8s slow band that leaves the request running, and the 30s
// ceiling that aborts with a marked error. Time is the fake clock; the server is MSW with delay().
import {
    instrumentedFetch,
    isRequestTimeoutError,
    REQUEST_ABORT_MS,
    requestElapsedMs,
    SLOW_REQUEST_MS,
} from '@/lib/apollo-fetch';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, delay, http, HttpResponse, server, useFakeClock } from '@/test/helpers';
import { recordRequests, resetLinkState } from './kit';

const URL = 'http://127.0.0.1:8790/graphql';
const slow = () => useNetworkStore.getState().serverSlow;
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
const outcome = (p: Promise<Response>) =>
    p.then(
        (r) => ({ ok: true as const, response: r }),
        (e: unknown) => ({ ok: false as const, error: e as Error }),
    );
/** GET /graphql answering after `ms` (never when 'infinite'), with `respond`. */
const endpoint = (ms: number | 'infinite', respond: () => Response = () => HttpResponse.json({ ok: true })) =>
    http.get(URL, async () => {
        await delay(ms);
        return respond();
    });

beforeEach(() => {
    resetLinkState();
    useFakeClock(Date.now());
});

it('orders the thresholds slow < abort, so a slow request gets a chance to finish', () => {
    expect(SLOW_REQUEST_MS).toBeLessThan(REQUEST_ABORT_MS);
});

it('a fast response never arms the slow band', async () => {
    const states: boolean[] = [];
    const stop = useNetworkStore.subscribe((s) => states.push(s.serverSlow));
    server.use(endpoint(0));

    const res = await advanceUntilDone(instrumentedFetch(URL));

    stop();
    expect(res.status).toBe(200);
    expect(states).not.toContain(true);
    expect(slow()).toBe(false);
});

it('arms the band at the slow threshold, leaves the request running, and still delivers it', async () => {
    const seen = recordRequests();
    server.use(endpoint(SLOW_REQUEST_MS + 4_000));

    const pending = outcome(instrumentedFetch(URL));
    await advance(SLOW_REQUEST_MS - 500);
    expect(slow()).toBe(false);

    await advance(1_000);
    expect(slow()).toBe(true);
    expect(seen[0].signal.aborted).toBe(false);

    const result = await advanceUntilDone(pending);
    expect(result.ok && (await result.response.json())).toEqual({ ok: true });
    expect(slow()).toBe(false);
    expect(seen[0].signal.aborted).toBe(false);
});

it('aborts at the hard ceiling with a marked timeout error carrying the wall-clock elapsed time', async () => {
    server.use(endpoint('infinite'));

    const pending = outcome(instrumentedFetch(URL));
    await advance(REQUEST_ABORT_MS - 1_000);
    expect(slow()).toBe(true); // armed at 8s, request still running
    await advance(2_000);

    const result = await advanceUntilDone(pending);

    expect(result.ok).toBe(false);
    const error = (result as { error: Error }).error;
    expect(isRequestTimeoutError(error)).toBe(true);
    expect(requestElapsedMs(error)).toBeGreaterThanOrEqual(REQUEST_ABORT_MS);
    expect(requestElapsedMs(error)).toBeLessThan(REQUEST_ABORT_MS + 2_000);
    expect(requestElapsedMs(new Error('some other failure'))).toBeNull();
    expect(slow()).toBe(false); // the band is released by the abort
});

it('releases the slow bookkeeping when a slow request eventually fails', async () => {
    server.use(endpoint(SLOW_REQUEST_MS + 2_000, () => HttpResponse.error()));

    const pending = outcome(instrumentedFetch(URL));
    await advance(SLOW_REQUEST_MS + 500);
    expect(slow()).toBe(true);

    const result = await advanceUntilDone(pending);

    expect(result.ok).toBe(false);
    expect(isRequestTimeoutError((result as { error: Error }).error)).toBe(false);
    // The counter, not just the flag: a leaked count would pin the band on for the session.
    expect(slow()).toBe(false);
    server.use(endpoint(SLOW_REQUEST_MS + 1_000));
    const next = outcome(instrumentedFetch(URL));
    await advance(SLOW_REQUEST_MS + 500);
    expect(slow()).toBe(true);
    await advanceUntilDone(next);
    expect(slow()).toBe(false);
});

describe('a caller abort (unmount, tab switch)', () => {
    it('is not reported as a timeout, aborts the request underneath, and never arms the band', async () => {
        const seen = recordRequests();
        server.use(endpoint('infinite'));
        const controller = new AbortController();

        const pending = outcome(instrumentedFetch(URL, { signal: controller.signal }));
        await advance(100);
        controller.abort();
        const result = await advanceUntilDone(pending);

        expect(result.ok).toBe(false);
        expect(isRequestTimeoutError((result as { error: Error }).error)).toBe(false);
        expect(seen[0].signal.aborted).toBe(true);
        await advance(REQUEST_ABORT_MS + 5_000);
        expect(slow()).toBe(false);
    });

    it('an already-aborted signal rejects without a timeout marker', async () => {
        server.use(endpoint('infinite'));
        const controller = new AbortController();
        controller.abort();

        const result = await advanceUntilDone(outcome(instrumentedFetch(URL, { signal: controller.signal })));

        expect(result.ok).toBe(false);
        expect(isRequestTimeoutError((result as { error: Error }).error)).toBe(false);
    });
});
