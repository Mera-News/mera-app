import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListRenderItem, RefreshControl } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DrillDownHeader from './DrillDownHeader';

interface Props {
    readonly onBack: () => void;
    /** When embedded inside another screen (e.g. the For-You "History" sub-tab),
     *  the DrillDownHeader is suppressed (the host already owns the top chrome)
     *  and the list's bottom padding accounts for the floating tab bar — mirrors
     *  SavedSuggestionsScreen's `embedded` prop. Route usage leaves this unset,
     *  which keeps non-embedded behavior byte-identical. */
    embedded?: boolean;
    /** Embedded hosts keep this component mounted behind display:none and flip
     *  this when the sub-tab becomes visible. Visits recorded while hidden
     *  (e.g. the open-article button on feed cards) would otherwise never show:
     *  the initial fetch runs once, and the empty state renders outside the
     *  FlatList so pull-to-refresh can't recover either. Unset = always active. */
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
}

const VisitedPublicationsList: React.FC<Props> = ({
    onBack,
    embedded = false,
    active = true,
    scrollHandler,
    headerHeight = 0,
}) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const rows = await getTopVisitedPublications();
            setItems(rows);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'VisitedPublicationsList', method: 'load' },
            });
        }
    }, []);

    useEffect(() => {
        if (!active) return;
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
            return;
        }
        // Re-activation of an already-fetched embedded list: silent refresh.
        void load();
    }, [active, load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const keyExtractor = useCallback(
        (item: VisitedPublication) => `${item.publicationName}::${item.countryCode ?? ''}`,
        [],
    );

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
            <Pressable onPress={() => handlePublicationPress(item)}>
                <HStack
                    className="mx-4 mb-2 p-3 items-center"
                    space="md"
                >
                    <SourceFlag countryCode={item.countryCode} size="xl" />
                    <VStack className="flex-1" space="xs">
                        <Text size="md" className="text-white" numberOfLines={1}>
                            {item.publicationName}
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
            </Pressable>
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
                />
            )}
            {/* These two branches render INSTEAD of the list, so there is no
                scrollable in them and the host's header cannot collapse — it just
                stays revealed, which is correct. They do need the header's height
                as plain padding though, or they render behind it.

                The "header hidden with nothing to scroll" trap is already closed
                without extra wiring: `selectSubTab` reveals on every sub-tab
                switch, and the only other route into these branches from a
                scrolled state is a pull-to-refresh that returns zero rows — the
                pull itself sits at offset 0, which use-collapsible-header's
                `y <= 0` branch reveals on. */}
            {isLoading ? (
                <Box
                    className="flex-1 items-center justify-center"
                    style={{ paddingTop: headerHeight }}
                >
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                // KNOWN GAP (pre-existing, deliberately not fixed here): this
                // branch renders instead of the FlatList, so it carries no
                // RefreshControl — a user whose history is empty cannot pull to
                // refresh, and a visit recorded while this panel was mounted but
                // hidden has no way to appear until a remount. The `active` prop
                // above exists to paper over exactly this. The real fix is to
                // render the list always and move both branches into
                // `ListEmptyComponent`; that changes the standalone route's
                // behaviour, so it wants its own wave.
                <VStack
                    className="flex-1 items-center justify-center p-6"
                    space="md"
                    style={{ paddingTop: headerHeight }}
                >
                    <MaterialIcons name="visibility-off" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('publicationVisits.noArticlesYet')}
                    </Text>
                </VStack>
            ) : (
                <Animated.FlatList
                    testID="visited-publications-list"
                    data={items}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    ListHeaderComponent={ListHeader}
                    contentContainerStyle={{
                        paddingTop: headerHeight,
                        paddingBottom: embedded
                            ? insets.bottom + TAB_BAR_HEIGHT + 24
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
            )}
        </Box>
    );
};

export default VisitedPublicationsList;
