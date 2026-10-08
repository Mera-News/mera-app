// The Stats page's share preview: a card over the page whose VISIBLE edges
// are the box (owner): from just under the page strip to just above the tab
// bar, about 3% in from each screen edge. Its own RN Modal (not ui/modal,
// whose content wrapper is full width and padded, so the card sat inside a
// bigger invisible box and scrim taps only landed at the edges): a scrim
// that closes on any tap outside the card, the modals' ModalMaterial inside.
// Each image shows the WHOLE 9:16 frame exactly as exported (reserves
// included), as large as the box allows, centred; dots under it when there
// are several (tap to jump, they follow the swipe); then ONE row with
// Light | Dark and Share, which sends the images one after another (several
// files in one share sheet is native work, N5) and closes the preview.
//
// Each image is captured from ONE off-screen host at the export size, drawn
// with the picked palette (capture-and-share keeps its native imports
// dynamic). Publication names only leave the phone through Most opened.

import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import { CARD_PALETTES, CardPaletteContext } from '@/components/custom/share-stats/card-theme';
import { hostSizeForScale } from '@/components/custom/share-stats/card-shell';
import { StatImage } from '@/components/custom/share-stats/stat-image';
import { useMeraCorner } from '@/components/custom/mera-button/corner';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { Pressable } from '@/components/ui/pressable';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import { MERA_BUTTON_EDGE, MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import type { ReadingStats, StatsCardId } from '@/lib/stats/reading-stats';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, I18nManager, Modal, PixelRatio, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useMotionAllowed } from '@/lib/motion-gate';

type Background = 'dark' | 'light';

const PAD = 16;
const HEAD_H = 32;
const HEAD_GAP = 12;
const DOTS_H = 28;
const CONTROLS_H = 44;
const CONTROLS_GAP = 14;
const DOT = 8;
/** Kept between the Share row and the Mera button's column when they meet. */
const MERA_SIDE_GAP = 8;

/** Where the modal may sit, in window points. */
export interface PreviewBox {
    /** From the window's top: just under the page strip. */
    readonly top: number;
    /** From the window's bottom: the tab bar's top. */
    readonly bottom: number;
    /** From the window's bottom: the Mera button's bottom edge. */
    readonly meraBottom: number;
}

interface Props {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly groups: readonly (readonly StatsCardId[])[];
    readonly stats: ReadingStats;
    readonly box: PreviewBox;
}

/** The modal's side inset: about 3% of the screen, on the 4pt grid. */
export function sideInset(screenW: number): number {
    return Math.max(4, Math.round((screenW * 0.03) / 4) * 4);
}

/** The largest 9:16 image that fits both limits. */
export function fitPortrait(maxW: number, maxH: number): { width: number; height: number } {
    const w = Math.max(0, Math.min(maxW, (maxH * 9) / 16));
    return { width: Math.floor(w), height: Math.floor((w * 16) / 9) };
}

