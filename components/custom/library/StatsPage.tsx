// The Library's Activity page (page id `stats`): the title row ("Your last 30
// days", the "counted on this phone" line, an outlined Share pill), then the
// reader's last 30 days as cards (one per figure with data, `availableCards`,
// never a screen-level "has any data" gate). Most opened leads and opens
// History; with no Most opened a plain History row stands in its place, so
// History stays reachable. Every other card opens its detail screen
// (`OPENS`); Right now's two rows open Saved and the followed stories.
//
// Share works IN PLACE (owner, `share-flow.ts`): the pill puts the page in
// select mode (every card a checkbox drawn as its share figure, all picked),
// a floating [Cancel] [Preview] sits centred in the Mera button's row, and
// Preview opens StatsShareModal with the picks packed onto as few images as
// fit (measured). Closing the preview by any route, Cancel, back or leaving
// the page all end select mode.
//
// "Clear viewing history" empties the visit figures but not Right now, which
// stays while there are saves or followed stories.

import TapPressable from '@/components/custom/cards/TapPressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { openLibraryScreen, SharePill, ShareBar } from '@/components/custom/library/activity-ui';
import { IDLE, shareFlow } from '@/components/custom/library/share-flow';
import { usePreviewBox } from '@/components/custom/library/use-preview-box';
import { navigateToPage } from '@/components/custom/nav/navigate-to-page';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP, type LibraryScreen } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import { useTrackedScroll } from '@/components/custom/nav/use-tracked-scroll';
import { CardPaletteContext, inAppCardPalette } from '@/components/custom/share-stats/card-theme';
import StatFigure, { statLabel } from '@/components/custom/share-stats/stat-figures';
import { PackMeasure, packGroups, type PackMeasurement } from '@/components/custom/share-stats/stat-image';
import StatsShareModal from '@/components/custom/share-stats/StatsShareModal';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { hapticSelection } from '@/lib/haptics';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { MERA_BUTTON_EDGE, MERA_BUTTON_SIZE, useMeraButtonBottom } from '@/lib/navigation/tab-bar';
import { availableCards, emptyReadingStats, type ReadingStats, type StatsCardId } from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, I18nManager, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

const SHARE_H = 44;
/** Between Cancel and Preview. */
const FLOAT_GAP = 8;
/** The round Cancel (✕). */
const CANCEL_D = 44;
/** Clear space between the floating button and the Mera button's column. */
const MERA_SIDE_GAP = 8;

/** The screen each card opens. Right now has none (its rows open Saved and Stories). */
const OPENS: Partial<Record<StatsCardId, LibraryScreen>> = {
    top: 'history',
    publications: 'where-you-read',
    languages: 'languages',
    days: 'reading-log',
    opened: 'reading-log',
    fresh: 'freshness',
};

/** Most opened leads the page (owner); the rest keep the figures' order. */
function pageOrder(cards: readonly StatsCardId[]): StatsCardId[] {
    return cards.includes('top') ? ['top', ...cards.filter((id) => id !== 'top')] : [...cards];
}

interface Props {
    /** False while a warmed neighbour: reads once, then re-reads silently each
     *  time it becomes visible. */
    readonly active: boolean;
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    readonly headerHeight: number;
    /** List-end padding: the tab bar and the Mera button. */
    readonly listEndPadding: number;
}

const Chevron: React.FC<{ readonly color: string; readonly size?: number }> = ({ color, size = 22 }) => (
    <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={size} color={color} />
);

/** One card as it sits on the page. Out of select mode it opens its screen
 *  (chevron in its head); in select mode the whole card is ONE checkbox. */
const StatTile: React.FC<{
    readonly id: StatsCardId;
    readonly stats: ReadingStats;
    readonly picked?: boolean;
    readonly onToggle?: (id: StatsCardId) => void;
}> = ({ id, stats, picked, onToggle }) => {
    const { t } = useTranslation();
    const c = useColors();
    const selecting = onToggle !== undefined;
    const opens = OPENS[id];
    const body = (
        <>
            <View style={styles.tileHead}>
                <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, flex: 1 }}>{statLabel(t, id)}</Text>
                {selecting ? (
                    <MaterialIcons
                        name={picked ? 'check-box' : 'check-box-outline-blank'}
                        size={22}
                        color={picked ? c.accent : c.ink3}
                    />
                ) : opens ? (
                    <Chevron color={c.ink3} />
                ) : null}
            </View>
            <StatFigure id={id} stats={stats} variant="tile" />
        </>
    );
    const frame = [
        styles.tile,
        {
            backgroundColor: c.surface,
            borderColor: selecting && picked ? c.accent : c.line,
            borderWidth: selecting && picked ? 1.5 : StyleSheet.hairlineWidth,
        },
    ];
    if (selecting) {
        return (
            <Pressable
                onPress={() => onToggle(id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !!picked }}
                accessibilityLabel={statLabel(t, id)}
                testID={`stat-tile-${id}`}
                style={frame}
            >
                <View pointerEvents="none">{body}</View>
            </Pressable>
        );
    }
    if (!opens) {
        return (
            <View style={frame} testID={`stat-tile-${id}`}>
                {body}
            </View>
        );
    }
    return (
        <TapPressable onPress={() => openLibraryScreen(opens)} accessibilityRole="button" testID={`stat-tile-${id}`} style={frame}>
            <View pointerEvents="none">{body}</View>
        </TapPressable>
    );
};

