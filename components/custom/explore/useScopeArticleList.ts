import ArticleService from '@/lib/article-service';
import type { ExploreScope } from '@/lib/explore/scopes';
import type { NewsArticle, TopHeadline } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import logger from '@/lib/logger';
import { useIsConnected, useIsOnline } from '@/lib/stores/network-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { appendUniqueHeadlines, HUNG_LOAD_MS } from './ScopeArticleList';


const PAGE_SIZE = 10;

export function useScopeArticleList({
    scope,
    enabled,
    windowHours,
}: {
    scope: ExploreScope;
    enabled: boolean;
    windowHours?: number;
}) {
    const isOnline = useIsOnline();
    // `isOnline` (device link + Mera reachable) already gates the empty state
    // below, but it collapses two different reasons into one boolean — read
    // `isConnected` too so the copy can say WHICH is broken instead of always
    // blaming the user's connection when it might be Mera.
    const isConnected = useIsConnected();
    const [headlines, setHeadlines] = useState<TopHeadline[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    // A load that FAILED, as opposed to one that returned nothing. Without it the
    // empty state fell through to "no articles" whenever
    // `isOnline` still read true, blaming the world for a request that never
    // landed. Cleared by any successful load or refresh.
    const [loadFailed, setLoadFailed] = useState(false);
    // The first load has been running for HUNG_LOAD_MS (see the constant).
    const [loadHung, setLoadHung] = useState(false);
    useEffect(() => {
        if (!isLoading || !enabled) return;
        const id = setTimeout(() => setLoadHung(true), HUNG_LOAD_MS);
        return () => clearTimeout(id);
    }, [isLoading, enabled]);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);
    // Bumped by every refresh. A paginate captures the value it STARTED under
    // and discards its page if a refresh landed meanwhile — the `isRefreshing`
    // guard in `loadMore` only stops a paginate from starting during a refresh,
    // not from landing after one, and appending stale page 2 onto a freshly
    // refreshed page 1 is exactly how duplicate rows reached the screen. The
    // reported trigger — leave the tab, come back, tap the tab icon — runs
    // `useTabPressScrollRefresh` → `onRefresh` straight into that window.
    // A ref, not state: `loadMore`/`onRefresh` must not be re-created by it.
    const loadGenerationRef = useRef(0);

    // Fetch one page for this scope's country (or GLOBAL for World).
    const loadFrom = useCallback(
        async (after?: string): Promise<{ rows: TopHeadline[]; cursor: string | null; more: boolean }> => {
            const fetchArg = scope.countryCodeAlpha3 ?? 'GLOBAL';
            const page = await ArticleService.getTopHeadlinesForCountry(fetchArg, {
                first: PAGE_SIZE,
                after,
                windowHours,
            });
            return {
                rows: page.headlines,
                cursor: page.pageInfo.endCursor ?? null,
                more: page.pageInfo.hasNextPage,
            };
        },
        [scope, windowHours],
    );

    useEffect(() => {
        // ORDER MATTERS: bail out BEFORE latching `hasFetched`, otherwise the
        // gate would permanently consume the one allowed fetch and the real
        // load (once locations land) would never run.
        if (!enabled) return;
        if (hasFetched.current) return;
        hasFetched.current = true;
        (async () => {
            try {
                setIsLoading(true);
                const { rows, cursor, more } = await loadFrom();
                // Deduped even though it is a single page: the edition can
                // carry the same article under two entries, which would
                // collide on first render.
                setHeadlines(appendUniqueHeadlines([], rows));
                setEndCursor(cursor);
                setHasNextPage(more);
                setLoadFailed(false);
            } catch {
                setLoadFailed(true);
                // THE LINK OWNS THE CAPTURE. Every fetch on this screen goes
                // through ArticleService.getTopHeadlinesForCountry ->
                // client.query, so the Apollo error link has already seen,
                // classified and reported this failure before the rejection
                // arrives — and ArticleService.reportQueryError breadcrumbs
                // above it for the same reason. Capturing a third time here is
                // what made MERA-APP-77 one Sentry event per offline Explore
                // load per layer. Breadcrumb only; the `finally` below still
                // clears isLoading, and the three-way empty state
                // (noArticles / serverUnavailable / offlineUnavailable) is what
                // actually tells the user.
                logger.addBreadcrumb(
                    `[ScopeArticleList] load failed`,
                    'ScopeArticleList',
                    { method: 'load', scope: scope.kind },
                    'warning',
                );
            } finally {
                setIsLoading(false);
            }
        })();
    }, [enabled, loadFrom, scope.kind]);

    /**
     * Pull-to-refresh: refetch the FIRST page for this scope and replace the
     * list wholesale. Deliberately drops the accumulated pages and the cursor —
     * `topHeadlinesForCountry` is a ranked server feed, so a refreshed page 1 is
     * the latest ranking, and stitching it onto stale later pages would show
     * duplicates and a ranking from two different runs.
     *
     * Guarded on `isLoading` as well as `isRefreshing`: the initial load and a
     * refresh both write `headlines`/`endCursor`, and letting them race could
     * commit page 1 from one and the cursor from the other.
     */
    const onRefresh = useCallback(async () => {
        if (!enabled || isRefreshing || isLoading) return;
        const generation = ++loadGenerationRef.current;
        try {
            setIsRefreshing(true);
            const { rows, cursor, more } = await loadFrom();
            if (loadGenerationRef.current !== generation) return;
            setHeadlines(appendUniqueHeadlines([], rows));
            setEndCursor(cursor);
            setHasNextPage(more);
            setLoadFailed(false);
        } catch {
            setLoadFailed(true);
            // Breadcrumb only — see the mount load above.
            logger.addBreadcrumb(
                `[ScopeArticleList] refresh failed`,
                'ScopeArticleList',
                { method: 'refresh', scope: scope.kind },
                'warning',
            );
        } finally {
            setIsRefreshing(false);
        }
    }, [enabled, isRefreshing, isLoading, loadFrom, scope.kind]);

    // Re-tap the Explore icon → scroll to top; tap again at the top → refresh,
    // same as Feed and Dashboard. Passes the SAME `onRefresh` the RefreshControl
    // calls, so both entry points share one guard and one spinner.
    const listRef = useRef<Animated.FlatList<TopHeadline>>(null);
    // UI-thread shared value (not a plain ref) — set inside the worklet tick
    // handler below, same as DashboardSectionsFeed's `lastOffsetShared`.
    const lastOffsetShared = useSharedValue(0);
    // The tab's re-tap reaches only the visible page (TabPages, page-scroll).
    usePageScrollTarget(listRef, {
        getOffset: () => lastOffsetShared.value,
        onRefresh,
        isRefreshing,
    });

    const loadMore = useCallback(async () => {
        // `isRefreshing` matters here: a refresh replaces the list and the
        // cursor, so a paginate that starts mid-refresh would append using the
        // pre-refresh cursor and then have its rows thrown away (or overwrite
        // the refreshed cursor, depending on which settles last).
        if (!hasNextPage || isLoadingMore || isRefreshing || !endCursor) return;
        const generation = loadGenerationRef.current;
        try {
            setIsLoadingMore(true);
            const { rows, cursor, more } = await loadFrom(endCursor);
            // A refresh landed while this page was in flight: its rows belong
            // to the pre-refresh ordering and its cursor to the pre-refresh
            // offsets. Dropping the page wholesale is the only correct answer —
            // appending it would duplicate rows AND mix two rankings.
            if (loadGenerationRef.current !== generation) return;
            setHeadlines((prev) => appendUniqueHeadlines(prev, rows));
            setEndCursor(cursor);
            setHasNextPage(more);
        } catch {
            // Breadcrumb only — see the mount load above.
            logger.addBreadcrumb(
                `[ScopeArticleList] loadMore failed`,
                'ScopeArticleList',
                { method: 'loadMore', scope: scope.kind },
                'warning',
            );
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, isRefreshing, endCursor, loadFrom, scope.kind]);

    // Routes to suggestion-detail when Mera scored this article and wrote a
    // reason for it, so the reader can see WHY it was picked; otherwise to
    // article-detail, forwarding the stable story id so that screen resolves
    // related articles from the same cluster this card was ranked by.
    const openArticle = useOpenArticle();
    const handlePress = useCallback(
        (article: NewsArticle, stableClusterId?: string | null) => {
            openArticle({ articleId: article._id, stableClusterId });
        },
        [openArticle],
    );

    const firstLoad = (!enabled || isLoading) && headlines.length === 0;

    return {
        isOnline,
        isConnected,
        headlines,
        isLoading,
        isLoadingMore,
        isRefreshing,
        loadFailed,
        loadHung,
        onRefresh,
        listRef,
        lastOffsetShared,
        loadMore,
        handlePress,
        firstLoad,
    };
}
