import { useCallback, useEffect, useRef, useState } from 'react';
import { ArticleService } from '@/lib/article-service';
import {
    RelatedSortMode as GqlRelatedSortMode,
    type ArticleSummary,
    type RelatedArticlesContextInput,
} from '@/lib/generated/graphql-types';
import type { RelatedSortMode } from '@/lib/feed-grouping/related-articles-sort';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';
import logger from '@/lib/logger';

/**
 * How many related rows one page carries. The related list renders unvirtualized
 * inside a ScrollView and every row mounts a remote image, so the page size is
 * the render budget as much as the network one.
 */
export const RELATED_PAGE_SIZE = 10;

/**
 * The app's sort mode -> the GraphQL enum. An explicit map, not a
 * `toUpperCase()`, so adding a mode on one side without the other is a compile
 * error rather than a silent fall back to relevance.
 */
const TO_GQL_SORT: Record<RelatedSortMode, GqlRelatedSortMode> = {
    relevance: GqlRelatedSortMode.Relevance,
    oldest: GqlRelatedSortMode.Oldest,
    newest: GqlRelatedSortMode.Newest,
};

/**
 * Device context -> the anonymous wire input. `Set`s become arrays; a null
 * context sends nothing at all rather than an object of nulls, so the server
 * takes its documented fail-open path.
 */
function toContextInput(
    ctx: UserGeoLanguageContext | null,
): RelatedArticlesContextInput | null {
    if (ctx === null) return null;
    return {
        homeCountryAlpha3: ctx.homeCountryAlpha3,
        otherCountriesAlpha3: ctx.otherCountriesAlpha3,
        appLanguageBase: ctx.appLanguageBase,
        preferredPublications: Array.from(ctx.preferredPublications ?? []),
        preferredCountriesAlpha3: Array.from(ctx.preferredCountriesAlpha3 ?? []),
    };
}

interface UseRelatedPaginationInput {
    /** The article whose coverage this is. Null while it is still resolving —
     *  the hook stays idle rather than firing a query for an unknown id. */
    articleId: string | null;
    stableClusterId?: string | null;
    sortMode: RelatedSortMode;
    ctx: UserGeoLanguageContext | null;
    /** Rows the caller renders itself and must not receive again. The suggestion
     *  route passes its local siblings. Excluded SERVER-side, before ordering,
     *  so pages stay full and the country blocks are sized over what is served. */
    excludeIds?: string[];
    /** No network, no query — the related list is supplementary and an offline
     *  detail view should not log a guaranteed failure on every open. */
    isConnected: boolean;
}

interface UseRelatedPagination {
    entries: ArticleSummary[];
    /** First page in flight, nothing on screen yet. */
    isLoadingInitial: boolean;
    /** A later page in flight, rows already on screen. */
    isLoadingMore: boolean;
    hasNextPage: boolean;
    /** Wire to the scroll container's `onEndReached`. Self-guarding: safe to
     *  call repeatedly, including from `scrollToEnd`. */
    loadMore: () => void;
}

/**
 * Paged, server-ordered related coverage for the two detail routes.
 *
 * The server owns the ordering — the country-block order ranks each block by its
 * size across the whole candidate set, so it cannot be reconstructed from one
 * page — which makes this a pure accumulate-and-append, with two things it must
 * get right:
 *
 *  - `restarted`. The server tells us the cursor stopped resolving (the story
 *    was re-clustered, or the ordered list expired) and this page starts from
 *    the top. Appending it would stack a second copy of page 1 under the pages
 *    already on screen, and nothing in the rows themselves reveals that. So a
 *    restarted page REPLACES.
 *  - The generation guard. A sort change resets the list and the cursor, so a
 *    page still in flight from the previous sort belongs to a different ordering
 *    entirely. Dropping it wholesale is the only correct answer; appending it
 *    would interleave two orderings. Copied from `ScopeArticleList.loadMore`.
 */
export function useRelatedPagination({
    articleId,
    stableClusterId,
    sortMode,
    ctx,
    excludeIds,
    isConnected,
}: UseRelatedPaginationInput): UseRelatedPagination {
    const [entries, setEntries] = useState<ArticleSummary[]>([]);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const [isLoadingInitial, setIsLoadingInitial] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const generationRef = useRef(0);
    // Read inside callbacks rather than closed over, so changing the exclusion
    // set does not rebuild `loadMore` and re-arm the scroll container.
    const excludeRef = useRef<string[] | undefined>(excludeIds);
    excludeRef.current = excludeIds;
    const ctxRef = useRef<UserGeoLanguageContext | null>(ctx);
    ctxRef.current = ctx;

    const fetchPage = useCallback(
        async (after: string | null, generation: number) => {
            if (!articleId) return;
            try {
                const page = await ArticleService.getRelatedArticlesPage({
                    articleId,
                    stableClusterId,
                    sortMode: TO_GQL_SORT[sortMode],
                    context: toContextInput(ctxRef.current),
                    excludeIds: excludeRef.current,
                    first: RELATED_PAGE_SIZE,
                    after,
                });
                // A reset landed while this was in flight. Its rows belong to a
                // different ordering and its cursor to different offsets.
                if (generationRef.current !== generation) return;
                setEntries((prev) =>
                    after === null || page.restarted
                        ? page.articles
                        : [...prev, ...page.articles],
                );
                setEndCursor(page.pageInfo.endCursor ?? null);
                setHasNextPage(page.pageInfo.hasNextPage);
            } catch (error) {
                if (generationRef.current !== generation) return;
                logger.captureException(error, {
                    tags: { hook: 'useRelatedPagination', method: 'fetchPage' },
                    extra: { articleId, after },
                });
                // Stop paging rather than retry on every scroll tick. The list
                // is supplementary; a stuck spinner is worse than a short list.
                setHasNextPage(false);
            }
        },
        [articleId, stableClusterId, sortMode],
    );

    // First page, and the reset. Keyed on the article and the sort mode: a sort
    // change means the reader asked for a DIFFERENT set of rows at the top, so
    // carrying the accumulated pages over would show them the old ordering with
    // a new label.
    useEffect(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        setEntries([]);
        setEndCursor(null);
        setHasNextPage(false);
        setIsLoadingMore(false);
        if (!articleId || !isConnected) {
            setIsLoadingInitial(false);
            return;
        }
        setIsLoadingInitial(true);
        void fetchPage(null, generation).finally(() => {
            if (generationRef.current === generation) setIsLoadingInitial(false);
        });
    }, [articleId, isConnected, fetchPage]);

    const loadMore = useCallback(() => {
        if (!hasNextPage || isLoadingMore || isLoadingInitial || !endCursor) return;
        const generation = generationRef.current;
        setIsLoadingMore(true);
        void fetchPage(endCursor, generation).finally(() => {
            if (generationRef.current === generation) setIsLoadingMore(false);
        });
    }, [hasNextPage, isLoadingMore, isLoadingInitial, endCursor, fetchPage]);

    return { entries, isLoadingInitial, isLoadingMore, hasNextPage, loadMore };
}
