import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import TapPressable from '@/components/custom/cards/TapPressable';
import { useTranslation } from 'react-i18next';
import { ListRenderItem, RefreshControl } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import DrillDownHeader from './DrillDownHeader';
import { DisplayPublicationName } from '@/lib/stores/publication-display-store';

interface Props {
    readonly onBack: () => void;
    /** When embedded inside another screen (e.g. the For-You "History" sub-tab),
     *  the DrillDownHeader is suppressed (the host already owns the top chrome)
     *  and the list's bottom padding accounts for the floating tab bar — mirrors
     *  SavedSuggestionsScreen's `embedded` prop. Route usage leaves this unset,
     *  which keeps non-embedded behavior byte-identical. */
    embedded?: boolean;
    /** Embedded hosts keep this component mounted off-screen (the Dashboard
     *  swipe window, ux2 B3) and flip this when the sub-tab becomes visible.
     *  It reads once on mount either way, so a warmed panel has its rows drawn
     *  before the swipe lands; becoming visible re-reads silently, so visits
     *  recorded meanwhile (the open-article button on feed cards) show.
     *  Unset = always active. */
    active?: boolean;
    /** The host's collapsing-header scroll handler (Dashboard sub-tab use). The
     *  list MUST be an `Animated.FlatList` for this to do anything — a
     *  `useAnimatedScrollHandler` worklet attached to a plain RN `FlatList` never
     *  reaches the UI thread, which is why this panel's header stayed pinned
     *  while Overview's collapsed. Omitted on the standalone route. */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Measured height of the host's collapsing header. Becomes the list's
     *  content `paddingTop` so the rows scroll UNDER the header instead of the
     *  host padding a wrapper View (which would leave a dead gap once the header
     *  translates away). Defaults to 0 — standalone route is unchanged.
     *
     *  The spinner and empty branches below get it as a plain `paddingTop`:
     *  neither is a scrollable, so they cannot scroll under the header and would
     *  otherwise render behind it. */
    headerHeight?: number;
    /** Told the row count after every load, so an embedded host can hide
     *  controls that mean nothing over an empty list (the share FAB). */
    onCountChange?: (count: number) => void;
}

