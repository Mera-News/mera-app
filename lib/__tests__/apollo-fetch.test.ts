// instrumentedFetch — the slow/abort split.
//
// The property that matters and is easy to get wrong: the 8s "slow" threshold
// must arm the band WITHOUT touching the request, so a terrible-but-working
// network still succeeds. A single abort-style timeout would kill a request at
// 15s that would have completed at 20s, which makes the very case the user
// reported ("can be in a terrible network — doesn't matter") worse, not better.
import {
    instrumentedFetch,
    isRequestTimeoutError,
    requestElapsedMs,
    REQUEST_ABORT_MS,
    SLOW_REQUEST_MS,
} from '@/lib/apollo-fetch';
import {
    _resetNetworkTrackingForTests,
    useNetworkStore,
} from '@/lib/stores/network-store';

describe('instrumentedFetch', () => {
    let realFetch: typeof global.fetch;

    beforeEach(() => {
        jest.useFakeTimers();
        realFetch = global.fetch;
        useNetworkStore.setState({
            isConnected: true,
            serverReachable: true,
            serverSlow: false,
        });
        _resetNetworkTrackingForTests();
    });

    afterEach(() => {
        global.fetch = realFetch;
        jest.useRealTimers();
    });

    it('thresholds are ordered slow < abort (a slow request gets a chance to finish)', () => {
        expect(SLOW_REQUEST_MS).toBeLessThan(REQUEST_ABORT_MS);
    });

    it('does not arm the band for a fast response', async () => {
        global.fetch = jest.fn().mockResolvedValue({ status: 200 } as Response);

        await instrumentedFetch('http://x/graphql');

        expect(useNetworkStore.getState().serverSlow).toBe(false);
    });

    it('arms the band at the slow threshold but LEAVES THE REQUEST RUNNING', async () => {
        let resolveFetch: (v: unknown) => void = () => {};
        const aborted: boolean[] = [];
        global.fetch = jest.fn((_input, init?: RequestInit) => {
            init?.signal?.addEventListener('abort', () => aborted.push(true));
            return new Promise((res) => {
                resolveFetch = res;
            });
        }) as unknown as typeof fetch;

        const pending = instrumentedFetch('http://x/graphql');

        // Just before the threshold: nothing has happened yet.
        jest.advanceTimersByTime(SLOW_REQUEST_MS - 1);
        expect(useNetworkStore.getState().serverSlow).toBe(false);

        // Crossing it arms the band...
        jest.advanceTimersByTime(1);
        expect(useNetworkStore.getState().serverSlow).toBe(true);
        // ...and critically does NOT abort. This is the whole point of the split.
        expect(aborted).toHaveLength(0);

        // The slow request then succeeds, and the band clears.
        resolveFetch({ status: 200 });
        await pending;
        expect(useNetworkStore.getState().serverSlow).toBe(false);
        expect(aborted).toHaveLength(0);
    });

    it('a slow response is still delivered to the caller, not swallowed', async () => {
        let resolveFetch: (v: unknown) => void = () => {};
        global.fetch = jest.fn(
            () =>
                new Promise((res) => {
                    resolveFetch = res;
                }),
        ) as unknown as typeof fetch;

        const pending = instrumentedFetch('http://x/graphql');
        jest.advanceTimersByTime(SLOW_REQUEST_MS + 5_000);

        const payload = { status: 200, ok: true };
        resolveFetch(payload);
        await expect(pending).resolves.toBe(payload);
    });

    it('aborts at the hard ceiling with a MARKED timeout error', async () => {
        global.fetch = jest.fn((_input, init?: RequestInit) => {
            return new Promise((_res, rej) => {
                init?.signal?.addEventListener('abort', () =>
                    rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
                );
            });
        }) as unknown as typeof fetch;

        const pending = instrumentedFetch('http://x/graphql');
        jest.advanceTimersByTime(REQUEST_ABORT_MS);

        let caught: unknown;
        try {
            await pending;
        } catch (e) {
            caught = e;
        }
        // The marker is load-bearing: a cancellation (unmount / tab switch)
        // produces the same "no statusCode" shape, and counting those would let
        // ordinary navigation fake a server outage.
        expect(isRequestTimeoutError(caught)).toBe(true);
        // Elapsed is measured, not assumed to equal REQUEST_ABORT_MS: a request
        // that dies early and one that rides the full ceiling must be
        // distinguishable in Sentry, which is the whole reason this is carried.
        expect(requestElapsedMs(caught)).toBeGreaterThanOrEqual(REQUEST_ABORT_MS);
        expect(requestElapsedMs(new Error('some other failure'))).toBeNull();
    });

    it('releases the slow bookkeeping when a slow request eventually FAILS', async () => {
        let rejectFetch: (e: unknown) => void = () => {};
        global.fetch = jest.fn(
            () =>
                new Promise((_res, rej) => {
                    rejectFetch = rej;
                }),
        ) as unknown as typeof fetch;

        const pending = instrumentedFetch('http://x/graphql');
        jest.advanceTimersByTime(SLOW_REQUEST_MS);
        expect(useNetworkStore.getState().serverSlow).toBe(true);

        rejectFetch(new Error('socket closed'));
        await expect(pending).rejects.toThrow('socket closed');
        // Not just the flag — the counter must have been decremented too, or the
        // band pins on for the rest of the session.
        expect(useNetworkStore.getState().serverSlow).toBe(false);
    });

    it('a caller abort (unmount / tab switch) is NOT reported as a timeout', async () => {
        const controller = new AbortController();
        global.fetch = jest.fn((_input, init?: RequestInit) => {
            return new Promise((_res, rej) => {
                init?.signal?.addEventListener('abort', () =>
                    rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
                );
            });
        }) as unknown as typeof fetch;

        const pending = instrumentedFetch('http://x/graphql', { signal: controller.signal });
        controller.abort();

        let caught: unknown;
        try {
            await pending;
        } catch (e) {
            caught = e;
        }
        expect(isRequestTimeoutError(caught)).toBe(false);
    });
});
