// The Library's Stats page: the reader's last 30 days as plain cards (one per
// figure with data, `availableCards`, never a screen-level "has any data"
// gate), the "counted on this phone" line, and one floating Share above the
// Mera button that opens the share screen in the Library stack.
//
// "Clear viewing history" empties the visit figures but not Right now, which
// stays while there are saves or followed stories.

import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';
import StatFigure, { statLabel } from '@/components/custom/share-stats/stat-figures';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { availableCards, emptyReadingStats, type ReadingStats, type StatsCardId } from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

const SHARE_H = 44;

interface Props {
    /** False while a warmed neighbour: reads once, then re-reads silently each
     *  time it becomes visible. */
    readonly active: boolean;
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    readonly headerHeight: number;
    /** List-end padding: the tab bar and the Mera button. */
    readonly listEndPadding: number;
    /** Opens the Stats explainer (the ? beside the page title). */
    readonly onExplain: () => void;
}

/** One Stats card as it sits on the page: its name, then its figure. */
const StatTile: React.FC<{ readonly id: StatsCardId; readonly stats: ReadingStats }> = ({ id, stats }) => {
    const { t } = useTranslation();
    const c = useColors();
    return (
        <View style={[styles.tile, { backgroundColor: c.surface, borderColor: c.line }]} testID={`stat-tile-${id}`}>
            <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, marginBottom: 6 }}>{statLabel(t, id)}</Text>
            <StatFigure id={id} stats={stats} variant="tile" />
        </View>
    );
};

const StatsPage: React.FC<Props> = ({ active, scrollHandler, headerHeight, listEndPadding, onExplain }) => {
    const { t } = useTranslation();
    const c = useColors();
    const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            setStats(await loadReadingStats());
        } catch (error) {
            logger.captureException(error, { tags: { screen: 'StatsPage', method: 'load' } });
        }
    }, []);

    // Reload whenever the page becomes VISIBLE: a visit, save or follow made
    // meanwhile must show without a pull.
    const isFocused = useIsFocusedSafe();
    const visible = active && isFocused;
    useEffect(() => {
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
            return;
        }
        if (visible) void load();
    }, [visible, load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const cards = availableCards(stats);
    const shareShown = active && cards.length > 0;

    return (
        <Box className="flex-1">
            <Animated.FlatList
                testID="stats-page"
                data={cards}
                keyExtractor={(id: StatsCardId) => id}
                renderItem={({ item }: { item: StatsCardId }) => <StatTile id={item} stats={stats} />}
                ItemSeparatorComponent={() => <View style={{ height: PAGE_TITLE_GAP }} />}
                ListHeaderComponent={
                    <View style={{ marginBottom: PAGE_TITLE_GAP }}>
                        <PageTitleRow title={t('library.stats.title')} onExplain={onExplain} testID="stats-title-row" />
                    </View>
                }
                ListFooterComponent={
                    cards.length > 0 ? (
                        <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3, textAlign: 'center', marginTop: 12 }}>
                            {t('library.stats.counted')}
                        </Text>
                    ) : null
                }
                ListEmptyComponent={
                    isLoading ? (
                        <Box className="items-center justify-center py-20">
                            <Spinner size="large" />
                        </Box>
                    ) : (
                        <ForYouEmptyState
                            icon="insights"
                            title={t('library.stats.emptyTitle')}
                            body={t('library.stats.emptyBody')}
                            action={{
                                label: t('library.stats.learn'),
                                onPress: () => openTutorial('library', 'stats'),
                                testID: 'stats-learn',
                            }}
                            testID="stats-empty"
                        />
                    )
                }
                contentContainerStyle={{
                    paddingTop: headerHeight + PAGE_CONTENT_GAP,
                    paddingHorizontal: PAGE_SIDE_INSET,
                    // Clear of the Mera button, and of the floating Share above it.
                    paddingBottom: listEndPadding + (shareShown ? SHARE_H + 12 : 0),
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ?? notifyScrollTick}
                onContentSizeChange={active ? notifyScrollTick : undefined}
                scrollEventThrottle={16}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={c.accent}
                        colors={[c.accent]}
                        progressViewOffset={headerHeight}
                    />
                }
            />

            {/* One Share for every card, above the Mera button (its top plus
                the list-end gap, derived, never a literal). */}
            {shareShown ? (
                <Pressable
                    onPress={() => router.push('/logged-in/app_container/library/share-stats')}
                    accessibilityRole="button"
                    accessibilityLabel={t('library.stats.share')}
                    testID="stats-share"
                    style={[styles.share, { bottom: listEndPadding, backgroundColor: c.accent }]}
                >
                    <MaterialIcons name="ios-share" size={17} color={c.onAccent} />
                    <Text style={{ color: c.onAccent, fontSize: 14, lineHeight: 18, fontWeight: '700' }}>
                        {t('library.stats.share')}
                    </Text>
                </Pressable>
            ) : null}
        </Box>
    );
};

const styles = StyleSheet.create({
    tile: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
    share: {
        position: 'absolute',
        right: 14,
        height: SHARE_H,
        paddingHorizontal: 16,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
});

export default StatsPage;
