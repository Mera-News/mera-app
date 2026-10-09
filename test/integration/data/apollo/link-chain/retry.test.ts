// RetryLink end to end: what the real client re-sends after a failure, counted at the server.
import { ServerError } from '@apollo/client/errors';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, graphql, HttpResponse, mockGqlError, server, useFakeClock } from '@/test/helpers';
import { client, failOp, failureOf, PROBE, rawOp, recordRequests, resetLinkState, spyLogger } from './kit';

beforeEach(() => {
    resetLinkState();
    spyLogger();
    // Retry backoff is real timers in the app; the fake clock walks it without waiting.
    useFakeClock(Date.now());
});

const run = () => advanceUntilDone(failureOf(client.query({ query: PROBE, fetchPolicy: 'no-cache' })));
const status = (code: number) => rawOp('LinkProbe', () => new HttpResponse(null, { status: code }));

it('offline: one request and no retry', async () => {
    useNetworkStore.setState({ isConnected: false });
    const seen = recordRequests();
    server.use(failOp('LinkProbe'));
    expect(await run()).toBeTruthy();
    expect(seen).toHaveLength(1);
});

// RetryLink's `max: 3` counts the first attempt, so the request is sent 3 times, not 4. The
// comment beside it in apollo-client.ts says "3 retry attempts" (DATA-U4-3, owner's call which
// of the two is meant, so no test.failing). The tests below pin the 3.
const ATTEMPTS = 3;

it('online transport failure: retried until three attempts have been made', async () => {
    const seen = recordRequests();
    server.use(failOp('LinkProbe'));
    expect(await run()).toBeTruthy();
    expect(seen).toHaveLength(ATTEMPTS);
});

it.each([500, 502, 503])('online HTTP %i: retried until three attempts have been made', async (code) => {
    const seen = recordRequests();
    server.use(status(code));
    const err = await run();
    expect(ServerError.is(err)).toBe(true);
    expect(seen).toHaveLength(ATTEMPTS);
});

it('an HTML 5xx body is retried too', async () => {
    const seen = recordRequests();
    server.use(rawOp('LinkProbe', () => HttpResponse.html('<h1>502</h1>', { status: 502 })));
    expect(await run()).toBeTruthy();
    expect(seen).toHaveLength(ATTEMPTS);
});

it.each([400, 402, 404, 499])('HTTP %i: no retry', async (code) => {
    const seen = recordRequests();
    server.use(status(code));
    expect(ServerError.is(await run())).toBe(true);
    expect(seen).toHaveLength(1);
});

it('a GraphQL error inside an HTTP 200: no retry', async () => {
    const seen = recordRequests();
    server.use(mockGqlError('LinkProbe', 'INTERNAL_SERVER_ERROR'));
    expect(await run()).toBeTruthy();
    expect(seen).toHaveLength(1);
});

it('a retry that succeeds resolves the query with its data', async () => {
    let hits = 0;
    server.use(
        graphql.operation(({ operationName }) => {
            if (operationName !== 'LinkProbe') return undefined;
            hits += 1;
            return hits < 3 ? HttpResponse.error() : HttpResponse.json({ data: { probe: 'third time' } });
        }),
    );
    const result = await advanceUntilDone(client.query({ query: PROBE, fetchPolicy: 'no-cache' }));
    expect(result.data).toEqual({ probe: 'third time' });
    expect(hits).toBe(3);
});
