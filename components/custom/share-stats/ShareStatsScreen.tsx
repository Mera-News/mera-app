// Sharing the Stats (FinalLibrary #11-13), pushed in the Library tab's stack
// from History's one Share button. Two steps on one screen:
//
// - Choose: every card with data, each a checkbox; a picked card gets an
//   orange edge, nothing is picked at first, and the button counts what will
//   be made ("Preview 3 images").
// - Preview: one image per pick, swiped through, on a Dark or Light background
//   whatever the app theme (not stored). Each image has its own Share (owner
//   default L1, a share sheet takes one file, and sheets are never chained).
//
// A stack screen, not a page: a horizontal pager inside a TabPages page
// cannot hand an edge swipe on to the next page.
//
// The image is captured from ONE off-screen host at the export size, drawn
// with the picked palette (capture-and-share keeps its native imports
// dynamic). Publication names only leave the phone through Most opened.

import { CARD_PALETTES, CardPaletteContext } from '@/components/custom/share-stats/card-theme';
import CardShell, { DESIGN_WIDTH, fitCardToPage, hostSizeForScale } from '@/components/custom/share-stats/card-shell';
import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import StatFigure, { statLabel, statWindowTitle } from '@/components/custom/share-stats/stat-figures';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { Pressable } from '@/components/ui/pressable';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { hapticSelection } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { availableCards, emptyReadingStats, type ReadingStats, type StatsCardId } from '@/lib/stats/reading-stats';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, PixelRatio, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Background = 'dark' | 'light';

/** One shared image: the shell (logo, window line, privacy line) around a figure. */
const StatImage = React.forwardRef<View, {
    readonly id: StatsCardId;
    readonly stats: ReadingStats;
    readonly hostSize?: { width: number; height: number };
}>(function StatImage({ id, stats, hostSize }, ref) {
    const { t } = useTranslation();
    const pixelRatio = PixelRatio.get();
    const host = hostSize ?? hostSizeForScale(pixelRatio);
    return (
        <CardShell
            ref={ref}
            title={statWindowTitle(t, id)}
            privacyLine={t('shareStats.card.privacyMine')}
            pixelRatio={pixelRatio}
            hostSize={hostSize}
            testID={`share-image-${id}`}
        >
            <StatFigure id={id} stats={stats} variant="image" k={host.width / DESIGN_WIDTH} />
        </CardShell>
    );
});