/** A Most opened row: flag, name, count, a bar against the leader. */
const TopRow: React.FC<{
    readonly name: string;
    readonly countryCode: string | null;
    readonly count: number;
    readonly share: number;
    readonly lead: boolean;
}> = ({ name, countryCode, count, share, lead }) => {
    const { t } = useTranslation();
    const c = useColors();
    const shown = useDisplayPublication(name);
    return (
        <View style={{ gap: 6 }}>
            <View style={styles.topLine}>
                <SourceFlag countryCode={countryCode} size={lead ? 'lg' : 'sm'} />
                <Text
                    numberOfLines={lead ? 2 : 1}
                    style={{ flex: 1, color: c.ink, fontWeight: lead ? '700' : '600', fontSize: lead ? 28 : 15, lineHeight: lead ? 36 : 22 }}
                >
                    {shown}
                </Text>
                <Text style={{ color: lead ? c.ink : c.ink2, fontSize: 14, lineHeight: 21, fontWeight: lead ? '700' : '400' }}>
                    {lead ? t('library.activity.visits', { count }) : String(count)}
                </Text>
            </View>
            <ShareBar share={share} strong={lead} />
        </View>
    );
};

/** Most opened (Activity board): the top publication large, the next two
 *  smaller, all publications below; the whole card opens History. */
const MostOpenedCard: React.FC<{ readonly stats: ReadingStats }> = ({ stats }) => {
    const { t } = useTranslation();
    const c = useColors();
    const [first] = stats.topPublications;
    if (!first) return null;
    return (
        <TapPressable
            onPress={() => openLibraryScreen('history')}
            accessibilityRole="button"
            accessibilityLabel={`${statLabel(t, 'top')}, ${first.publicationName}, ${t('library.activity.visits', { count: first.visitCount })}. ${t('publicationPage.history')}`}
            testID="stat-tile-top"
            style={[styles.tile, styles.topCard, { backgroundColor: c.surface, borderColor: c.line }]}
        >
            <View pointerEvents="none" style={{ gap: 14 }}>
                <View style={styles.tileHead}>
                    <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, flex: 1 }}>{statLabel(t, 'top')}</Text>
                    <Text style={{ color: c.accentText, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>{t('publicationPage.history')}</Text>
                    <Chevron color={c.accentText} size={20} />
                </View>
                {stats.topPublications.map((p, i) => (
                    <TopRow
                        key={`${p.publicationName}::${p.countryCode ?? ''}`}
                        name={p.publicationName}
                        countryCode={p.countryCode}
                        count={p.visitCount}
                        share={p.visitCount / first.visitCount}
                        lead={i === 0}
                    />
                ))}
                <View style={[styles.allRow, { borderTopColor: c.line }]}>
                    <Text style={{ flex: 1, color: c.ink2, fontSize: 14, lineHeight: 21 }}>
                        {t('library.activity.allPublications', { count: stats.publicationCount })}
                    </Text>
                    <MaterialIcons name={I18nManager.isRTL ? 'arrow-back' : 'arrow-forward'} size={20} color={c.ink2} />
                </View>
            </View>
        </TapPressable>
    );
};

/** No Most opened to show: a plain row keeps History one tap away. */
const HistoryRow: React.FC = () => {
    const { t } = useTranslation();
    const c = useColors();
    return (
        <TapPressable
            onPress={() => openLibraryScreen('history')}
            accessibilityRole="button"
            accessibilityLabel={t('publicationPage.history')}
            testID="stats-history-row"
            style={[styles.tile, styles.historyRow, { backgroundColor: c.surface, borderColor: c.line }]}
        >
            <View pointerEvents="none" style={styles.nowRow}>
                <MaterialIcons name="history" size={20} color={c.ink2} />
                <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }}>{t('publicationPage.history')}</Text>
                <Chevron color={c.ink3} />
            </View>
        </TapPressable>
    );
};

