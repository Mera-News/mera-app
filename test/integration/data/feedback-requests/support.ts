// Shared by the feedback-request library seam tests: a GraphQL request recorder, a logger spy, the
// network latch reset, server list builders and plain snapshots of the drawer rows. Not a test file.
import { getAll as getAllNotifications } from '@/lib/database/services/notification-service';
import logger from '@/lib/logger';
import { _resetNetworkTrackingForTests, useNetworkStore } from '@/lib/stores/network-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { graphql, HttpResponse, mockGql, server } from '@/test/helpers';

export const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;

export interface Sent {
    op: string;
    variables: Record<string, any>;
}

const stops: (() => void)[] = [];
afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
});

/** Every GraphQL operation the app sends from now on, with its variables. Stops after the test. */
export function recordOps(): Sent[] {
    const sent: Sent[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        void request
            .clone()
            .json()
            .then((b: { operationName?: string; variables?: Record<string, any> }) => {
                if (b.operationName) sent.push({ op: b.operationName, variables: b.variables ?? {} });
            })
            .catch(() => undefined);
    };
    server.events.on('request:start', listener);
    stops.push(() => server.events.removeListener('request:start', listener));
    return sent;
}
export const opsNamed = (sent: Sent[], op: string) => sent.filter((s) => s.op === op);

/** Waits a few real ticks: the recorder parses bodies asynchronously. */
export async function settleRecorder(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Restores a spy on a real object after the test, so the next test's spy wraps the original. */
export function restoreAfterTest<T extends jest.SpyInstance>(spy: T): T {
    stops.push(() => spy.mockRestore());
    return spy;
}

/** The logger edge: capture and breadcrumb spied (nothing reaches Sentry), restored after the test. */
export function spyLogger() {
    const spies = {
        capture: jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never),
        crumb: jest.spyOn(logger, 'addBreadcrumb'),
    };
    stops.push(() => Object.values(spies).forEach((s) => s.mockRestore()));
    return spies;
}
export const crumbMessages = (crumb: jest.SpyInstance) => crumb.mock.calls.map((c) => c[0] as string);

/** Module memory the per-test reset leaves behind: the reachability latch and the sync banner. */
export function resetNetworkAndBanner(): void {
    _resetNetworkTrackingForTests();
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
    useForYouStore.getState().setSyncStatusMessage(null);
}
export const banner = () => useForYouStore.getState().syncStatusMessage;
export const setDeviceLink = (isConnected: boolean) => useNetworkStore.setState({ isConnected });

export const view = (id: string, over: Record<string, unknown> = {}) => ({
    __typename: 'FeedbackRequestView',
    id,
    question: 'What should we build next?',
    endsAt: new Date(NOW + HOUR).toISOString(),
    createdAt: new Date(NOW - HOUR).toISOString(),
    answered: false,
    ...over,
});
/** The server's live list for this test. */
export const serverList = (...views: ReturnType<typeof view>[]) =>
    mockGql('ActiveFeedbackRequests', { activeFeedbackRequests: views });
export const failOp = (operationName: string) =>
    graphql.operation(({ operationName: name }) => (name === operationName ? HttpResponse.error() : undefined));

/** The ingest input shape (what fetchActiveFeedbackRequests returns), for the tests that skip the network. */
export const req = (id: string, over: Partial<{ question: string; endsAt: number; answered: boolean }> = {}) => ({
    id,
    question: 'Q?',
    endsAt: NOW + HOUR,
    answered: false,
    ...over,
});

/** The drawer rows as plain objects, in source order, so no matcher sees a model. */
export async function drawerRows() {
    return (await getAllNotifications())
        .filter((n) => n.type === 'feedback_request')
        .map((n) => ({
            source: n.source,
            title: n.title,
            body: n.body,
            icon: n.icon,
            status: n.status,
            context: JSON.parse(n.contextJson ?? 'null'),
        }))
        .sort((a, b) => a.source.localeCompare(b.source));
}