const StatsShareModal: React.FC<Props> = ({ open, onClose, groups, stats, box }) => {
    // Lite / Reduce Motion: the modal appears at once (lib/motion-gate.ts).
    const motion = useMotionAllowed();
    const { t } = useTranslation();
    const c = useColors();
    const corner = useMeraCorner();
    const { width: screenW, height: screenH } = useWindowDimensions();
    const [background, setBackground] = useState<Background>('dark');
    const [index, setIndex] = useState(0);
    const [capturing, setCapturing] = useState<number | null>(null);
    const [failure, setFailure] = useState<'unavailable' | 'failed' | null>(null);
    const hostRef = useRef<View>(null);
    const listRef = useRef<FlatList<StatsCardId[]>>(null);

    useEffect(() => {
        if (open) {
            setIndex(0);
            setFailure(null);
        }
    }, [open]);

    // ── Geometry ──
    const inset = sideInset(screenW);
    const modalW = screenW - 2 * inset;
    const boxH = screenH - box.top - box.bottom;
    const dotsH = groups.length > 1 ? DOTS_H : 0;
    const chromeH = 2 * PAD + HEAD_H + HEAD_GAP + dotsH + CONTROLS_GAP + CONTROLS_H;
    const image = fitPortrait(modalW - 2 * PAD, boxH - chromeH);
    // The Mera button may sit over the card's bottom corner: keep the
    // controls clear of its column when the two meet.
    const controlsBottom = box.bottom + PAD;
    const meraTop = box.meraBottom + MERA_BUTTON_SIZE;
    const meraMeets = corner.startsWith('b') && controlsBottom < meraTop && controlsBottom + CONTROLS_H > box.meraBottom;
    const meraPhysicalRight = corner.endsWith('r');
    const meraReach = MERA_BUTTON_EDGE + MERA_BUTTON_SIZE + MERA_SIDE_GAP - inset - PAD;
    const guard = meraMeets ? Math.max(0, meraReach) : 0;
    // Corners are PHYSICAL; RN swaps start/end padding in RTL.
    const guardSide = meraPhysicalRight !== I18nManager.isRTL ? 'paddingEnd' : 'paddingStart';

    const host = hostSizeForScale(PixelRatio.get());
    const palette = CARD_PALETTES[background];

    const jumpTo = useCallback(
        (i: number) => {
            const next = Math.max(0, Math.min(groups.length - 1, i));
            setIndex(next);
            listRef.current?.scrollToOffset({ offset: next * image.width, animated: true });
        },
        [groups.length, image.width],
    );

    // One after another: point the host at each image, let it draw (two
    // frames), capture and share, then the next. Done closes the preview.
    const share = useCallback(async () => {
        if (capturing !== null || groups.length === 0) return;
        setFailure(null);
        let done = true;
        for (let i = 0; i < groups.length; i++) {
            setCapturing(i);
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const result = await captureAndShare({
                ref: hostRef,
                hostWidth: host.width,
                hostHeight: host.height,
                dialogTitle: t('shareStats.shareDialogTitle'),
            });
            if (result.status === 'failed') {
                logger.captureException(result.error, { tags: { screen: 'StatsShareModal', method: 'share' } });
            }
            if (result.status !== 'shared') {
                setFailure(result.status);
                done = false;
                break;
            }
        }
        setCapturing(null);
        if (done) onClose();
    }, [capturing, groups.length, host.width, host.height, t, onClose]);

    const hostGroup = groups[capturing ?? Math.min(index, groups.length - 1)];
    const position = t('shareStats.preview.position', {
        index: Math.min(index, groups.length - 1) + 1,
        total: groups.length,
    });

    return (
        <Modal visible={open} transparent animationType={motion ? 'fade' : 'none'} onRequestClose={onClose} statusBarTranslucent>
            <Pressable
                style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]}
                onPress={onClose}
                accessible={false}
                testID="stats-share-scrim"
            />
            <View
                style={[
                    styles.card,
                    { top: box.top, bottom: box.bottom, left: inset, right: inset, borderColor: c.line },
                ]}
                accessibilityViewIsModal
                testID="stats-share-modal"
            >
                <ModalMaterial />
                <View style={{ flex: 1, padding: PAD }}>
                {/* The off-screen capture host, at the export size, positioned
                    away and laid out (unmounted or display:none captures blank). */}
                {hostGroup ? (
                    <View
                        collapsable={false}
                        pointerEvents="none"
                        style={{ position: 'absolute', left: -8000, top: 0, width: host.width, height: host.height }}
                    >
                        <CardPaletteContext.Provider value={palette}>
                            <StatImage ref={hostRef} ids={hostGroup} stats={stats} />
                        </CardPaletteContext.Provider>
                    </View>
                ) : null}

                <View style={[styles.head, { height: HEAD_H, marginBottom: HEAD_GAP }]}>
                    <Text style={{ color: c.ink, fontSize: 17, lineHeight: 22, fontWeight: '700', flex: 1 }} accessibilityRole="header">
                        {t('shareStats.preview.title')}
                    </Text>
                    <Pressable
                        onPress={onClose}
                        accessibilityRole="button"
                        accessibilityLabel={t('tutorials.close')}
                        testID="stats-share-close"
                        style={styles.close}
                    >
                        <MaterialIcons name="close" size={22} color={c.ink2} />
                    </Pressable>
                </View>

                <CardPaletteContext.Provider value={palette}>
                    <View style={styles.imageArea}>
                    <FlatList
                        ref={listRef}
                        horizontal
                        pagingEnabled
                        data={groups as StatsCardId[][]}
                        keyExtractor={(g) => g.join('-')}
                        showsHorizontalScrollIndicator={false}
                        getItemLayout={(_, i) => ({ length: image.width, offset: image.width * i, index: i })}
                        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / image.width))}
                        renderItem={({ item }) => (
                            <View style={{ width: image.width, height: image.height, borderRadius: 14, overflow: 'hidden' }}>
                                <StatImage ids={item} stats={stats} hostSize={image} fullFrame />
                            </View>
                        )}
                        style={{ flexGrow: 0, width: image.width, alignSelf: 'center' }}
                    />
                    </View>
                </CardPaletteContext.Provider>

                {groups.length > 1 ? (
                    <View
                        style={[styles.dots, { height: DOTS_H }]}
                        accessible
                        accessibilityRole="adjustable"
                        accessibilityLabel={t('shareStats.preview.title')}
                        accessibilityValue={{ text: position }}
                        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                        onAccessibilityAction={(e) => jumpTo(index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))}
                        testID="stats-share-dots"
                    >
                        {groups.map((g, i) => (
                            <Pressable
                                key={g.join('-')}
                                onPress={() => jumpTo(i)}
                                accessible={false}
                                importantForAccessibility="no"
                                style={styles.dotFrame}
                                testID={`stats-share-dot-${i}`}
                            >
                                <View
                                    style={{
                                        width: DOT,
                                        height: DOT,
                                        borderRadius: DOT / 2,
                                        backgroundColor: i === index ? c.accent : c.helpRing,
                                    }}
                                />
                            </Pressable>
                        ))}
                    </View>
                ) : null}

                <View style={[styles.controls, { height: CONTROLS_H, marginTop: CONTROLS_GAP, [guardSide]: guard }]}>
                    <SegmentedControl<Background>
                        options={[
                            { value: 'light', label: t('display.appearanceLight') },
                            { value: 'dark', label: t('display.appearanceDark') },
                        ]}
                        value={background}
                        onChange={setBackground}
                        accessibilityLabel={t('shareStats.preview.title')}
                        testID="stats-share-background"
                    />
                    <Pressable
                        onPress={share}
                        disabled={capturing !== null}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: capturing !== null }}
                        accessibilityLabel={t('library.stats.share')}
                        testID="stats-share-send"
                        style={[styles.share, { backgroundColor: c.accent, opacity: capturing !== null ? 0.45 : 1 }]}
                    >
                        <MaterialIcons name="ios-share" size={17} color={c.onAccent} />
                        <Text numberOfLines={1} style={{ color: c.onAccent, fontSize: 15, lineHeight: 20, fontWeight: '700' }}>
                            {t('library.stats.share')}
                        </Text>
                    </Pressable>
                </View>

                {failure ? (
                    <Text
                        style={{ color: c.ink2, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 8 }}
                        accessibilityLiveRegion="polite"
                    >
                        {failure === 'unavailable' ? t('shareStats.sharingUnavailable') : t('shareStats.shareFailed')}
                    </Text>
                ) : null}
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    card: { position: 'absolute', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    imageArea: { flex: 1, justifyContent: 'center' },
    head: { flexDirection: 'row', alignItems: 'center' },
    close: { width: 44, height: 44, margin: -10, alignItems: 'center', justifyContent: 'center' },
    dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
    dotFrame: { width: 22, height: DOTS_H, alignItems: 'center', justifyContent: 'center' },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    share: {
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
    },
});

export default StatsShareModal;
