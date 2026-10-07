// The Library's History page (FinalLibrary #7-10): the publications whose
// sites the reader opened in the last 30 days as a table (flag, publication,
// visits, last read), then the Stats as plain cards with their own ?, and one
// floating Share above the Mera button. The page id stays `visited`.
//
// Visits are RAW visits (taps) summed across every name a publication is known
// by (`mergeVisitedByName`); the publication page's "opened N times" counts the
// same rows. Subscribe and Support live on the publication page only, so this
// page makes no per-row network lookup.
//
// The Stats are gated per card (`availableCards`), never on `hasAnyData`:
// "Clear viewing history" empties the table and the visit cards but not Right
// now, which stays while there are saves or followed stories.

import TapPressable from '@/components/custom/cards/TapPressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageExplainerSheet from '@/components/custom/nav/PageExplainerSheet';
import type { PageExplainer } from '@/components/custom/nav/page-registry';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import StatFigure, { statLabel } from '@/components/custom/share-stats/stat-figures';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getTopVisitedPublications, type VisitedPublication } from '@/lib/database/services/publication-visit-service';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { availableCards, emptyReadingStats, type ReadingStats } from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { calendarDaysAgo, formatDayMonth, mergeVisitedByName } from '@/lib/stats/visited-publications';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, type ListRenderItem, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

/** "How Stats works": the ? beside "Your last 30 days" (FinalLibrary #10). */
export const STATS_EXPLAINER: PageExplainer = {
    titleKey: 'library.explainer.stats.title',
    paragraphKeys: ['library.explainer.stats.what', 'library.explainer.stats.how1', 'library.explainer.stats.how2'],
    chapter: 'library',
    slide: 'stats',
};

const COL_VISITS = 56;
const COL_LAST = 84;
const SHARE_H = 44;

interface Props {
    /** False while a warmed neighbour: reads once, then re-reads silently each
     *  time it becomes visible. Unset = always active. */
    readonly active?: boolean;
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    readonly headerHeight?: number;
    /** List-end padding: the tab bar and the Mera button. */
    readonly listEndPadding?: number;
    /** Opens History's explainer (the ? beside the page title). */
    readonly onExplain?: () => void;
}

function lastReadLabel(t: (k: 'common.today' | 'common.yesterday') => string, ms: number, locale?: string): string {
    const days = calendarDaysAgo(ms, Date.now());
    if (days <= 0) return t('common.today');
    if (days === 1) return t('common.yesterday');
    return formatDayMonth(ms, locale);
}

