// Saved's pinned row (FinalLibrary #1, #3): "3 saved" with its ?, then the
// glass Export button. It sits under the page header and rides with it, so it
// never scrolls away and never hangs alone under the status bar; the list
// scrolls beneath it. With nothing saved there is no Export (#3).
//
// The title and ? are the shell's PageTitleRow, so Saved's ? is the same
// control as every other page's.

import { GlassPlate } from '@/components/custom/GlassSurface';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { Text } from '@/components/ui/text';
import { COLORS } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

/** The row's height. The list pads by it so its first card starts below. */
export const SAVED_EXPORT_ROW_HEIGHT = 56;

const BUTTON_H = 38;
const BUTTON_FRAME = 44;

interface Props {
    readonly count: number;
    /** The host header's measured height: the row sits directly under it. */
    readonly headerHeight: number;
    /** The host header's 0..1 collapse value; the row rides with it. */
    readonly hidden?: SharedValue<number>;
    /** Opens Saved's explainer (the ? beside the count). */
    readonly onExplain?: () => void;
    readonly onExport: () => void;
}

const SavedExportRow: React.FC<Props> = ({ count, headerHeight, hidden, onExplain, onExport }) => {
    const { t } = useTranslation();

    const ride = useAnimatedStyle(
        () => ({
            transform: [{ translateY: hidden ? -hidden.value * (headerHeight + SAVED_EXPORT_ROW_HEIGHT) : 0 }],
        }),
        [hidden, headerHeight],
    );

    const exportButton =
        count > 0 ? (
            // A childless labelled button over a hidden visual: a glyph inside a
            // button surfaces on iOS as its own StaticText.
            <View testID="saved-export-open-frame" style={styles.frame}>
                <View
                    style={styles.button}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <GlassPlate />
                    <MaterialIcons name="ios-share" size={17} color={COLORS.dark.ink} />
                    <Text style={styles.label}>{t('library.saved.export')}</Text>
                </View>
                <Pressable
                    testID="saved-export-open"
                    onPress={onExport}
                    accessibilityRole="button"
                    accessibilityLabel={t('savedExport.fabA11y')}
                    style={StyleSheet.absoluteFill}
                />
            </View>
        ) : null;

    return (
        <Animated.View testID="saved-export-row" style={[styles.row, { top: headerHeight }, ride]}>
            <GlassPlate />
            <PageTitleRow
                title={count > 0 ? t('library.saved.count', { count }) : t('nav.page.saved')}
                onExplain={onExplain}
                trailing={exportButton}
                testID="saved-title-row"
            />
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: SAVED_EXPORT_ROW_HEIGHT,
        paddingHorizontal: 12,
        justifyContent: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: COLORS.dark.line,
        overflow: 'hidden',
        zIndex: 5,
    },
    frame: { minHeight: BUTTON_FRAME, justifyContent: 'center' },
    button: {
        height: BUTTON_H,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: COLORS.dark.trackBorder,
        overflow: 'hidden',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    label: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: COLORS.dark.ink },
});

export default SavedExportRow;