const VisitedPublicationsList: React.FC<Props> = ({
    onBack,
    embedded = false,
    active = true,
    scrollHandler,
    headerHeight = 0,
    onCountChange,
}) => {
    // Inside a tab on iOS the inset already includes the tab bar; measured on
    // device, adding TAB_BAR_HEIGHT left ~2x the bar of dead space at the end.
    const tabClearance = useTabBarClearance();
    const { t } = useTranslation();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const rows = await getTopVisitedPublications();
            setItems(rows);
            onCountChange?.(rows.length);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'VisitedPublicationsList', method: 'load' },
            });
        }
    }, [onCountChange]);

    // Reload whenever the list becomes VISIBLE: the sub-tab selected AND the
    // Dashboard tab focused. `active` alone missed the common path (open an
    // article, tap through to the publisher, come back): the sub-tab never
    // changed, so the visit just recorded never showed (B4).
    const isFocused = useIsFocusedSafe();
    const visible = active && isFocused;
    useEffect(() => {
        if (!hasFetched.current) {
            // First read on mount, visible or not: warmed off-screen, the rows
            // are drawn before the reader swipes in.
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
            return;
        }
        // Becoming visible again: silent re-read, no spinner.
        if (visible) void load();
    }, [visible, load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const keyExtractor = useCallback(
        (item: VisitedPublication) => `${item.publicationName}::${item.countryCode ?? ''}`,
        [],
    );

    const handleSharePress = useCallback(() => {
        router.push('/logged-in/share-stats');
    }, []);

    const handlePublicationPress = useCallback((item: VisitedPublication) => {
        router.push({
            pathname: '/logged-in/publication-history',
            params: {
                publicationName: item.publicationName,
                ...(item.countryCode ? { countryCode: item.countryCode } : {}),
            },
        });
    }, []);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item }) => (
            // Opens on a TAP only: a sideways drag (the Dashboard tab swipe)
            // released over a row is not a press.
            <TapPressable onPress={() => handlePublicationPress(item)} testID={`visited-row-${item.publicationName}`}>
                <HStack
                    className="mx-4 mb-2 p-3 items-center"
                    space="md"
                >
                    <SourceFlag countryCode={item.countryCode} size="xl" />
                    <VStack className="flex-1" space="xs">
                        <Text size="md" className="text-white" numberOfLines={1}>
                            <DisplayPublicationName name={item.publicationName} />
                        </Text>
                        <Text size="xs" className="text-gray-400">
                            {t('publicationVisits.lastRead', { time: formatTimeAgo(t, item.lastVisitedAt) })}
                        </Text>
                    </VStack>
                    <Box className="px-2.5 py-1 rounded-full border border-white">
                        <Text size="xs" bold className="text-white">
                            {item.visitCount}
                        </Text>
                    </Box>
                    <MaterialIcons name="chevron-right" size={20} color="#999999" />
                </HStack>
            </TapPressable>
        ),
        [handlePublicationPress, t],
    );

    const ListHeader = (
        <Box className="mx-4 mt-3 mb-2 p-3 rounded-lg border border-white">
            <Text size="xs" italic className="text-white">
                {t('publicationVisits.screenIntro')}
            </Text>
        </Box>
    );

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box className="flex-1">
            {/* DrillDownHeader suppressed when embedded — the host (the
                Dashboard's History sub-tab) already owns the top chrome and its
                own back affordance is the sub-tab pill row, exactly like the
                Saved sub-tab's SavedSuggestionsScreen. */}
            {!embedded && (
                <DrillDownHeader
                    title={t('publicationVisits.visitedListTitle')}
                    subtitle={t('publicationVisits.last30Days')}
                    onBack={onBack}
                    /* The share card's entry point. It lives HERE rather than
                       on the Sources tab card because this is the screen where
                       the reader already sees and owns this exact data, and
                       DrillDownHeader needed no change to carry it. Absent in
                       the embedded case, where the host owns the top chrome
                       and this header is not rendered at all. */
                    rightAction={
                        <Pressable
                            testID="share-stats-open"
                            onPress={handleSharePress}
                            hitSlop={12}
                            accessibilityRole="button"
                            accessibilityLabel={t('shareStats.entryA11y')}
                            className="p-1 rounded-full"
                        >
                            <MaterialIcons name="ios-share" size={20} color="#FFFFFF" />
                        </Pressable>
                    }
                />
            )}
            {/* The list ALWAYS renders, with loading and empty as its own
                empty component, so an empty list still has pull-to-refresh
                and scrolls under the host's header like the others. */}
            <Animated.FlatList
                testID="visited-publications-list"
                data={items}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={items.length > 0 ? ListHeader : null}
                ListEmptyComponent={
                    isLoading ? (
                        <Box className="items-center justify-center py-20">
                            <Spinner size="large" />
                        </Box>
                    ) : (
                        // What this list IS: publishers the reader opened from
                        // Mera. It used to say "You haven't read any articles
                        // yet" while the reader had read several in the app,
                        // which this list never records (D5).
                        <ForYouEmptyState
                            icon="history"
                            title={t('publicationVisits.emptyTitle')}
                            body={t('publicationVisits.noArticlesYet')}
                            testID="visited-publications-empty"
                        />
                    )
                }
                contentContainerStyle={{
                    paddingTop: headerHeight,
                    paddingBottom: embedded
                        ? tabClearance + 24
                        : 20,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor="#ffffff"
                        colors={['#ffffff']}
                        // Without this the spinner drops from behind the
                        // collapsing header — the same leg DashboardSectionsFeed
                        // already carries. 0 standalone, so unchanged there.
                        progressViewOffset={headerHeight}
                    />
                }
            />
        </Box>
    );
};

export default VisitedPublicationsList;