const TableRow: React.FC<{
    readonly item: VisitedPublication;
    readonly last: boolean;
    readonly locale?: string;
    readonly onOpen: (item: VisitedPublication) => void;
}> = ({ item, last, locale, onOpen }) => {
    const { t } = useTranslation();
    const c = useColors();
    const name = useDisplayPublication(item.publicationName);
    const lastRead = lastReadLabel(t, item.lastVisitedAt, locale);
    return (
        <TapPressable
            onPress={() => onOpen(item)}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${t('library.history.colVisits')} ${item.visitCount}, ${t('library.history.colLastRead')} ${lastRead}`}
            testID={`history-row-${item.publicationName}`}
            style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }, last ? styles.rowLast : null]}
        >
            <View style={styles.rowInner} pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <SourceFlag countryCode={item.countryCode} size="sm" />
                <Text numberOfLines={1} style={[styles.cellName, { color: c.ink }]}>
                    {name}
                </Text>
                <Text style={[styles.cellNum, { color: c.ink, width: COL_VISITS }]}>{String(item.visitCount)}</Text>
                <Text numberOfLines={1} style={[styles.cellNum, { color: c.ink2, width: COL_LAST }]}>
                    {lastRead}
                </Text>
                <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={c.ink3} />
            </View>
        </TapPressable>
    );
};

/** One Stats card as it sits on the page: its name, then its figure. */
export const StatTile: React.FC<{ readonly id: ReturnType<typeof availableCards>[number]; readonly stats: ReadingStats }> = ({ id, stats }) => {
    const { t } = useTranslation();
    const c = useColors();
    return (
        <View style={[styles.tile, { backgroundColor: c.surface, borderColor: c.line }]} testID={`stat-tile-${id}`}>
            <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, marginBottom: 6 }}>{statLabel(t, id)}</Text>
            <StatFigure id={id} stats={stats} variant="tile" />
        </View>
    );
};

const VisitedPublicationsList: React.FC<Props> = ({
    active = true,
    scrollHandler,
    headerHeight = 0,
    listEndPadding,
    onExplain,
}) => {
    const tabClearance = useTabBarClearance();
    const { t, i18n } = useTranslation();
    const c = useColors();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [statsExplainerOpen, setStatsExplainerOpen] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const [rows, loaded] = await Promise.all([getTopVisitedPublications(), loadReadingStats()]);
            setItems(mergeVisitedByName(rows));
            setStats(loaded);
        } catch (error) {
            logger.captureException(error, { tags: { screen: 'HistoryPage', method: 'load' } });
        }
    }, []);

    // Reload whenever the page becomes VISIBLE: a visit recorded meanwhile
    // (open an article at its source, come back) must show without a pull.
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

    const open = useCallback((item: VisitedPublication) => {
        openPublicationPage({ rawName: item.publicationName, countryCode: item.countryCode });
    }, []);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item, index }) => <TableRow item={item} last={index === items.length - 1} locale={i18n?.language} onOpen={open} />,
        [i18n?.language, open, items.length],
    );

    const cards = availableCards(stats);
    const shareShown = active && cards.length > 0;
    const listEnd = listEndPadding ?? tabClearance + 24;

    const listHeader = (
        <View>
            <PageTitleRow title={t('library.history.title')} onExplain={onExplain} testID="history-title-row" />
            {items.length > 0 ? (
                <>
                    <Text style={{ fontSize: 13, lineHeight: 18, color: c.ink2, marginBottom: 12 }} testID="history-intro">
                        {t('library.history.intro')}
                    </Text>
                    <View style={[styles.row, styles.rowFirst, { backgroundColor: c.surface, borderColor: c.line }]}>
                        <View style={styles.rowInner}>
                            <Text style={[styles.headCell, { color: c.ink3, flex: 1 }]}>{t('library.history.colPublication')}</Text>
                            <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_VISITS }]}>
                                {t('library.history.colVisits')}
                            </Text>
                            <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_LAST + 18 }]}>
                                {t('library.history.colLastRead')}
                            </Text>
                        </View>
                    </View>
                </>
            ) : null}
        </View>
    );

    const listFooter = (
        <View style={{ gap: 12 }}>
            {items.length > 0 ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3, marginTop: 8 }} testID="history-footnote">
                    {t('library.history.footnote')}
                </Text>
            ) : null}
            {cards.length > 0 ? (
                <View style={{ gap: 10, marginTop: 12 }} testID="history-stats">
                    <PageTitleRow
                        title={t('library.stats.title')}
                        onExplain={() => setStatsExplainerOpen(true)}
                        testID="stats-title-row"
                    />
                    {cards.map((id) => (
                        <StatTile key={id} id={id} stats={stats} />
                    ))}
                    <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3, textAlign: 'center' }}>
                        {t('library.stats.counted')}
                    </Text>
                </View>
            ) : null}
        </View>
    );

    return (
        <Box className="flex-1">
            <Animated.FlatList
                testID="visited-publications-list"
                data={items}
                renderItem={renderItem}
                keyExtractor={(item: VisitedPublication) => `${item.publicationName}::${item.countryCode ?? ''}`}
                ListHeaderComponent={listHeader}
                ListFooterComponent={listFooter}
                ListEmptyComponent={
                    isLoading ? (
                        <Box className="items-center justify-center py-20">
                            <Spinner size="large" />
                        </Box>
                    ) : (
                        <ForYouEmptyState
                            icon="history"
                            title={t('library.visited.emptyTitle')}
                            body={t('library.history.emptyBody')}
                            action={{
                                label: t('library.history.learn'),
                                onPress: () => openTutorial('library', 'history'),
                                testID: 'history-learn',
                            }}
                            testID="visited-publications-empty"
                        />
                    )
                }
                contentContainerStyle={{
                    paddingTop: headerHeight + 12,
                    paddingHorizontal: 12,
                    // Clear of the Mera button, and of the floating Share above it.
                    paddingBottom: listEnd + (shareShown ? SHARE_H + 12 : 0),
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
                    testID="history-share"
                    style={[styles.share, { bottom: listEnd, backgroundColor: c.accent }]}
                >
                    <MaterialIcons name="ios-share" size={17} color={c.onAccent} />
                    <Text style={{ color: c.onAccent, fontSize: 14, lineHeight: 18, fontWeight: '700' }}>
                        {t('library.stats.share')}
                    </Text>
                </Pressable>
            ) : null}

            <PageExplainerSheet
                explainer={STATS_EXPLAINER}
                open={statsExplainerOpen}
                onClose={() => setStatsExplainerOpen(false)}
            />
        </Box>
    );
};

const styles = StyleSheet.create({
    row: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        minHeight: 44,
        justifyContent: 'center',
    },
    rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
    rowLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
    cellName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
    cellNum: { fontSize: 14, lineHeight: 19, textAlign: 'right' },
    headCell: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
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

export default VisitedPublicationsList;
