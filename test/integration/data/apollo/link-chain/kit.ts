// Shared driving kit for the Apollo link-chain seam tests: the real client against MSW.
import { gql } from '@apollo/client';
import { _resetForTests as resetAuthBreaker } from '@/lib/auth-failure-breaker';
import { __resetIdentityFaultForTests } from '@/lib/security/identity-gate';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { _resetNetworkTrackingForTests, useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import client from '@/lib/apollo-client';
import logger from '@/lib/logger';
import { graphql, http, HttpResponse, server } from '@/test/helpers';

export { client };

/** An operation with a name only this suite uses; every test points a handler at it. */
export const PROBE = gql`
    query LinkProbe {
        probe
    }
`;

/** A second named operation, for tests that need two distinct operations in flight. */
export const OTHER = gql`
    query LinkOther {
        other
    }
`;

/** Module-level memory in the app (breaker, reachability counters, ownership latch) leaks across tests. */
export function resetLinkState(): void {
    resetAuthBreaker();
    _resetNetworkTrackingForTests();
    __resetIdentityFaultForTests();
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
    useUserStore.setState({ needsReauth: false });
    useForYouStore.getState().setSyncStatusMessage(null);
}

export interface Seen {
    op: string;
    /** Date.now() when MSW received it: fake time under useFakeClock. */
    at: number;
    headers: Headers;
    signal: AbortSignal;
}

/** Every GraphQL request MSW receives from now on. Stops itself after the test. */
export function recordRequests(): Seen[] {
    const seen: Seen[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        const entry: Seen = { op: '', at: Date.now(), headers: request.headers, signal: request.signal };
        seen.push(entry);
        void request
            .clone()
            .json()
            .then((b: { operationName?: string }) => {
                entry.op = b.operationName ?? '';
            })
            .catch(() => undefined); // not a GraphQL POST
    };
    server.events.on('request:start', listener);
    afterEachStops.push(() => server.events.removeListener('request:start', listener));
    return seen;
}
const afterEachStops: (() => void)[] = [];
afterEach(() => {
    afterEachStops.splice(0).forEach((stop) => stop());
});

/** Answers one named operation with any Response (a plain-text 401, an HTML 502); other operations fall through.
 *  Use it for non-JSON bodies: see throttleThenData. */
export const rawOp = (operationName: string, respond: () => Response) =>
    http.post('*/graphql', async ({ request }) => {
        const body = (await request.clone().json().catch(() => ({}))) as { operationName?: string };
        return body.operationName === operationName ? respond() : undefined;
    });

/** A transport failure for one operation. */
export const failOp = (operationName: string) =>
    graphql.operation(({ operationName: name }) => (name === operationName ? HttpResponse.error() : undefined));

/** Runs the probe through the real client and resolves to the rejection (or null). */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => null,
        (e: unknown) => e ?? new Error('rejected with nothing'),
    );
}

/** Spies on the logger edge (nothing reaches Sentry). Restored after the test. */
export function spyLogger() {
    const spies = {
        capture: jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never),
        message: jest.spyOn(logger, 'captureMessage').mockImplementation(() => undefined as never),
        crumb: jest.spyOn(logger, 'addBreadcrumb'),
    };
    afterEachStops.push(() => Object.values(spies).forEach((s) => s.mockRestore()));
    return spies;
}

/** Breadcrumb messages recorded so far. */
export const crumbs = (crumb: jest.SpyInstance) => crumb.mock.calls.map((c) => c[0] as string);

export type ThrottleShape =
    | 'graphql error in a 200'
    | 'HTTP 429 with a GraphQL body'
    | 'HTTP 429 with an empty body'
    | 'HTTP 429 with an HTML body';
export const THROTTLE_SHAPES: ThrottleShape[] = [
    'graphql error in a 200',
    'HTTP 429 with a GraphQL body',
    'HTTP 429 with an empty body',
    'HTTP 429 with an HTML body',
];

/** LinkProbe answers `throttledFirst` times with a throttle in the given shape, then with data. */
export function throttleThenData(shape: ThrottleShape, headers: Record<string, string> = {}, throttledFirst = Infinity) {
    let hits = 0;
    return rawOp('LinkProbe', () => {
        hits += 1;
        if (hits > throttledFirst) return HttpResponse.json({ data: { probe: 'finally' } });
        // Empty and HTML bodies reach the link as a ServerError. They go through rawOp, not
        // graphql.operation: MSW's GraphQL handler stamps a JSON content type on the reply, which
        // turns a non-JSON body into a ServerParseError that no real edge response produces.
        if (shape === 'HTTP 429 with an empty body') return new HttpResponse(null, { status: 429, headers });
        if (shape === 'HTTP 429 with an HTML body') {
            return HttpResponse.html('<h1>429 Too Many Requests</h1>', { status: 429, headers });
        }
        return HttpResponse.json(
            { errors: [{ message: 'slow down', extensions: { code: 'TOO_MANY_REQUESTS' } }] },
            { status: shape === 'graphql error in a 200' ? 200 : 429, headers },
        );
    });
}

/** How many recorded requests carried operation `op`. Waits a few real ticks: the body is parsed asynchronously. */
export async function countOps(seen: Seen[], op: string): Promise<number> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return seen.filter((s) => s.op === op).length;
}
