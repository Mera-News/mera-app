// With no own service stored, a feed sync, a chat leg and a star make exactly the requests the app made before own services existed.
jest.mock('expo-keep-awake', () => ({
    activateKeepAwakeAsync: jest.fn(async () => undefined),
    deactivateKeepAwake: jest.fn(),
}));

import { act, renderHook } from '@testing-library/react-native';
import { usePublicationRowPrefs } from '@/components/custom/publication-preferences/use-publication-row-prefs';
import { authClient } from '@/lib/auth-client';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { platform } from '@/lib/platform';
import { advanceUntilDone, initI18nEn, mockGql, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';
import { cleanupFeedSync, makeCtx, resetFeedSyncMemory, seedInterest, serveHydrate, servePersona } from './feed-sync/steps/support';
import { backgroundHooks, oid, settleMachine, startMachine } from './feed-sync/machine/support';

jest.setTimeout(60_000);

const MERA = '127.0.0.1:8790';

interface Seen {
    host: string;
    path: string;
    op: string;
    cookie: string | null;
}
/** Every request MSW sees, as (host, path, operation name for GraphQL). */
function recordAll() {
    const seen: Seen[] = [];
    const bodies: Promise<void>[] = [];
    const listener = ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const entry: Seen = { host: url.host, path: url.pathname, op: '', cookie: request.headers.get('cookie') };
        seen.push(entry);
        if (url.pathname.endsWith('/graphql')) {
            bodies.push(
                request
                    .clone()
                    .json()
                    .then((b: { operationName?: string }) => {
                        entry.op = b.operationName ?? '';
                    })
                    .catch(() => undefined),
            );
        }
    };
    server.events.on('request:start', listener);
    return {
        stop: () => server.events.removeListener('request:start', listener),
        all: async () => {
            await Promise.all(bodies);
            return seen;
        },
    };
}

beforeAll(initI18nEn);
beforeEach(() => {
    resetFeedSyncMemory();
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
});
afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
});

it('no own service stored: every request goes to Mera, GraphQL with the cookie, gateway on its usual routes', async () => {
    const quiet = quietLogger();
    await signInFixtureAccount();
    const cookie = authClient.getCookie();
    expect(cookie).toBeTruthy();
    useFakeClock(Date.now());
    await seedInterest('I follow racing', ['formula 1']);
    const ids = [oid(1), oid(2)];
    server.use(servePersona({ topics: { 'formula 1': ids } }), ...serveHydrate().handlers);
    const rec = recordAll();

    await advanceUntilDone(startMachine(makeCtx(), { background: backgroundHooks({ submit: false }).hooks }));

    const stream = cloudChatStream({ messages: [{ role: 'user', content: 'hi' }], route: 'topics', enableThinking: false });
    await advanceUntilDone(
        (async () => {
            for await (const _event of stream) void _event;
        })(),
    );

    jest.useRealTimers();
    // Mera knows this publication's names, so the star writes.
    server.use(
        mockGql('PublicationSourcesForNewsPublisher', {
            publicationSourcesForNewsPublisher: {
                __typename: 'PublicationSourcesForPublisherResponse',
                publicationSources: [{ __typename: 'PublicationSource', _id: 's1', publication_name: 'Der Spiegel' }],
            },
        }),
    );
    const { result } = await renderHook(() => usePublicationRowPrefs());
    await act(async () => {
        result.current.publisherRow({ publisherId: 'pub-1', rawName: 'Der Spiegel', countryCode: 'DEU' }).onStar();
    });
    await settleWrites();
    rec.stop();
    quiet.restore();
    // The star itself landed: a preferred row under the publication's names.
    const { getActive } = require('@/lib/database/services/publication-preference-service') as typeof import('@/lib/database/services/publication-preference-service');
    expect((await getActive()).length).toBeGreaterThan(0);

    const seen = await rec.all();
    expect([...new Set(seen.map((s) => s.host))]).toEqual([MERA]);
    const graphql = seen.filter((s) => s.path.endsWith('/graphql'));
    expect(graphql.length).toBeGreaterThan(0);
    for (const s of graphql) expect(s.cookie).toBe(cookie);
    expect([...new Set(graphql.map((s) => s.op))].sort()).toEqual(
        ['GetArticleIdsForPersona', 'GetArticlesForTopicsByIds', 'GetRecentArticleCount', 'PublicationSourcesForNewsPublisher'].sort(),
    );
    const gateway = seen.filter((s) => s.path.startsWith('/v1/'));
    expect([...new Set(gateway.map((s) => s.path))].sort()).toEqual(['/v1/chat/completions']);

    const host = platform('no-mode-requests');
    expect(host.llmTransport).toBeUndefined();
    expect('podCommand' in host).toBe(false);
});
