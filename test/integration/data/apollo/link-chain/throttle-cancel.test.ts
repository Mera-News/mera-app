// B2: cancelling a query while its throttle re-send is in flight. The Observable the throttle
// branches return only clears its timer on teardown; the inner `forward(operation).subscribe(...)`
// is never unsubscribed, so a query cancelled AFTER the timer fired keeps its re-sent request
// running (apollo-client.ts, both throttle branches).
import { delay, graphql, HttpResponse, server, useFakeClock } from '@/test/helpers';
import { client, PROBE, recordRequests, resetLinkState, spyLogger, THROTTLE_SHAPES, type ThrottleShape } from './kit';

// The HTML body takes the same branch as the empty body; it is not repeated here.
const SHAPES = THROTTLE_SHAPES.filter((s) => !s.includes('HTML'));

beforeEach(() => {
    resetLinkState();
    spyLogger();
    useFakeClock(Date.now());
});

const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) await jest.advanceTimersByTimeAsync(50);
};

/** First hit throttled in `shape` with Retry-After: 1; later hits take 10s to answer. Returns the answer counter. */
function throttledThenSlow(shape: ThrottleShape) {
    const state = { hits: 0, answered: 0 };
    server.use(
        graphql.operation(async ({ operationName }) => {
            if (operationName !== 'LinkProbe') return undefined;
            state.hits += 1;
            if (state.hits === 1) {
                const headers = { 'Retry-After': '1' };
                if (shape === 'HTTP 429 with an empty body') return new HttpResponse(null, { status: 429, headers });
                return HttpResponse.json(
                    { errors: [{ message: 'slow down', extensions: { code: 'TOO_MANY_REQUESTS' } }] },
                    { status: shape === 'graphql error in a 200' ? 200 : 429, headers },
                );
            }
            await delay(10_000);
            state.answered += 1;
            return HttpResponse.json({ data: { probe: 'late' } });
        }),
    );
    return state;
}

/** Subscribes, lets the re-send start, then cancels. Returns what the server saw. */
async function cancelAfterResend(shape: ThrottleShape) {
    const seen = recordRequests();
    const state = throttledThenSlow(shape);
    const delivered: unknown[] = [];
    const sub = client.watchQuery({ query: PROBE, fetchPolicy: 'no-cache' }).subscribe({
        next: (r) => delivered.push(r),
        error: (e) => delivered.push(e),
    });
    await advance(2000);
    expect(seen).toHaveLength(2); // the re-send is under way
    sub.unsubscribe();
    await advance(100);
    return { seen, state };
}

describe('control: a plain query', () => {
    it('cancelling it aborts its request, so the signal check below can fail', async () => {
        const seen = recordRequests();
        server.use(
            graphql.operation(async ({ operationName }) => {
                if (operationName !== 'LinkProbe') return undefined;
                await delay(10_000);
                return HttpResponse.json({ data: { probe: 'late' } });
            }),
        );
        const sub = client.watchQuery({ query: PROBE, fetchPolicy: 'no-cache' }).subscribe({ next: () => {}, error: () => {} });
        await advance(500);
        expect(seen[0].signal.aborted).toBe(false);
        sub.unsubscribe();
        await advance(100);
        expect(seen[0].signal.aborted).toBe(true);
    });
});

describe.each(SHAPES)('cancelled after the re-send started, throttle as %s', (shape) => {
    it('B2: the re-sent request is aborted', async () => {
        const { seen } = await cancelAfterResend(shape);
        expect(seen[1].signal.aborted).toBe(true);
    });
});

describe('cancelled while still waiting', () => {
    it.each(SHAPES)('throttle as %s: the re-send never goes out', async (shape) => {
        const seen = recordRequests();
        throttledThenSlow(shape);
        const sub = client.watchQuery({ query: PROBE, fetchPolicy: 'no-cache' }).subscribe({ next: () => {}, error: () => {} });
        await advance(500); // inside the 1s wait
        expect(seen).toHaveLength(1);
        sub.unsubscribe();
        await advance(3000);
        expect(seen).toHaveLength(1);
    });
});