/** Right now: no page of its own; saved opens Saved, followed the Stories page. */
const NowTile: React.FC<{ readonly stats: ReadingStats }> = ({ stats }) => {
    const { t } = useTranslation();
    const c = useColors();
    const { savedArticles, followedStories } = stats.keptNow;
    const row = (count: number, line: string, onPress: () => void, testID: string, divider: boolean) => (
        <TapPressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`${count} ${line}`}
            testID={testID}
            style={[styles.nowTap, divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line } : null]}
        >
            <View pointerEvents="none" style={styles.nowRow}>
                <Text style={{ color: c.ink, fontSize: 30, lineHeight: 38, fontWeight: '700' }}>{String(count)}</Text>
                <Text style={{ flex: 1, color: c.ink2, fontSize: 13, lineHeight: 18 }}>{line}</Text>
                <Chevron color={c.ink3} />
            </View>
        </TapPressable>
    );
    return (
        <View style={[styles.tile, styles.nowTile, { backgroundColor: c.surface, borderColor: c.line }]} testID="stat-tile-now">
            <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18 }}>{statLabel(t, 'now')}</Text>
            {savedArticles > 0
                ? row(savedArticles, t('library.stats.savedLine', { count: savedArticles }), () => navigateToPage('saved'), 'stats-now-saved', false)
                : null}
            {followedStories > 0
                ? row(
                      followedStories,
                      t('library.stats.followedLine', { count: followedStories }),
                      () => navigateToPage('stories'),
                      'stats-now-followed',
                      savedArticles > 0,
                  )
                : null}
        </View>
    );
};

