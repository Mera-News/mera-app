// The Library's History page (FinalLibrary #7-9): the publications whose
// sites the reader opened in the last 30 days as a table (flag, publication,
// visits, last read), the column headings above it. The page id stays
// `visited`. The Stats are their own page (library/StatsPage).
//
// Visits are RAW visits (taps) summed across every name a publication is known
// by (`mergeVisitedByName`); the publication page's "opened N times" counts the
// same rows. Subscribe and Support live on the publication page only, so this
// page makes no per-row network lookup.

import TapPressable from '@/components/custom/cards/TapPressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getTopVisitedPublications, type VisitedPublication } from '@/lib/database/services/publication-visit-service';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { calendarDaysAgo, formatDayMonth, mergeVisitedByName } from '@/lib/stats/visited-publications';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, type ListRenderItem, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';

const COL_VISITS = 56;
const COL_LAST = 84;

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
    readonly first: boolean;
    readonly last: boolean;
    readonly locale?: string;
    readonly onOpen: (item: VisitedPublication) => void;
}> = ({ item, first, last, locale, onOpen }) => {
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
            style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }, first ? styles.rowFirst : null, last ? styles.rowLast : null]}
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
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            setItems(mergeVisitedByName(await getTopVisitedPublications()));
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
        // History lands on the publication's own History view (owner); every
        // other entry point keeps the default.
        openPublicationPage({ rawName: item.publicationName, countryCode: item.countryCode }, 'HISTORY');
    }, []);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item, index }) => <TableRow item={item} first={index === 0} last={index === items.length - 1} locale={i18n?.language} onOpen={open} />,
        [i18n?.language, open, items.length],
    );

    const listEnd = listEndPadding ?? tabClearance + 24;

    const listHeader = (
        <View>
            <View style={{ marginBottom: PAGE_TITLE_GAP }}>
                <PageTitleRow title={t('library.history.title')} onExplain={onExplain} testID="history-title-row" />
            </View>
            {items.length > 0 ? (
                <>
                    <Text
                        style={{ fontSize: 13, lineHeight: 18, color: c.ink2, marginHorizontal: 4, marginBottom: PAGE_TITLE_GAP }}
                        testID="history-intro"
                    >
                        {t('library.history.intro')}
                    </Text>
                    {/* Column headings above the card (FinalLibrary: padding 0 14 6). */}
                    <View style={styles.headRow}>
                        <Text style={[styles.headCell, { color: c.ink3, flex: 1 }]}>{t('library.history.colPublication')}</Text>
                        <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_VISITS }]}>
                            {t('library.history.colVisits')}
                        </Text>
                        <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_LAST + 18 }]}>
                            {t('library.history.colLastRead')}
                        </Text>
                    </View>
                </>
            ) : null}
        </View>
    );

    const listFooter =
        items.length > 0 ? (
            <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3, marginTop: 8 }} testID="history-footnote">
                {t('library.history.footnote')}
            </Text>
        ) : null;

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
                    paddingTop: headerHeight + PAGE_CONTENT_GAP,
                    paddingHorizontal: PAGE_SIDE_INSET,
                    // Clear of the Mera button, and of the floating Share above it.
                    paddingBottom: listEnd,
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

        </Box>
    );
};

const styles = StyleSheet.create({
    // The board's History table (FinalLibrary): radius 16, rows 52pt with 8/14
    // padding, the column headings above the card (padding 0 14 6).
    row: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        minHeight: 52,
        justifyContent: 'center',
    },
    rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 6 },
    rowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
    cellName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
    cellNum: { fontSize: 14, lineHeight: 19, textAlign: 'right' },
    headCell: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
});

export default VisitedPublicationsList;
