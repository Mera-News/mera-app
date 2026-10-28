import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import IndeterminateBar from '@/components/custom/toast/IndeterminateBar';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { ExploreScope } from '@/lib/explore/scopes';
import type { CanonicalTopicFacet, TopHeadline } from '@/lib/generated/graphql-types';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, View, type ListRenderItem } from 'react-native';
import Animated, { runOnJS, useAnimatedScrollHandler, useComposedEventHandler } from 'react-native-reanimated';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';
import { useScopeArticleList } from './useScopeArticleList';

/** A World page's time window: the stories most covered in the last 6, 12,
 *  24 or 48 hours (the server's `windowHours`), 24 to start. */
export const EXPLORE_WINDOWS_HOURS = [6, 12, 24, 48] as const;
export type ExploreWindowHours = (typeof EXPLORE_WINDOWS_HOURS)[number];

/** A country page's first load: a 4pt bar under the title row. The bar needs
 *  an explicit width (IndeterminateBar), so the row measures itself once. */
function GatheringBar({ label }: { readonly label: string }) {
    const colors = useColors();
    const [width, setWidth] = useState(0);
    return (
        <View
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            style={{ height: 4, marginTop: 6, marginHorizontal: 2 }}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            testID="explore-gathering"
        >
            {width > 0 ? <IndeterminateBar width={width} height={4} color={colors.accent} /> : null}
        </View>
    );
}

const SKELETON_ROWS = 3;
const SKELETON_THUMB = 64;
const skeletonBar = (width: `${number}%`, fill: string, height = 12) => ({
    height,
    borderRadius: height / 2,
    width,
    backgroundColor: fill,
});
const SKELETON_ROW_STYLE = {
    flexDirection: 'row',
    gap: 12,
    padding: 10,
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: 1,
} as const;

/** Static placeholder rows for a first load (no pulse: nothing moves on a
 *  World page unless the reader moves it, and Lite mode needs no branch). */
function SkeletonRows() {
    const colors = useColors();
    return (
        <Box
            testID="explore-skeleton"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        >
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <Box key={i} style={[SKELETON_ROW_STYLE, { borderColor: colors.line, backgroundColor: colors.surface }]}>
                    <Box
                        style={{
                            width: SKELETON_THUMB,
                            height: SKELETON_THUMB,
                            borderRadius: 10,
                            backgroundColor: colors.surface,
                        }}
                    />
                    <VStack style={{ flex: 1, gap: 8, paddingTop: 4 }}>
                        <Box style={skeletonBar('90%', colors.surfaceRaised)} />
                        <Box style={skeletonBar('65%', colors.line)} />
                        <Box style={skeletonBar('35%', colors.surface, 10)} />
                    </VStack>
                </Box>
            ))}
        </Box>
    );
}


interface ScopeArticleListProps {
    readonly scope: ExploreScope;
    /**
     * Gate on the QUERY, not on the mount. The list itself must exist from the
     * very first render (see the FlatList note below), so the "don't fetch
     * against the device-country fallback" rule is enforced here instead of by
     * withholding the component.
     */
    readonly enabled?: boolean;
    /** Measured height of the tab's pinned header (TabPages) — the list
     *  scrolls UNDER it, so its content starts below it. */
    readonly headerHeight?: number;
    /** The tab's collapsible-header worklet scroll handler — composed
     *  here with this list's own scroll-tick handler via
     *  `useComposedEventHandler` (mirrors DashboardSectionsFeed). */
    readonly scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
    /** False while this page is a warmed or cached neighbour in the World
     *  pager window: it still fetches its first page once, so arriving
     *  shows it at once, but it paginates and takes the tab-press refresh only
     *  when active. Default true. */
    readonly active?: boolean;
    /** Rank the stories most covered in the last 6, 12, 24 or 48 hours (the
     *  header menu). The parent keys this list by it, so a change is a fresh mount
     *  and a fresh first page. Absent: the server default (24). */
    readonly windowHours?: number;
    /** World pages: a new window. When given, an empty answer under 48h
     *  offers a one-tap 48 hours. */
    readonly onWindowChange?: (next: ExploreWindowHours) => void;
    /** List-end clear space from the host. Default: the tab bar plus a tail. */
    readonly bottomClearance?: number;
    /** World topic filter: the canonical topic this page asks for (the parent
     *  keys the list by it, so a change is a fresh first page). */
    readonly topicId?: string | null;
    /** The reader's pick, by label, for the header line. With `topicId` set the
     *  line counts its stories; with `topicId` null it says the page fell back to all. */
    readonly pickLabel?: string | null;
    /** Reports whether this page is the active one, and its facets once its answer is in
     *  (null while loading or failed, so the host never shows another page's counts). */
    readonly onFacets?: (facets: readonly CanonicalTopicFacet[] | null, topicsSupported: boolean, active: boolean) => void;
}

