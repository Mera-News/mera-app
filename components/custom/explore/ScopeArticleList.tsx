import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import ArticleService from '@/lib/article-service';
import type { ExploreScope } from '@/lib/explore/scopes';
import type { NewsArticle, TopHeadline } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { useTabPressScrollRefresh } from '@/lib/hooks/use-tab-press-scroll-refresh';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { useIsOnline } from '@/lib/stores/network-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, type ListRenderItem } from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedScrollHandler,
    useComposedEventHandler,
    useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PAGE_SIZE = 10;

// Matches FeedScreen / DashboardSectionsFeed / StoryTimelineScreen, which each
// declare it locally. A fourth copy beats a shared constant for one hex value.
const REFRESH_TINT = '#EDA77E';

interface ScopeArticleListProps {
    readonly scope: ExploreScope;
    /**
     * Gate on the QUERY, not on the mount. The list itself must exist from the
     * very first render (see the FlatList note below), so the "don't fetch
     * against the device-country fallback" rule is enforced here instead of by
     * withholding the component.
     */
    readonly enabled?: boolean;
    /** Measured height of ExploreScreen's pinned header overlay — the list
     *  scrolls UNDER it, so its content starts below it. */
    readonly headerHeight?: number;
    /** ExploreScreen's collapsible-header worklet scroll handler — composed
     *  here with this list's own scroll-tick handler via
     *  `useComposedEventHandler` (mirrors DashboardSectionsFeed). */
    readonly scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
}

/**
 * The Explore tab's article list for one scope. DIRECT server-paginated
 * `topHeadlinesForCountry` — no scoring, no suggestions, nothing persisted.
 * Every scope (World or country) fetches a single `topHeadlinesForCountry`
 * page per load, straight through — no client-side geo filtering (see
 * lib/explore/geo-scope-filter.ts, deprecated). Each row keeps its headline's
 * `stableClusterId`/`clusterSize` metadata so downstream feedback actions can
 * carry the story's cross-run identity (see `subjectExtras` in renderItem).
 * Pull-to-refresh — and the Explore tab-icon re-tap — refetch page 1 for the
 * active scope; see `onRefresh`.
 *
 * Mounted with a `key={scope.id}` by the parent, so switching scope resets all
 * state via remount.
 *
 * ── WHY THE FlatList IS ALWAYS RENDERED ──
 * react-native-screens locates a tab's scroll view by walking `subviews[0]`
 * from the tab screen ONCE, when the screen's index-0 child mounts
 * (RNSBottomTabsScreenComponentView.mountChildComponentView → RNSScrollViewHelper
 * → RNSScrollViewFinder). If this list is not on screen in that first commit —
 * or is not the FIRST child of the tab root — the chain dead-ends and the scroll
 * view is never found. This screen used to fail both ways (the title row was the
 * first child, and the list was withheld until locations loaded). So: no early
 * returns. The loading spinner and the empty state are `ListEmptyComponent`,
 * never a replacement for the list.
 *
 * NOTE, measured: restoring that chain did NOT make iOS 26 tab-bar minimize
 * work on this tab — it does not work on the Feed or Dashboard tabs either,
 * whose chains were always intact. Whatever blocks it is not this.
 */
