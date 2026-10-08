// The Library's Stats page: the reader's last 30 days as plain cards (one per
// figure with data, `availableCards`, never a screen-level "has any data"
// gate), the "counted on this phone" line, and one floating Share above the
// Mera button. Share works IN PLACE (owner, `share-flow.ts`): Share puts the
// page in select mode (a checkbox on every card, all picked), the floating
// Share becomes [Cancel] [Preview], and Preview opens StatsShareModal with the
// picks packed onto as few images as fit (measured). Closing the preview by
// any route, Cancel, back or leaving the page all end select mode. The
// floating controls sit centred in the Mera button's row (its bottom and size
// from tab-bar), capped clear of either corner's column.
//
// "Clear viewing history" empties the visit figures but not Right now, which
// stays while there are saves or followed stories.

import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';
import StatFigure, { statLabel } from '@/components/custom/share-stats/stat-figures';
import StatsShareModal, { type PreviewBox } from '@/components/custom/share-stats/StatsShareModal';
import { IDLE, shareFlow } from '@/components/custom/library/share-flow';
import { PackMeasure, packGroups, type PackMeasurement } from '@/components/custom/share-stats/stat-image';
import { hapticSelection } from '@/lib/haptics';
import {
    MERA_BUTTON_EDGE,
    MERA_BUTTON_SIZE,
    useMeraButtonBottom,
    useTabBarClearance,
} from '@/lib/navigation/tab-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

const SHARE_H = 44;
/** Under the page strip's pill track (safe area + 47): the preview's top. */
const PREVIEW_TOP = 52;
/** Between Cancel and Preview. */
const FLOAT_GAP = 8;
/** The round Cancel (✕). */
const CANCEL_D = 44;
/** Clear space between the floating button and the Mera button's column. */
const MERA_SIDE_GAP = 8;

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

/** One Stats card as it sits on the page: its name, then its figure. In
 *  select mode the whole card is ONE checkbox (role, checked state). */
const StatTile: React.FC<{
    readonly id: StatsCardId;
    readonly stats: ReadingStats;
    readonly picked?: boolean;
    readonly onToggle?: (id: StatsCardId) => void;
}> = ({ id, stats, picked, onToggle }) => {
    const { t } = useTranslation();
    const c = useColors();
    const selecting = onToggle !== undefined;
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
    if (!selecting) {
        return (
            <View style={frame} testID={`stat-tile-${id}`}>
                {body}
            </View>
        );
    }
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
    // The floating button sits in the Mera button's row: centred on the
    // screen, the same vertical centre, never into either corner's column.
    const meraBottom = useMeraButtonBottom();
    const { width: screenW } = useWindowDimensions();
    const floatMaxW = screenW - 2 * (MERA_BUTTON_EDGE + MERA_BUTTON_SIZE + MERA_SIDE_GAP);
    // The preview's box in window points: under the strip, above the tab bar.
    // The page's own bottom in the window anchors both bottoms (on iOS the tab
    // content runs under the bar; on Android it ends at it).
    const insets = useSafeAreaInsets();
    const tabClearance = useTabBarClearance();
    const { height: screenH } = useWindowDimensions();
    const rootRef = useRef<View>(null);
    const [pageBottomGap, setPageBottomGap] = useState(0);
    const measureRoot = useCallback(() => {
        rootRef.current?.measureInWindow((_x, y, _w, h) => {
            if (Number.isFinite(y) && h > 0) setPageBottomGap(Math.max(0, screenH - (y + h)));
        });
    }, [screenH]);
    const previewBox: PreviewBox = {
        top: insets.top + PREVIEW_TOP,
        bottom: pageBottomGap + tabClearance,
        meraBottom: pageBottomGap + meraBottom,
    };

    // ── Share in place ──
    const [flow, dispatch] = useReducer(shareFlow, IDLE);
    const { selecting, picked, previewOpen } = flow;
    const [measure, setMeasure] = useState<PackMeasurement | null>(null);
    // [✕] [Preview]: Preview's glyph only when its label leaves room for it.
    const [previewLabelW, setPreviewLabelW] = useState<number | null>(null);
    const previewGlyphFits =
        previewLabelW !== null && CANCEL_D + FLOAT_GAP + 2 * 14 + 17 + 6 + previewLabelW <= floatMaxW;
    const startSelecting = useCallback(() => dispatch({ type: 'start', cards: availableCards(stats) }), [stats]);
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

    return (
        <View ref={rootRef} style={{ flex: 1 }} onLayout={measureRoot} collapsable={false}>
            <Animated.FlatList
                testID="stats-page"
                data={cards}
                keyExtractor={(id: StatsCardId) => id}
                renderItem={({ item }: { item: StatsCardId }) => (
                    <StatTile
                        id={item}
                        stats={stats}
                        picked={picked.includes(item)}
                        onToggle={selecting ? toggle : undefined}
                    />
                )}
                extraData={selecting ? picked : null}
                ItemSeparatorComponent={() => <View style={{ height: PAGE_TITLE_GAP }} />}
                ListHeaderComponent={
                    <View style={{ marginBottom: PAGE_TITLE_GAP }}>
                        <PageTitleRow
                            title={t('library.stats.title')}
                            onExplain={onExplain}
                            testID="stats-title-row"
                        />
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
                    // Clear of the Mera button's row, which the floating button shares.
                    paddingBottom: listEndPadding,
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

            {/* One floating button above the Mera button (its top plus the
                list-end gap, derived, never a literal): Share, then Preview. */}
            {shareShown ? (
                <View
                    pointerEvents="box-none"
                    style={[styles.floatRow, { bottom: meraBottom + (MERA_BUTTON_SIZE - SHARE_H) / 2 }]}
                >
                    <View style={[styles.floatGroup, { maxWidth: floatMaxW }]}>
                        {selecting ? (
                            <Pressable
                                onPress={stopSelecting}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.cancel')}
                                testID="stats-select-cancel"
                                style={[styles.cancelRound, { borderColor: c.line, backgroundColor: c.base }]}
                            >
                                <MaterialIcons name="close" size={20} color={c.ink} />
                            </Pressable>
                        ) : null}
                        <Pressable
                            onPress={selecting ? () => dispatch({ type: 'preview' }) : startSelecting}
                            disabled={selecting && picked.length === 0}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: selecting && picked.length === 0 }}
                            accessibilityLabel={selecting ? t('shareStats.preview.title') : t('library.stats.share')}
                            testID={selecting ? 'stats-preview' : 'stats-share'}
                            style={[
                                styles.pill,
                                {
                                    backgroundColor: c.accent,
                                    opacity: selecting && picked.length === 0 ? 0.45 : 1,
                                },
                            ]}
                        >
                            {/* Preview keeps its glyph only where its label leaves room
                                beside the round Cancel (measured, below). */}
                            {selecting && !previewGlyphFits ? null : (
                                <MaterialIcons name={selecting ? 'visibility' : 'ios-share'} size={17} color={c.onAccent} />
                            )}
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                scaleTier="chrome"
                                style={{ flexShrink: 1, color: c.onAccent, fontSize: 14, lineHeight: 18, fontWeight: '700' }}
                            >
                                {selecting ? t('shareStats.preview.title') : t('library.stats.share')}
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
    );
};

const styles = StyleSheet.create({
    tile: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
    tileHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
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
