// Saved's pinned row (FinalLibrary #1): "3 saved" with its ?, then the glass
// Export button, on the header's own material (the `chrome` token and a
// hairline). It sits under the page header and rides with it, so it never
// scrolls away and never hangs alone under the status bar; the list scrolls
// beneath it. Only while something is saved (#3: the empty page has no pinned
// row; its "Saved ?" title scrolls with the list).
//
// The count is the shell's PageTitleRow; Saved's ? is in the tab header.

import { GlassPlate } from '@/components/custom/GlassSurface';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { Text } from '@/components/ui/text';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';

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
    readonly onExport: () => void;
}

const SavedExportRow: React.FC<Props> = ({ count, headerHeight, hidden, onExport }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const styles = useStyles();

    const ride = useAnimatedStyle(
        () => ({
            transform: [{ translateY: hidden ? -hidden.value * (headerHeight + SAVED_EXPORT_ROW_HEIGHT) : 0 }],
        }),
        [hidden, headerHeight],
    );

    const exportButton = (
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
                    <MaterialIcons name="ios-share" size={17} color={colors.ink} />
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
    );

    return (
        <Animated.View testID="saved-export-row" style={[styles.row, { top: headerHeight }, ride]}>
            <PageTitleRow
                title={t('library.saved.count', { count })}
                trailing={exportButton}
                testID="saved-title-row"
            />
        </Animated.View>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: SAVED_EXPORT_ROW_HEIGHT,
        paddingHorizontal: PAGE_SIDE_INSET,
        justifyContent: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: c.line,
        backgroundColor: c.chrome,
        overflow: 'hidden',
        zIndex: 5,
    },
    frame: { minHeight: BUTTON_FRAME, justifyContent: 'center' },
    button: {
        height: BUTTON_H,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.trackBorder,
        overflow: 'hidden',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    label: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: c.ink },
}));

export default SavedExportRow;