/**
 * A World page's article list (World or one country). DIRECT server-paginated
 * `topHeadlinesForCountry` — no scoring, no suggestions, nothing persisted.
 * Every scope (World or country) fetches a single `topHeadlinesForCountry`
 * page per load, straight through — no client-side geo filtering.
 * Each row keeps its headline's
 * `stableClusterId`/`clusterSize` metadata so downstream feedback actions can
 * carry the story's cross-run identity (see `subjectExtras` in renderItem).
 * Pull-to-refresh — and the World tab-icon re-tap — refetch page 1 for the
 * active page; see `onRefresh`.
 *
 * The pager keys each page by page id and WorldPages keys this list by its
 * window, so a window change is a fresh mount and a page kept in the window
 * keeps its page.
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
    active = true,
    windowHours,
    onWindowChange,
    bottomClearance,
    topicId,
    pickLabel,
    onFacets,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const hours: ExploreWindowHours = (windowHours as ExploreWindowHours | undefined) ?? 24;
    const countryName = scope.kind === 'world' ? null : scope.label;
    const tabClearance = useTabBarClearance();
    const {
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
        facets,
        topicsSupported,
    } = useScopeArticleList({ scope, enabled, windowHours, topicId });

    const answered = enabled && !isLoading && !loadFailed;
    useEffect(() => {
        onFacets?.(answered ? facets : null, topicsSupported, active);
    }, [answered, facets, topicsSupported, active, onFacets]);

    const renderItem: ListRenderItem<TopHeadline> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item.article}
                similarCount={Math.max(0, item.clusterSize - 1)}
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

    const ListFooterComponent = useCallback(
        () =>
            isLoadingMore ? (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            ) : null,
        [isLoadingMore],
    );

    // On a country page's first load, its bar: INSIDE the list
    // (react-native-screens walks `subviews[0]` for the scroll view). The
    // title and the window chip live in the tab header (WorldPages).
    const topicLine = useMemo(() => {
        if (!pickLabel || !answered) return null;
        if (!topicId) return t('explore.topicFilter.fallback', { topic: pickLabel });
        const count = facets.find((f) => f.topicId === topicId)?.count ?? headlines.length;
        return t('explore.topicFilter.count', { count, topic: pickLabel });
    }, [pickLabel, answered, topicId, facets, headlines.length, t]);

    const ListHeaderComponent = useMemo(
        () =>
            (countryName && firstLoad && !loadHung) || topicLine ? (
                <View style={{ marginBottom: PAGE_TITLE_GAP }}>
                    {countryName && firstLoad && !loadHung ? (
                        <GatheringBar label={t('world.gathering', { country: countryName })} />
                    ) : null}
                    {topicLine ? (
                        <Text size="sm" style={{ color: colors.ink2 }} testID="world-topic-line">
                            {topicLine}
                        </Text>
                    ) : null}
                </View>
            ) : null,
        [firstLoad, countryName, loadHung, topicLine, colors.ink2, t],
    );

    // Skeleton-or-empty-state, decided INSIDE the list. Previously these were two
    // early returns that replaced the list entirely — see the component note.
    const ListEmptyComponent = useCallback(() => {
        if (!enabled || (isLoading && !loadHung)) {
            return (
                <VStack testID="explore-loading" space="md">
                    <SkeletonRows />
                </VStack>
            );
        }
        // Answered, online, nothing in the window: say so in the window's
        // terms, and offer the widest window when a narrower one is set.
        const answeredEmpty = isConnected && isOnline && !loadFailed && !isLoading;
        return (
            <VStack className="items-center justify-center py-20 p-6" space="md" testID="explore-empty">
                <MaterialIcons name="article" size={48} color={colors.ink3} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
                <Text size="md" className="text-ink-2 text-center">
                    {/* Explore is server-paginated with no local cache, so an
                        offline OR Mera-unreachable visit produces an empty list
                        rather than an error. Saying "no articles found" there
                        would be a lie about the world; name the real reason
                        instead — and the real reason forks in two: no device
                        link at all versus a link that just can't reach Mera
                        right now. Conflating them under one "you're offline"
                        string used to blame the user's connection even when
                        Mera was the one down. This used to be a warning band in
                        the Explore header, which stacked with the global
                        connectivity band — it belongs here, on the emptiness it
                        explains. */}
                    {!isConnected
                        ? t('world.offline')
                        : !answeredEmpty
                            ? t('explore.serverUnavailable')
                            : countryName
                                ? t('world.emptyWindow', { country: countryName, hours })
                                : t('world.emptyWindowWorld', { hours })}
                </Text>
                {answeredEmpty && onWindowChange && hours < 48 ? (
                    <Button variant="outline" size="sm" testID="explore-show-48" onPress={() => onWindowChange(48)}>
                        <ButtonText>{t('world.showWider')}</ButtonText>
                    </Button>
                ) : null}
            </VStack>
        );
    }, [isLoading, enabled, loadHung, isOnline, isConnected, loadFailed, t, countryName, hours, onWindowChange, colors]);

    // Compose the collapsible-header handler (from TabPages) with a
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
                paddingHorizontal: PAGE_SIDE_INSET,
                // Clear the pinned header overlay (measured by TabPages) —
                // the list scrolls underneath it.
                paddingTop: headerHeight + PAGE_CONTENT_GAP,
                // The tab bar once, then a tail (see useTabBarClearance).
                paddingBottom: bottomClearance ?? tabClearance + 24,
                flexGrow: 1,
            }}
            refreshControl={
                <RefreshControl
                    testID="explore-refresh"
                    refreshing={isRefreshing}
                    onRefresh={onRefresh}
                    tintColor={colors.accent}
                    colors={[colors.accent]}
                    // The header/chips are a PINNED OVERLAY on this screen, not
                    // stacked chrome — without this the spinner spins behind
                    // them and reads as nothing happening.
                    progressViewOffset={headerHeight}
                />
            }
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onEndReached={active ? loadMore : undefined}
            onEndReachedThreshold={0.5}
            ListHeaderComponent={ListHeaderComponent}
            ListEmptyComponent={ListEmptyComponent}
            ListFooterComponent={ListFooterComponent}
        />
    );
};

export default ScopeArticleList;