const ShareStatsScreen: React.FC = () => {
    const { t } = useTranslation();
    const c = useColors();
    const insets = useSafeAreaInsets();
    const listEnd = useListEndClearance();
    const { width: screenW, height: screenH } = useWindowDimensions();

    const [stats, setStats] = useState<ReadingStats>(emptyReadingStats);
    const [loading, setLoading] = useState(true);
    const [step, setStep] = useState<'choose' | 'preview'>('choose');
    const [picked, setPicked] = useState<readonly StatsCardId[]>([]);
    const [background, setBackground] = useState<Background>('dark');
    const [index, setIndex] = useState(0);
    const [sharing, setSharing] = useState(false);
    const [failure, setFailure] = useState<'unavailable' | 'failed' | null>(null);
    const hostRef = useRef<View>(null);

    useEffect(() => {
        let live = true;
        loadReadingStats()
            .then((s) => live && setStats(s))
            .finally(() => live && setLoading(false));
        return () => {
            live = false;
        };
    }, []);

    const cards = availableCards(stats);
    // Picks in page order, whatever order they were ticked in.
    const images = useMemo(() => cards.filter((id) => picked.includes(id)), [cards, picked]);

    const toggle = useCallback((id: StatsCardId) => {
        void hapticSelection();
        setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
    }, []);

    const itemW = screenW - 64;
    const imageSize = fitCardToPage({ width: itemW, height: screenH * 0.55 });
    const host = hostSizeForScale(PixelRatio.get());
    const current = images[Math.min(index, images.length - 1)];

    const share = useCallback(() => {
        if (!current || sharing) return;
        setFailure(null);
        setSharing(true);
        // Two frames, so the off-screen host has drawn this card and palette.
        requestAnimationFrame(() =>
            requestAnimationFrame(async () => {
                const result = await captureAndShare({
                    ref: hostRef,
                    hostWidth: host.width,
                    hostHeight: host.height,
                    dialogTitle: t('shareStats.shareDialogTitle'),
                });
                if (result.status === 'failed') {
                    logger.captureException(result.error, { tags: { screen: 'ShareStatsScreen', method: 'share' } });
                }
                setFailure(result.status === 'shared' ? null : result.status);
                setSharing(false);
            }),
        );
    }, [current, sharing, host.width, host.height, t]);

    const primary = (label: string, onPress: () => void, disabled: boolean, testID: string, icon?: 'ios-share') => (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityLabel={label}
            testID={testID}
            style={[styles.primary, { backgroundColor: c.accent, opacity: disabled ? 0.45 : 1, marginBottom: listEnd }]}
        >
            {icon ? <MaterialIcons name={icon} size={18} color={c.onAccent} /> : null}
            <Text style={{ color: c.onAccent, fontSize: 16, lineHeight: 21, fontWeight: '700' }}>{label}</Text>
        </Pressable>
    );

    if (loading) {
        return (
            <View style={[styles.screen, { paddingTop: insets.top, backgroundColor: c.base }]}>
                <Spinner size="large" />
            </View>
        );
    }

    if (step === 'choose') {
        return (
            // DrillDownHeader draws no status-bar inset of its own: the screen pads it.
            <View style={[styles.screen, { paddingTop: insets.top, backgroundColor: c.base }]} testID="share-stats-choose">
                <DrillDownHeader
                    title={t('shareStats.choose.title')}
                    rightAction={
                        <Pressable onPress={() => router.back()} accessibilityRole="button" testID="share-stats-cancel" style={styles.textButton}>
                            <Text style={{ color: c.accentText, fontSize: 16, lineHeight: 21, fontWeight: '600' }}>{t('common.cancel')}</Text>
                        </Pressable>
                    }
                    backDisabled
                />
                <ScrollView contentContainerStyle={{ padding: 12, paddingTop: SUBPAGE_TOP_GAP, gap: 10 }}>
                    <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18 }}>{t('shareStats.choose.help')}</Text>
                    {cards.map((id) => {
                        const on = picked.includes(id);
                        return (
                            <Pressable
                                key={id}
                                onPress={() => toggle(id)}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: on }}
                                accessibilityLabel={statLabel(t, id)}
                                testID={`share-stats-pick-${id}`}
                                style={[styles.tile, { backgroundColor: c.surface, borderColor: on ? c.accent : c.line, borderWidth: on ? 1.5 : StyleSheet.hairlineWidth }]}
                            >
                                <View style={styles.tileHead} pointerEvents="none">
                                    <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, flex: 1 }}>{statLabel(t, id)}</Text>
                                    <MaterialIcons name={on ? 'check-box' : 'check-box-outline-blank'} size={22} color={on ? c.accent : c.ink3} />
                                </View>
                                <View pointerEvents="none">
                                    <StatFigure id={id} stats={stats} variant="tile" />
                                </View>
                            </Pressable>
                        );
                    })}
                </ScrollView>
                <View style={{ paddingHorizontal: 12 }}>
                    {primary(
                        t('shareStats.choose.preview', { count: picked.length }),
                        () => {
                            setIndex(0);
                            setStep('preview');
                        },
                        picked.length === 0,
                        'share-stats-preview',
                    )}
                </View>
            </View>
        );
    }

    const palette = CARD_PALETTES[background];
    return (
        <View style={[styles.screen, { paddingTop: insets.top, backgroundColor: c.base }]} testID="share-stats-preview-step">
            {/* The off-screen capture host, at the export size, positioned away
                and laid out (an unmounted or display:none host captures blank). */}
            {current ? (
                <View collapsable={false} pointerEvents="none" style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}>
                    <CardPaletteContext.Provider value={palette}>
                        <StatImage ref={hostRef} id={current} stats={stats} />
                    </CardPaletteContext.Provider>
                </View>
            ) : null}

            <DrillDownHeader title={t('shareStats.preview.title')} onBack={() => setStep('choose')} backTestID="share-stats-back" />
            <CardPaletteContext.Provider value={palette}>
                <FlatList
                    horizontal
                    data={images}
                    keyExtractor={(id) => id}
                    showsHorizontalScrollIndicator={false}
                    snapToInterval={itemW + 12}
                    decelerationRate="fast"
                    contentContainerStyle={{ paddingHorizontal: 32, gap: 12, paddingTop: SUBPAGE_TOP_GAP }}
                    onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / (itemW + 12)))}
                    renderItem={({ item }) => (
                        <View style={{ width: itemW, alignItems: 'center' }}>
                            <View style={{ borderRadius: 18, overflow: 'hidden' }}>
                                <StatImage id={item} stats={stats} hostSize={imageSize} />
                            </View>
                        </View>
                    )}
                    style={{ flexGrow: 0 }}
                />
            </CardPaletteContext.Provider>
            <View style={styles.dotsRow} accessibilityLiveRegion="polite">
                <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18 }}>
                    {t('shareStats.preview.position', { index: Math.min(index, images.length - 1) + 1, total: images.length })}
                </Text>
            </View>
            <View style={{ paddingHorizontal: 12, gap: 12, flex: 1, justifyContent: 'flex-end' }}>
                <SegmentedControl<Background>
                    options={[
                        { value: 'dark', label: t('shareStats.preview.dark') },
                        { value: 'light', label: t('shareStats.preview.light') },
                    ]}
                    value={background}
                    onChange={setBackground}
                    accessibilityLabel={t('shareStats.preview.title')}
                    testID="share-stats-background"
                />
                {failure ? (
                    <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18, textAlign: 'center' }} accessibilityLiveRegion="polite">
                        {failure === 'unavailable' ? t('shareStats.sharingUnavailable') : t('shareStats.shareFailed')}
                    </Text>
                ) : null}
                {primary(t('library.stats.share'), share, sharing || !current, 'share-stats-share', 'ios-share')}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    screen: { flex: 1 },
    textButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
    tile: { borderRadius: 14, padding: 14, gap: 6 },
    tileHead: { flexDirection: 'row', alignItems: 'center' },
    dotsRow: { alignItems: 'center', paddingVertical: 10 },
    primary: {
        minHeight: 48,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
});

export default ShareStatsScreen;
