// useRelatedPagination: server-ordered related coverage, 10 rows a page, over the real Apollo
// client and MSW. Pages are served by cursor: no cursor -> page 1, 'c1' -> page 2, 'c2' -> page 3.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { RELATED_PAGE_SIZE, useRelatedPagination } from '@/components/custom/news-detail/use-related-pagination';
import { delay, graphql, HttpResponse, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { quietLogger } from '../../core/sync/seed';

type Vars = Record<string, any>;
interface PageSpec {
    ids: string[];
    next: string | null;
    restarted?: boolean;
}

const summary = (id: string) => ({
    __typename: 'ArticleSummary',
    _id: id,
    title_en: `Title ${id}`,
    description_en: null,
    article_url: null,
    image_url: null,
    country_code: 'NLD',
    publication_name: 'Harbour Daily',
    language_code: 'en',
    pubDate: '2026-08-01T00:00:00.000Z',
});

const pageData = ({ ids, next, restarted = false }: PageSpec) => ({
    relatedArticlesPage: {
        __typename: 'RelatedArticlesPage',
        articles: ids.map(summary),
        pageInfo: { __typename: 'CursorPageInfo', endCursor: next, hasNextPage: next !== null, pageSize: ids.length },
        restarted,
    },
});

const PAGES: Record<string, PageSpec> = {
    first: { ids: ['a1', 'a2', 'a3'], next: 'c1' },
    c1: { ids: ['b1', 'b2'], next: 'c2' },
    c2: { ids: ['c1', 'c2'], next: null },
};

/** Serve `pages` by cursor and record every request's variables. */
function servePages(pages: Record<string, PageSpec | ((v: Vars) => Promise<PageSpec>)> = PAGES): Vars[] {
    const seen: Vars[] = [];
    server.use(
        // Not mockGql: a page may be answered late, and mockGql does not await its responder.
        graphql.operation(async ({ operationName, variables }) => {
            if (operationName !== 'GetRelatedArticlesPageFiltered') return undefined;
            seen.push(variables);
            const spec = pages[variables.after ?? 'first'];
            return HttpResponse.json({ data: pageData(typeof spec === 'function' ? await spec(variables) : spec) });
        }),
    );
    return seen;
}

interface Props {
    articleId: string | null;
    sortMode: 'relevance' | 'oldest' | 'newest';
    excludeIds?: string[];
    isConnected: boolean;
}
const BASE: Props = { articleId: 'art-1', sortMode: 'relevance', isConnected: true };

const mount = (props: Partial<Props> = {}) =>
    renderHook((p: Props) => useRelatedPagination({ ...p, ctx: null }), { initialProps: { ...BASE, ...props } });

const ids = (r: { result: { current: { entries: { _id: string }[] } } }) =>
    r.result.current.entries.map((e) => e._id);

/** Load page 1 then page 2. */
async function loadTwoPages(r: ReturnType<typeof mount>) {
    await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3']));
    await waitFor(() => expect(r.result.current.hasNextPage).toBe(true));
    act(() => r.result.current.loadMore());
    await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']));
}

describe('useRelatedPagination', () => {
    beforeEach(async () => {
        await signInFixtureAccount();
    });

    it('loads the first page, then loadMore appends the next', async () => {
        const seen = servePages();
        const r = mount();
        await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3']));
        expect(r.result.current.isLoadingInitial).toBe(false);
        expect(r.result.current.hasNextPage).toBe(true);
        expect(seen[0]).toMatchObject({ articleId: 'art-1', first: RELATED_PAGE_SIZE, after: null, sortMode: 'RELEVANCE' });

        act(() => r.result.current.loadMore());
        await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']));
        expect(seen[1]).toMatchObject({ after: 'c1' });
    });

    it('collapses a row served again on a later page by _id', async () => {
        servePages({ ...PAGES, c1: { ids: ['a3', 'b1'], next: null } });
        const r = mount();
        await waitFor(() => expect(r.result.current.hasNextPage).toBe(true));
        act(() => r.result.current.loadMore());
        await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1']));
    });

    it('stays idle with no article id and offline', async () => {
        const seen = servePages();
        const idle = mount({ articleId: null });
        const offline = mount({ isConnected: false });
        await act(async () => {});
        expect(seen).toHaveLength(0);
        expect(idle.result.current.entries).toEqual([]);
        expect(offline.result.current.entries).toEqual([]);
        expect(offline.result.current.isLoadingInitial).toBe(false);
    });

    it('replaces the list when a page answers restarted', async () => {
        servePages({ ...PAGES, c1: { ids: ['z1', 'z2'], next: null, restarted: true } });
        const r = mount();
        await waitFor(() => expect(r.result.current.hasNextPage).toBe(true));
        act(() => r.result.current.loadMore());
        await waitFor(() => expect(ids(r)).toEqual(['z1', 'z2']));
    });

    it('drops a page still in flight when the sort changes', async () => {
        let release!: () => void;
        const gate = new Promise<void>((res) => (release = res));
        const seen = servePages({
            first: { ids: ['a1', 'a2', 'a3'], next: 'c1' },
            // The page 2 of the OLD ordering: answered only after the sort has changed.
            c1: async () => {
                await gate;
                await delay(10);
                return { ids: ['stale1'], next: null };
            },
        });
        const r = mount();
        await waitFor(() => expect(r.result.current.hasNextPage).toBe(true));
        act(() => r.result.current.loadMore());
        await waitFor(() => expect(seen.map((v) => v.after)).toEqual([null, 'c1']));
        expect(r.result.current.isLoadingMore).toBe(true);

        // Sort change: the new ordering's page 1 arrives (its handler is the same `first` page).
        r.rerender({ ...BASE, sortMode: 'newest' });
        await waitFor(() => expect(seen).toHaveLength(3));
        expect(seen[2]).toMatchObject({ after: null, sortMode: 'NEWEST' });
        await waitFor(() => expect(r.result.current.isLoadingInitial).toBe(false));

        release();
        await act(async () => {
            await new Promise((res) => setTimeout(res, 150));
        });
        expect(ids(r)).toEqual(['a1', 'a2', 'a3']);
        expect(r.result.current.isLoadingMore).toBe(false);
    });

    describe('exclusion set', () => {
        it('refetches page 1 once when it goes from empty to non-empty', async () => {
            const seen = servePages();
            const r = mount({ excludeIds: [] });
            await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3']));
            expect(seen).toHaveLength(1);

            r.rerender({ ...BASE, excludeIds: ['x1', 'x2'] });
            await waitFor(() => expect(seen).toHaveLength(2));
            expect(seen[1]).toMatchObject({ after: null, excludeIds: ['x1', 'x2'] });
            await waitFor(() => expect(r.result.current.isLoadingInitial).toBe(false));

            // A new array with the same ids is not a change, and neither is a non-empty to non-empty move.
            r.rerender({ ...BASE, excludeIds: ['x2', 'x1'] });
            r.rerender({ ...BASE, excludeIds: ['x1', 'x2', 'x3'] });
            await act(async () => {
                await new Promise((res) => setTimeout(res, 100));
            });
            expect(seen).toHaveLength(2);
            expect(ids(r)).toEqual(['a1', 'a2', 'a3']);
        });

        it('does not refetch once a second page has loaded', async () => {
            const seen = servePages();
            const r = mount({ excludeIds: [] });
            await loadTwoPages(r);
            expect(seen).toHaveLength(2);

            r.rerender({ ...BASE, excludeIds: ['x1'] });
            await act(async () => {
                await new Promise((res) => setTimeout(res, 100));
            });
            expect(seen).toHaveLength(2);
            expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
        });
    });

    describe('failure', () => {
        let log: ReturnType<typeof quietLogger>;
        beforeEach(() => {
            log = quietLogger();
        });
        afterEach(() => log.restore());

        it('sets error when page 1 fails, and retry fetches page 1 again', async () => {
            server.use(mockGqlError('GetRelatedArticlesPageFiltered', 'INTERNAL_SERVER_ERROR'));
            const r = mount();
            await waitFor(() => expect(r.result.current.error).toBe(true));
            expect(r.result.current.entries).toEqual([]);
            expect(r.result.current.hasNextPage).toBe(false);

            servePages();
            act(() => r.result.current.retry());
            await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3']));
            expect(r.result.current.error).toBe(false);
        });

        it('keeps the rows on screen when page 2 fails, and retry fetches page 2', async () => {
            servePages();
            const r = mount();
            await waitFor(() => expect(r.result.current.hasNextPage).toBe(true));
            server.use(mockGqlError('GetRelatedArticlesPageFiltered', 'INTERNAL_SERVER_ERROR'));
            act(() => r.result.current.loadMore());
            await waitFor(() => expect(r.result.current.error).toBe(true));
            expect(ids(r)).toEqual(['a1', 'a2', 'a3']);

            const seen = servePages();
            act(() => r.result.current.retry());
            await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']));
            expect(seen.map((v) => v.after)).toEqual(['c1']);
        });
    });

    // FD3. startFromTop depends on isConnected and the reset effect depends on startFromTop, so
    // every connectivity flip wipes the pages and refetches page 1.
    describe('a connectivity blip', () => {
        async function blip() {
            const seen = servePages();
            const r = mount();
            await loadTwoPages(r);
            expect(seen.map((v) => v.after)).toEqual([null, 'c1']);
            r.rerender({ ...BASE, isConnected: false });
            const whileOffline = ids(r);
            r.rerender({ ...BASE, isConnected: true });
            await act(async () => {
                await new Promise((res) => setTimeout(res, 150));
            });
            return { r, seen, whileOffline };
        }

        test('a connectivity blip keeps the pages already loaded', async () => {
            const { r, seen, whileOffline } = await blip();
            expect(whileOffline).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
            expect(seen.map((v) => v.after)).toEqual([null, 'c1']);
            expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
        });

        test('opened offline, the first page loads once the device is back online', async () => {
            const seen = servePages();
            const r = mount({ isConnected: false });
            await act(async () => {});
            expect(seen).toHaveLength(0);
            r.rerender({ ...BASE, isConnected: true });
            await waitFor(() => expect(ids(r)).toEqual(['a1', 'a2', 'a3']));
            expect(seen.map((v) => v.after)).toEqual([null]);
        });
    });
});