const StatsPage: React.FC<Props> = ({ active, scrollHandler, headerHeight, listEndPadding }) => {
    const { t } = useTranslation();
    const themeMode = useThemeMode();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.FlatList<StatsCardId>>(null);
    const tracked = useTrackedScroll(scrollHandler);
    usePageScrollTarget(listRef, { getOffset: tracked.getOffset });
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

    const cards = useMemo(() => pageOrder(availableCards(stats)), [stats]);
    // The floating Cancel / Preview sit in the Mera button's row: centred on
    // the screen, the same vertical centre, never into either corner's column.
    const meraBottom = useMeraButtonBottom();
    const { width: screenW } = useWindowDimensions();
    const floatMaxW = screenW - 2 * (MERA_BUTTON_EDGE + MERA_BUTTON_SIZE + MERA_SIDE_GAP);
    const { rootRef, onLayout, box: previewBox } = usePreviewBox();

    // ── Share in place ──
    const [flow, dispatch] = useReducer(shareFlow, IDLE);
    const { selecting, picked, previewOpen } = flow;
    const [measure, setMeasure] = useState<PackMeasurement | null>(null);
    // [✕] [Preview]: Preview's glyph only when its label leaves room for it.
    const [previewLabelW, setPreviewLabelW] = useState<number | null>(null);
    const previewGlyphFits =
        previewLabelW !== null && CANCEL_D + FLOAT_GAP + 2 * 14 + 17 + 6 + previewLabelW <= floatMaxW;
    const startSelecting = useCallback(() => dispatch({ type: 'start', cards }), [cards]);
    const stopSelecting = useCallback(() => dispatch({ type: 'cancel' }), []);
    const closePreview = useCallback(() => dispatch({ type: 'closePreview' }), []);
    const toggle = useCallback((id: StatsCardId) => {
        void hapticSelection();
        dispatch({ type: 'toggle', id });
    }, []);
    // Picks in page order, whatever order they were ticked in.
    const groups = useMemo(
        () => packGroups(cards.filter((id) => picked.includes(id)), measure),
        [cards, picked, measure],
    );
    // Leaving the page (a swipe, a tab switch) leaves select mode.
    useEffect(() => {
        if (!visible) stopSelecting();
    }, [visible, stopSelecting]);
    // Android back leaves select mode first (the modal handles its own).
    useEffect(() => {
        if (!selecting || !visible) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            stopSelecting();
            return true;
        });
        return () => sub.remove();
    }, [selecting, visible, stopSelecting]);

    const renderItem = ({ item }: { item: StatsCardId }) => {
        if (selecting) return <StatTile id={item} stats={stats} picked={picked.includes(item)} onToggle={toggle} />;
        if (item === 'top') return <MostOpenedCard stats={stats} />;
        if (item === 'now') return <NowTile stats={stats} />;
        return <StatTile id={item} stats={stats} />;
    };

    const listHeader =
        cards.length > 0 ? (
            <View style={{ marginBottom: PAGE_TITLE_GAP + 2, gap: PAGE_TITLE_GAP + 2 }}>
                <View style={styles.titleRow}>
                    <View style={{ flex: 1 }}>
                        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, lineHeight: 34, fontWeight: '700' }} testID="stats-title">
                            {t('library.stats.title')}
                        </Text>
                        <Text style={{ color: c.ink3, fontSize: 13, lineHeight: 19 }}>{t('library.stats.counted')}</Text>
                    </View>
                    {active && !selecting ? <SharePill onPress={startSelecting} testID="stats-share" /> : null}
                </View>
                {!selecting && !cards.includes('top') ? <HistoryRow /> : null}
            </View>
        ) : null;

    return (
        // The cards follow the app's theme (the share images choose their own).
        <CardPaletteContext.Provider value={inAppCardPalette(themeMode)}>
        <View ref={rootRef} style={{ flex: 1 }} onLayout={onLayout} collapsable={false}>
            <Animated.FlatList
                ref={listRef}
                testID="stats-page"
                data={cards}
                keyExtractor={(id: StatsCardId) => id}
                renderItem={renderItem}
                extraData={selecting ? picked : stats}
                ItemSeparatorComponent={() => <View style={{ height: PAGE_TITLE_GAP }} />}
                ListHeaderComponent={listHeader}
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
                    // Clear of the Mera button's row, which Cancel / Preview share.
                    paddingBottom: listEndPadding,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ? tracked.onScroll : notifyScrollTick}
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

            {/* Select mode: [✕] [Preview] above the Mera button (its row,
                derived, never a literal). */}
            {active && selecting ? (
                <View
                    pointerEvents="box-none"
                    style={[styles.floatRow, { bottom: meraBottom + (MERA_BUTTON_SIZE - SHARE_H) / 2 }]}
                >
                    <View style={[styles.floatGroup, { maxWidth: floatMaxW }]}>
                        <Pressable
                            onPress={stopSelecting}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                            testID="stats-select-cancel"
                            style={[styles.cancelRound, { borderColor: c.line, backgroundColor: c.base }]}
                        >
                            <MaterialIcons name="close" size={20} color={c.ink} />
                        </Pressable>
                        <Pressable
                            onPress={() => dispatch({ type: 'preview' })}
                            disabled={picked.length === 0}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: picked.length === 0 }}
                            accessibilityLabel={t('shareStats.preview.title')}
                            testID="stats-preview"
                            style={[styles.pill, { backgroundColor: c.accent, opacity: picked.length === 0 ? 0.45 : 1 }]}
                        >
                            {/* Preview keeps its glyph only where its label leaves room
                                beside the round Cancel (measured, below). */}
                            {previewGlyphFits ? <MaterialIcons name="visibility" size={17} color={c.onAccent} /> : null}
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                scaleTier="chrome"
                                style={{ flexShrink: 1, color: c.onAccent, fontSize: 14, lineHeight: 18, fontWeight: '700' }}
                            >
                                {t('shareStats.preview.title')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            {/* Preview's label at its natural width, to decide on its glyph. */}
            {selecting ? (
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.measure}>
                    <Text
                        scaleTier="chrome"
                        style={{ fontSize: 14, lineHeight: 18, fontWeight: '700' }}
                        onTextLayout={(e) => setPreviewLabelW(Math.max(0, ...e.nativeEvent.lines.map((l) => l.width)))}
                    >
                        {t('shareStats.preview.title')}
                    </Text>
                </View>
            ) : null}
            {selecting ? <PackMeasure cards={cards} stats={stats} onMeasured={setMeasure} /> : null}
            <StatsShareModal open={previewOpen} onClose={closePreview} groups={groups} stats={stats} box={previewBox} />
        </View>
        </CardPaletteContext.Provider>
    );
};

const styles = StyleSheet.create({
    tile: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
    tileHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 2 },
    topCard: { borderRadius: 16, padding: 16 },
    topLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    allRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, marginBottom: -6, borderTopWidth: StyleSheet.hairlineWidth },
    historyRow: { paddingVertical: 10 },
    nowTile: { paddingBottom: 6 },
    nowTap: { minHeight: 56, justifyContent: 'center' },
    nowRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    floatRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    floatGroup: { flexDirection: 'row', alignItems: 'center', gap: FLOAT_GAP },
    pill: {
        height: SHARE_H,
        paddingHorizontal: 14,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
    },
    cancelRound: {
        width: CANCEL_D,
        height: CANCEL_D,
        borderRadius: CANCEL_D / 2,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    measure: { position: 'absolute', left: -8000, top: 0, width: 4000, opacity: 0, alignItems: 'flex-start' },
});

export default StatsPage;
