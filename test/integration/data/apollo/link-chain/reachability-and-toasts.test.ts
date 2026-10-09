// The server-reachability latch and the network-error toast, driven by real failures through the
// real client. One failed OPERATION counts once: the error link sits above the retry link.
import { toastManager } from '@/lib/toast-manager';
import { useNetworkStore } from '@/lib/stores/network-store';
import {
    advanceUntilDone,
    delay,
    graphql,
    HttpResponse,
    mockGql,
    mockGqlError,
    server,
    useFakeClock,
} from '@/test/helpers';
import { client, crumbs, OTHER, rawOp, failOp, failureOf, PROBE, recordRequests, resetLinkState, spyLogger } from './kit';

let toast: jest.SpyInstance;
beforeEach(() => {
    resetLinkState();
    useFakeClock(Date.now());
    toast = jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});
});
afterEach(() => toast.mockRestore());

const query = () => client.query({ query: PROBE, fetchPolicy: 'no-cache' });
// 30s timeouts retried three times need minutes of fake time; coarse steps keep it fast.
const settle = <T>(p: Promise<T>) => advanceUntilDone(p, 600_000, 500);
const reachable = () => useNetworkStore.getState().serverReachable;
const status = (code: number) => rawOp('LinkProbe', () => new HttpResponse(null, { status: code }));

describe('the latch', () => {
    it('needs two consecutive failed operations before declaring the server down', async () => {
        spyLogger();
        server.use(failOp('LinkProbe'));

        await settle(failureOf(query()));
        expect(reachable()).toBe(true); // one failed operation is a blip

        await settle(failureOf(query()));
        expect(reachable()).toBe(false);
    });

    it('a 5xx counts as evidence the server is down', async () => {
        spyLogger();
        server.use(status(503));
        await settle(failureOf(query()));
        await settle(failureOf(query()));
        expect(reachable()).toBe(false);
    });

    it('a 4xx proves the server answered, however often it happens', async () => {
        spyLogger();
        server.use(status(404));
        await settle(failureOf(query()));
        await settle(failureOf(query()));
        await settle(failureOf(query()));
        expect(reachable()).toBe(true);
    });

    it('our own 30s timeout counts, and is reported as a timeout with its elapsed time', async () => {
        const logs = spyLogger();
        server.use(
            graphql.operation(async ({ operationName }) => {
                if (operationName !== 'LinkProbe' && operationName !== 'LinkOther') return undefined;
                await delay('infinite');
                return undefined;
            }),
        );

        await settle(Promise.all([failureOf(query()), failureOf(client.query({ query: OTHER, fetchPolicy: 'no-cache' }))]));

        expect(reachable()).toBe(false);
        const options = logs.capture.mock.calls.map(
            (c) => c[1] as { tags: Record<string, string>; extra: { elapsedMs: number } },
        );
        expect(options.map((o) => o.tags.operation).sort()).toEqual(['LinkOther', 'LinkProbe']);
        for (const o of options) {
            expect(o.tags).toMatchObject({ source: 'apollo-error-link', type: 'network', timeout: 'true' });
            expect(o.extra.elapsedMs).toBeGreaterThanOrEqual(30_000);
        }
    });

    it('an AbortError with no timeout marker does not count, so navigation cannot fake an outage', async () => {
        // The one fault MSW cannot produce: fetch itself rejecting with an AbortError (R23, one
        // call each). Three operations of three attempts each.
        spyLogger();
        const failFetch = jest.spyOn(globalThis, 'fetch');
        for (let i = 0; i < 9; i++) {
            failFetch.mockRejectedValueOnce(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        }
        for (let i = 0; i < 3; i++) {
            const err = (await settle(failureOf(query()))) as { name?: string; isRequestTimeout?: boolean };
            expect(err.name).toBe('AbortError');
        }
        failFetch.mockRestore();
        expect(reachable()).toBe(true);
    });

    it('unsubscribing does not count either, and reports nothing', async () => {
        const logs = spyLogger();
        server.use(
            graphql.operation(async ({ operationName }) => {
                if (operationName !== 'LinkProbe') return undefined;
                await delay('infinite');
                return undefined;
            }),
        );
        for (let i = 0; i < 3; i++) {
            const sub = client.watchQuery({ query: PROBE, fetchPolicy: 'no-cache' }).subscribe({ next: () => {}, error: () => {} });
            await jest.advanceTimersByTimeAsync(100);
            sub.unsubscribe();
            await jest.advanceTimersByTimeAsync(1000);
        }
        expect(reachable()).toBe(true);
        expect(logs.capture).not.toHaveBeenCalled();
    });

    it.each([
        ['a successful response', mockGql('LinkProbe', { probe: 'ok' }), false],
        ['a GraphQL error in a 200', mockGqlError('LinkProbe', 'BAD_USER_INPUT'), true],
        ['a 404', status(404), true],
    ])('recovers the moment the server answers: %s', async (_name, handler, rejects) => {
        spyLogger();
        useNetworkStore.setState({ serverReachable: false });
        server.use(handler);

        const err = await settle(failureOf(query()));

        expect(err !== null).toBe(rejects);
        expect(reachable()).toBe(true);
    });
});

describe('the network-error toast and the capture', () => {
    it('known offline: no toast, no capture, a breadcrumb instead, and no retry', async () => {
        const logs = spyLogger();
        const seen = recordRequests();
        useNetworkStore.setState({ isConnected: false });
        server.use(failOp('LinkProbe'));

        await settle(failureOf(query()));

        expect(toast).not.toHaveBeenCalled();
        expect(logs.capture).not.toHaveBeenCalled();
        expect(crumbs(logs.crumb)).toContain('Network error while offline — Sentry capture suppressed');
        expect(seen).toHaveLength(1);
    });

    it('online and reachable: one toast and one capture for a failed operation', async () => {
        const logs = spyLogger();
        server.use(failOp('LinkProbe'));

        await settle(failureOf(query()));

        expect(toast).toHaveBeenCalledTimes(1);
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(logs.capture.mock.calls[0][1]).toMatchObject({ tags: { type: 'network', timeout: 'false' } });
    });

    it('once the server is known unreachable the toast stops, the capture does not', async () => {
        const logs = spyLogger();
        useNetworkStore.setState({ serverReachable: false });
        server.use(failOp('LinkProbe'));

        await settle(failureOf(query()));

        expect(toast).not.toHaveBeenCalled();
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });

    it('an isConnected that is not a boolean is reported, not suppressed', async () => {
        // The gate is `=== false`: a not-yet-seeded value must fall on the report side.
        const logs = spyLogger();
        useNetworkStore.setState({ isConnected: undefined as unknown as boolean });
        server.use(failOp('LinkProbe'));

        await settle(failureOf(query()));

        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(toast).not.toHaveBeenCalled();
    });
});
