// Shared kit for the ArticleService seam tests: the real Apollo client against MSW, the logger edge
// spied, every operation the service sends recorded with its variables.
import { _getBreakerState, _resetForTests as resetAuthBreaker } from '@/lib/auth-failure-breaker';
import logger from '@/lib/logger';
import { _resetNetworkTrackingForTests, useNetworkStore } from '@/lib/stores/network-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { __resetExploreWindowSupport, __resetPublisherOrderSupport, __resetStoryKeySupport } from '@/lib/article-service';
import { graphql, HttpResponse, server } from '@/test/helpers';

export interface Sent {
    op: string;
    variables: Record<string, any>;
    /** The document text the client sent. */
    query: string;
}

const stops: (() => void)[] = [];
afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
});

/** Module-level memory (session flags, breaker, reachability) leaks across tests; call in beforeEach. */
export function resetServiceState(): void {
    __resetPublisherOrderSupport();
    __resetExploreWindowSupport();
    __resetStoryKeySupport();
    resetAuthBreaker();
    _resetNetworkTrackingForTests();
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
    useForYouStore.getState().setSyncStatusMessage(null);
}

/** Every GraphQL operation MSW receives from now on, with its variables. */
export function recordOps(): Sent[] {
    const sent: Sent[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        void request
            .clone()
            .json()
            .then((b: { operationName?: string; variables?: Record<string, any>; query?: string }) => {
                if (b.operationName) sent.push({ op: b.operationName, variables: b.variables ?? {}, query: b.query ?? '' });
            })
            .catch(() => undefined);
    };
    server.events.on('request:start', listener);
    stops.push(() => server.events.removeListener('request:start', listener));
    return sent;
}

/** The requests of one operation. Waits a few real ticks: the recorder parses bodies asynchronously. */
export async function sentOf(sent: Sent[], op?: string): Promise<Sent[]> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return op ? sent.filter((s) => s.op === op) : sent;
}

/** Spies on the logger edge: nothing reaches Sentry. */
export function spyLogger() {
    const spies = {
        capture: jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never),
        info: jest.spyOn(logger, 'info').mockImplementation(() => undefined as never),
        crumb: jest.spyOn(logger, 'addBreadcrumb'),
    };
    stops.push(() => Object.values(spies).forEach((s) => s.mockRestore()));
    return spies;
}

/**
 * The service only breadcrumbs; the Apollo error link already captured the failure. So a failing
 * query leaves at most the link's one event, and none that carries the service's own tag.
 */
export function expectNoServiceCapture(capture: jest.SpyInstance, linkEvents = 1): void {
    expect(capture).toHaveBeenCalledTimes(linkEvents);
    for (const call of capture.mock.calls) {
        expect(call[1]?.tags?.source).toBe('apollo-error-link');
        expect(call[1]?.tags?.service).toBeUndefined();
    }
}

export const breakerFailures = (): number => _getBreakerState().consecutiveFailures;

/** A transport failure for one operation. */
export const failOp = (operationName: string) =>
    graphql.operation(({ operationName: name }) => (name === operationName ? HttpResponse.error() : undefined));

/** A named article-with-clusters row in the shape `GetArticlesForTopicsByIds` selects. */
export const articleWithClusters = (id: string) => ({
    __typename: 'ArticleWithClusters',
    _id: id,
    clusters: [{ __typename: 'ClusterMembership', clusterId: 'c-1', confidence: 0.9, stableClusterId: 'sc-1' }],
    title_en: `Article ${id}`,
    title: `Article ${id}`,
    description_en: null,
    article_url: `https://example.com/${id}`,
    image_url: null,
    country_code: 'USA',
    publication_name: 'Pub',
    language_code: 'en',
    pubDate: '2024-01-01T00:00:00.000Z',
    geo_tags: [],
    entities: [],
    event_type: null,
    category: null,
    maxClusterSize: 1,
});