const ScopeArticleList: React.FC<ScopeArticleListProps> = ({
    scope,
    enabled = true,
    headerHeight = 0,
    scrollHandler,
}) => {
    const { t } = useTranslation();
    const isOnline = useIsOnline();
    const insets = useSafeAreaInsets();
    const [headlines, setHeadlines] = useState<TopHeadline[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    // Fetch one page for this scope's country (or GLOBAL for World).
    const loadFrom = useCallback(
        async (after?: string): Promise<{ rows: TopHeadline[]; cursor: string | null; more: boolean }> => {
            const fetchArg = scope.countryCodeAlpha3 ?? 'GLOBAL';
            const page = await ArticleService.getTopHeadlinesForCountry(fetchArg, {
                first: PAGE_SIZE,
                after,
            });
            return {
                rows: page.headlines,
                cursor: page.pageInfo.endCursor ?? null,
                more: page.pageInfo.hasNextPage,
            };
        },
        [scope],
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
                setHeadlines(rows);
                setEndCursor(cursor);
                setHasNextPage(more);
            } catch (error) {
                logger.captureException(error, {
                    tags: { screen: 'ScopeArticleList', method: 'load', scope: scope.kind },
                });
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
        try {
            setIsRefreshing(true);
            const { rows, cursor, more } = await loadFrom();
            setHeadlines(rows);
            setEndCursor(cursor);
            setHasNextPage(more);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'ScopeArticleList', method: 'refresh', scope: scope.kind },
            });
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
    useTabPressScrollRefresh({
        listRef,
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
        try {
            setIsLoadingMore(true);
            const { rows, cursor, more } = await loadFrom(endCursor);
            setHeadlines((prev) => [...prev, ...rows]);
            setEndCursor(cursor);
            setHasNextPage(more);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'ScopeArticleList', method: 'loadMore', scope: scope.kind },
            });
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

    const renderItem: ListRenderItem<TopHeadline> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item.article}
                onPress={() => handlePress(item.article, item.stableClusterId)}
                subjectExtras={{
                    origin: 'article',
                    surface: 'explore',
                    scopeKey: scope.id,
                    stableClusterId: item.stableClusterId ?? undefined,
                }}
            />
        ),
        [handlePress, scope.id],
    );

    const keyExtractor = useCallback(
        (item: TopHeadline, index: number) => item.article._id || `article-${index}`,
        [],
    );

    const ListFooterComponent = useCallback(() => {
        if (isLoadingMore) {
            return (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            );
        }
        return null;
    }, [isLoadingMore]);

    // Spinner-or-empty-state, decided INSIDE the list. Previously these were two
    // early returns that replaced the list entirely — see the component note.
    const ListEmptyComponent = useCallback(() => {
        if (isLoading || !enabled) {
            return (
                <Box className="items-center justify-center py-20" testID="explore-loading">
                    <Spinner size="large" />
                </Box>
            );
        }
        return (
            <VStack className="items-center justify-center py-20 p-6" space="md" testID="explore-empty">
                <MaterialIcons name="article" size={48} color="#666666" />
                <Text size="md" className="text-gray-400 text-center">
                    {/* Explore is server-paginated with no local cache, so an
                        offline visit produces an empty list rather than an
                        error. Saying "no articles found" there would be a lie
                        about the world; name the real reason instead. This used
                        to be a warning band in the Explore header, which stacked
                        with the global connectivity band — it belongs here, on
                        the emptiness it explains. */}
                    {isOnline ? t('explore.noArticles') : t('explore.offlineUnavailable')}
                </Text>
            </VStack>
        );
    }, [isLoading, enabled, isOnline, t]);

    // Compose the collapsible-header handler (from ExploreScreen) with a
    // scroll-tick notifier (drives deferred TranslatableDynamic translation as
    // items enter the viewport) and the tab-press-refresh offset — mirrors
    // DashboardSectionsFeed.tsx:172-186. UI thread only: no bridge crossing,
    // no re-render, so this replaces the old plain-JS `onScroll` entirely
    // rather than running alongside it (the list can only take one `onScroll`
    // prop).
    const tickHandler = useAnimatedScrollHandler({
        onScroll: (e) => {
            runOnJS(notifyScrollTick)();
            lastOffsetShared.value = e.contentOffset.y;
        },
    });
    const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

    return (
        <Animated.FlatList
            ref={listRef}
            testID="explore-list"
            data={headlines}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            // Pinned to `never` (RN's default) so this list lays out exactly
            // like the Feed and Dashboard lists: content top starts at
            // `paddingTop`, and `scrollToOffset({offset: 0})` lands on the real
            // top. `automatic` — react-native-screens' one-shot `never →
            // automatic` flip, which it applies while hunting for the tab's
            // scroll view — was TRIED here and MEASURED: it adds a ~59pt top
            // content inset (a visible gap under the pinned header on a fresh
            // mount, and a scroll-to-top that stops 59pt short) and it did NOT
            // make iOS 26's `tabBarMinimizeBehavior` engage on this tab. Setting
            // it explicitly also makes the value deterministic across the
            // scope-switch remount, instead of depending on whether that
            // one-shot native flip happened to run.
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{
                padding: 16,
                // Clear the pinned header overlay (measured by ExploreScreen) —
                // the list scrolls underneath it.
                paddingTop: headerHeight + 8,
                paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 20,
                flexGrow: 1,
            }}
            refreshControl={
                <RefreshControl
                    testID="explore-refresh"
                    refreshing={isRefreshing}
                    onRefresh={onRefresh}
                    tintColor={REFRESH_TINT}
                    colors={[REFRESH_TINT]}
                    // The header/chips are a PINNED OVERLAY on this screen, not
                    // stacked chrome — without this the spinner spins behind
                    // them and reads as nothing happening.
                    progressViewOffset={headerHeight}
                />
            }
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={ListEmptyComponent}
            ListFooterComponent={ListFooterComponent}
        />
    );
};

export default ScopeArticleList;
