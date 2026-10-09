// RetryLink end to end: what the real client re-sends after a failure, counted at the server.
import { ServerError } from '@apollo/client/errors';
import type { RequestHandler } from 'msw';
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

// DA6 (owner ruling): a transport or 5xx failure must be sent 4 times, the first plus 3 retries.
// RetryLink's `max: 3` counts the first attempt, so today the request is sent 3 times. Each shape
// below is a test.failing that expects the intended 4, beside a passing sibling that pins today's 3
// (R14). P3 sets `attempts.max` to 4, flips the failing tests and deletes the siblings.
const INTENDED_SENDS = 4;
const TODAY_SENDS = 3;

const shapes: [string, () => RequestHandler, ((err: unknown) => void) | null][] = [
    ['transport failure', () => failOp('LinkProbe'), null],
    ['HTTP 500', () => status(500), (err) => expect(ServerError.is(err)).toBe(true)],
    ['HTTP 502', () => status(502), (err) => expect(ServerError.is(err)).toBe(true)],
    ['HTTP 503', () => status(503), (err) => expect(ServerError.is(err)).toBe(true)],
    ['an HTML 502 body', () => rawOp('LinkProbe', () => HttpResponse.html('<h1>502</h1>', { status: 502 })), null],
];

describe.each(shapes)('online %s', (_name, handler, checkError) => {
    async function sends(): Promise<number> {
        const seen = recordRequests();
        server.use(handler());
        const err = await run();
        expect(err).toBeTruthy();
        checkError?.(err);
        return seen.length;
    }

    test.failing('DA6: is sent 4 times, the first attempt plus 3 retries', async () => {
        expect(await sends()).toBe(INTENDED_SENDS);
    });

    it('DA6 today: is sent 3 times (RetryLink max counts the first attempt)', async () => {
        expect(await sends()).toBe(TODAY_SENDS);
    });
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
