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
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    FlatList,
    type ListRenderItem,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PAGE_SIZE = 10;

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
}

/**
 * The Explore tab's article list for one scope. DIRECT server-paginated
 * `topHeadlinesForCountry` — no scoring, no suggestions, nothing persisted.
 * Every scope (World or country) fetches a single `topHeadlinesForCountry`
 * page per load, straight through — no client-side geo filtering (see
 * lib/explore/geo-scope-filter.ts, deprecated). Each row keeps its headline's
 * `stableClusterId`/`clusterSize` metadata so downstream feedback actions can
 * carry the story's cross-run identity (see `subjectExtras` in renderItem).
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
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [headlines, setHeadlines] = useState<TopHeadline[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    // Re-tap the Explore icon → scroll this list to top. Explore is
    // scroll-to-top ONLY: it is a direct server-paginated surface with no
    // pull-to-refresh, so no `onRefresh` is passed and a second tap at the top
    // is deliberately inert.
    const listRef = useRef<FlatList<TopHeadline>>(null);
    const lastOffset = useRef(0);
    useTabPressScrollRefresh({
        listRef,
        getOffset: () => lastOffset.current,
    });

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

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;
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
    }, [hasNextPage, isLoadingMore, endCursor, loadFrom, scope.kind]);

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
                    {t('explore.noArticles')}
                </Text>
            </VStack>
        );
    }, [isLoading, enabled, t]);

    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        lastOffset.current = e.nativeEvent.contentOffset.y;
        notifyScrollTick();
    }, []);

    return (
        <FlatList
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
