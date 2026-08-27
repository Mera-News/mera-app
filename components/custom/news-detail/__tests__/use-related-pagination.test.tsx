import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useRelatedPagination, RELATED_PAGE_SIZE } from '../use-related-pagination';
import { ArticleService } from '@/lib/article-service';
import { RelatedSortMode as GqlRelatedSortMode } from '@/lib/generated/graphql-types';
import type { ArticleSummary } from '@/lib/generated/graphql-types';

jest.mock('@/lib/article-service', () => ({
    ArticleService: { getRelatedArticlesPage: jest.fn() },
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

const getPage = ArticleService.getRelatedArticlesPage as jest.Mock;

function row(id: string): ArticleSummary {
    return {
        _id: id,
        title_en: `Title ${id}`,
        pubDate: '2024-01-01T00:00:00Z',
    } as ArticleSummary;
}

function page(ids: string[], over: Record<string, unknown> = {}) {
    return {
        articles: ids.map(row),
        pageInfo: {
            endCursor: ids.length ? ids[ids.length - 1] : null,
            hasNextPage: true,
            pageSize: ids.length,
        },
        restarted: false,
        ...over,
    };
}

const BASE = {
    articleId: 'art-1',
    sortMode: 'relevance' as const,
    ctx: null,
    isConnected: true,
};

beforeEach(() => jest.clearAllMocks());

describe('useRelatedPagination', () => {
    it('loads the first page of 10 on mount', async () => {
        getPage.mockResolvedValue(page(['a', 'b']));

        const { result } = renderHook(() => useRelatedPagination(BASE));

        await waitFor(() => expect(result.current.entries).toHaveLength(2));
        expect(getPage).toHaveBeenCalledWith(
            expect.objectContaining({
                articleId: 'art-1',
                first: RELATED_PAGE_SIZE,
                after: null,
                sortMode: GqlRelatedSortMode.Relevance,
            }),
        );
        expect(result.current.isLoadingInitial).toBe(false);
        expect(result.current.hasNextPage).toBe(true);
    });

    it('appends the next page and advances the cursor', async () => {
        getPage.mockResolvedValueOnce(page(['a', 'b']));
        const { result } = renderHook(() => useRelatedPagination(BASE));
        await waitFor(() => expect(result.current.entries).toHaveLength(2));

        getPage.mockResolvedValueOnce(page(['c', 'd']));
        act(() => result.current.loadMore());

        await waitFor(() => expect(result.current.entries).toHaveLength(4));
        expect(result.current.entries.map((e) => e._id)).toEqual(['a', 'b', 'c', 'd']);
        expect(getPage).toHaveBeenLastCalledWith(
            expect.objectContaining({ after: 'b' }),
        );
    });

    it('stops paging once hasNextPage is false', async () => {
        getPage.mockResolvedValue(
            page(['a'], { pageInfo: { endCursor: 'a', hasNextPage: false, pageSize: 1 } }),
        );
        const { result } = renderHook(() => useRelatedPagination(BASE));
        await waitFor(() => expect(result.current.entries).toHaveLength(1));

        act(() => result.current.loadMore());
        act(() => result.current.loadMore());

        expect(getPage).toHaveBeenCalledTimes(1);
    });

    it('REPLACES rather than appends when the server reports a restart', async () => {
        getPage.mockResolvedValueOnce(page(['a', 'b']));
        const { result } = renderHook(() => useRelatedPagination(BASE));
        await waitFor(() => expect(result.current.entries).toHaveLength(2));

        // The cursor stopped resolving server-side (re-clustering / cache
        // expiry), so this page starts at the top again. Appending it would
        // stack a second copy of page 1 under the rows already on screen.
        getPage.mockResolvedValueOnce(page(['a', 'b'], { restarted: true }));
        act(() => result.current.loadMore());

        await waitFor(() =>
            expect(getPage).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'b' })),
        );
        await waitFor(() => expect(result.current.entries).toHaveLength(2));
        expect(result.current.entries.map((e) => e._id)).toEqual(['a', 'b']);
    });

    it('resets to page 1 when the sort mode changes', async () => {
        getPage.mockResolvedValue(page(['a', 'b']));
        const { result, rerender } = renderHook(
            (props: { sortMode: 'relevance' | 'newest' }) =>
                useRelatedPagination({ ...BASE, sortMode: props.sortMode }),
            { initialProps: { sortMode: 'relevance' as const } },
        );
        await waitFor(() => expect(result.current.entries).toHaveLength(2));

        getPage.mockResolvedValue(page(['x', 'y']));
        rerender({ sortMode: 'newest' });

        await waitFor(() =>
            expect(result.current.entries.map((e) => e._id)).toEqual(['x', 'y']),
        );
        expect(getPage).toHaveBeenLastCalledWith(
            expect.objectContaining({ after: null, sortMode: GqlRelatedSortMode.Newest }),
        );
    });

    it('discards a page still in flight from the previous sort', async () => {
        let resolveStale: (v: unknown) => void = () => undefined;
        getPage.mockImplementationOnce(
            () => new Promise((res) => { resolveStale = res; }),
        );
        const { result, rerender } = renderHook(
            (props: { sortMode: 'relevance' | 'newest' }) =>
                useRelatedPagination({ ...BASE, sortMode: props.sortMode }),
            { initialProps: { sortMode: 'relevance' as const } },
        );

        getPage.mockResolvedValue(page(['x']));
        rerender({ sortMode: 'newest' });
        await waitFor(() => expect(result.current.entries).toHaveLength(1));

        // The old sort's page lands late. Its rows belong to a different
        // ordering entirely, so it must not interleave.
        await act(async () => {
            resolveStale(page(['a', 'b']));
        });

        expect(result.current.entries.map((e) => e._id)).toEqual(['x']);
    });

    it('stays idle offline, and never queries an unresolved article id', async () => {
        const { result, rerender } = renderHook(
            (props: { articleId: string | null; isConnected: boolean }) =>
                useRelatedPagination({ ...BASE, ...props }),
            { initialProps: { articleId: null, isConnected: true } },
        );
        expect(getPage).not.toHaveBeenCalled();

        rerender({ articleId: 'art-1', isConnected: false });
        expect(getPage).not.toHaveBeenCalled();
        expect(result.current.isLoadingInitial).toBe(false);
    });

    it('stops paging after a failure instead of retrying on every scroll tick', async () => {
        getPage.mockRejectedValueOnce(new Error('network down'));
        const { result } = renderHook(() => useRelatedPagination(BASE));

        await waitFor(() => expect(result.current.isLoadingInitial).toBe(false));
        expect(result.current.hasNextPage).toBe(false);
        act(() => result.current.loadMore());
        expect(getPage).toHaveBeenCalledTimes(1);
    });

    it('forwards excludeIds so the server pages around them', async () => {
        getPage.mockResolvedValue(page(['a']));
        renderHook(() =>
            useRelatedPagination({ ...BASE, excludeIds: ['local-1', 'local-2'] }),
        );

        await waitFor(() =>
            expect(getPage).toHaveBeenCalledWith(
                expect.objectContaining({ excludeIds: ['local-1', 'local-2'] }),
            ),
        );
    });

    it('maps a device context onto the anonymous wire input', async () => {
        getPage.mockResolvedValue(page(['a']));
        renderHook(() =>
            useRelatedPagination({
                ...BASE,
                ctx: {
                    homeCountryAlpha3: 'USA',
                    otherCountriesAlpha3: ['GBR'],
                    appLanguageBase: 'en',
                    preferredPublications: new Set(['the times']),
                    preferredCountriesAlpha3: new Set(['IND']),
                },
            }),
        );

        await waitFor(() =>
            expect(getPage).toHaveBeenCalledWith(
                expect.objectContaining({
                    context: {
                        homeCountryAlpha3: 'USA',
                        otherCountriesAlpha3: ['GBR'],
                        appLanguageBase: 'en',
                        preferredPublications: ['the times'],
                        preferredCountriesAlpha3: ['IND'],
                    },
                }),
            ),
        );
    });
});
