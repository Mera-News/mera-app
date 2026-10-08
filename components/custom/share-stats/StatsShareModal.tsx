// The Stats page's share preview: a centred modal over the page with the
// packed image(s), swiped through ("1 of 2"), then ONE row with Light | Dark
// and Share. Share sends the images one after another (several files in one
// share sheet is native work, N5). The background is the image's, whatever
// the app theme, and is not stored.
//
// Each image is captured from ONE off-screen host at the export size, drawn
// with the picked palette (capture-and-share keeps its native imports
// dynamic). Publication names only leave the phone through Most opened.

import { captureAndShare } from '@/components/custom/share-stats/capture-and-share';
import { CARD_PALETTES, CardPaletteContext } from '@/components/custom/share-stats/card-theme';
import { fitCardToPage, hostSizeForScale } from '@/components/custom/share-stats/card-shell';
import { StatImage } from '@/components/custom/share-stats/stat-image';
import { Modal, ModalBackdrop, ModalContent } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import type { ReadingStats, StatsCardId } from '@/lib/stats/reading-stats';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, PixelRatio, StyleSheet, useWindowDimensions, View } from 'react-native';

type Background = 'dark' | 'light';

/** The modal card's own padding; its width is the `lg` size (90%, ≤ 640). */
const MODAL_PAD = 16;

interface Props {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly groups: readonly (readonly StatsCardId[])[];
    readonly stats: ReadingStats;
}

const StatsShareModal: React.FC<Props> = ({ open, onClose, groups, stats }) => {
    const { t } = useTranslation();
    const c = useColors();
    const { width: screenW, height: screenH } = useWindowDimensions();
    const [background, setBackground] = useState<Background>('dark');
    const [index, setIndex] = useState(0);
    const [capturing, setCapturing] = useState<number | null>(null);
    const [failure, setFailure] = useState<'unavailable' | 'failed' | null>(null);
    const hostRef = useRef<View>(null);

    useEffect(() => {
        if (open) {
            setIndex(0);
            setFailure(null);
        }
    }, [open]);

    const itemW = Math.min(screenW * 0.9, 640) - 2 * MODAL_PAD;
    const imageSize = fitCardToPage({ width: itemW, height: screenH * 0.5 });
    const host = hostSizeForScale(PixelRatio.get());
    const palette = CARD_PALETTES[background];

    // One after another: point the host at each image, let it draw (two
    // frames), capture and share, then the next.
    const share = useCallback(async () => {
        if (capturing !== null || groups.length === 0) return;
        setFailure(null);
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
                break;
            }
        }
        setCapturing(null);
    }, [capturing, groups.length, host.width, host.height, t]);

    const hostGroup = groups[capturing ?? Math.min(index, groups.length - 1)];

    return (
        <Modal isOpen={open} onClose={onClose} size="lg">
            <ModalBackdrop />
            <ModalContent style={{ padding: MODAL_PAD }} testID="stats-share-modal">
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

                <View style={styles.head}>
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
                    <FlatList
                        horizontal
                        data={groups as StatsCardId[][]}
                        keyExtractor={(g) => g.join('-')}
                        showsHorizontalScrollIndicator={false}
                        snapToInterval={itemW}
                        decelerationRate="fast"
                        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / itemW))}
                        renderItem={({ item }) => (
                            <View style={{ width: itemW, alignItems: 'center' }}>
                                <View style={{ borderRadius: 18, overflow: 'hidden' }}>
                                    <StatImage ids={item} stats={stats} hostSize={imageSize} />
                                </View>
                            </View>
                        )}
                        style={{ flexGrow: 0, width: itemW }}
                    />
                </CardPaletteContext.Provider>

                {groups.length > 1 ? (
                    <Text
                        style={{ color: c.ink2, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 10 }}
                        accessibilityLiveRegion="polite"
                    >
                        {t('shareStats.preview.position', { index: Math.min(index, groups.length - 1) + 1, total: groups.length })}
                    </Text>
                ) : null}

                <View style={styles.controls}>
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
                        <Text style={{ color: c.onAccent, fontSize: 15, lineHeight: 20, fontWeight: '700' }}>
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
            </ModalContent>
        </Modal>
    );
};

const styles = StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    close: { width: 44, height: 44, margin: -10, alignItems: 'center', justifyContent: 'center' },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 },
    share: {
        minHeight: 44,
        paddingHorizontal: 18,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
});

export default StatsShareModal;
