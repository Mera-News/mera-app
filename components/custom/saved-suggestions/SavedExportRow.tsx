import { GLASS_OVER_CONTENT_FILL } from '@/components/custom/GlassSurface';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

/** The row's height. The list pads by it so its first card starts below. */
export const SAVED_EXPORT_ROW_HEIGHT = 56;

const BUTTON_H = 40;
const BUTTON_FRAME = 44;
const BUTTON_FILL = '#F5F1EC';
const BUTTON_INK = '#121113';

interface Props {
    readonly count: number;
    /** The host header's measured height: the row sits directly under it. */
    readonly headerHeight: number;
    /** The host header's 0..1 collapse value. The row rides with the header:
     *  it slides away as the header hides and comes back with it, so it never
     *  hangs alone under the status bar. Static when absent. */
    readonly hidden?: SharedValue<number>;
    readonly onExport: () => void;
}

/**
 * Saved's export entry point, pinned under the page header so it never
 * scrolls away; the list scrolls beneath it. It replaced a floating button
 * that sat bottom right, exactly where the Mera button now lives.
 *
 * Its own file so the screen's suites need no reanimated style hook: they
 * mock this module.
 */
const SavedExportRow: React.FC<Props> = ({ count, headerHeight, hidden, onExport }) => {
    const { t } = useTranslation();

    const ride = useAnimatedStyle(
        () => ({
            transform: [{ translateY: hidden ? -hidden.value * (headerHeight + SAVED_EXPORT_ROW_HEIGHT) : 0 }],
        }),
        [hidden, headerHeight],
    );

    return (
        <Animated.View testID="saved-export-row" style={[styles.row, { top: headerHeight }, ride]}>
            <Text numberOfLines={2} style={styles.caption}>
                {t('library.saved.exportRow', { count })}
            </Text>
            {/* A childless labelled button over a hidden visual: a glyph inside
                a button surfaces on iOS as its own StaticText even when hidden. */}
            <View testID="saved-export-open-frame" style={styles.frame}>
                <View
                    style={styles.button}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <MaterialIcons
                        name="ios-share"
                        size={18}
                        color={BUTTON_INK}
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
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
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: SAVED_EXPORT_ROW_HEIGHT,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: GLASS_OVER_CONTENT_FILL,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255,255,255,0.08)',
        zIndex: 5,
    },
    caption: { flex: 1, fontSize: 13, lineHeight: 17, color: 'rgb(163,163,163)' },
    frame: { minHeight: BUTTON_FRAME, justifyContent: 'center' },
    button: {
        height: BUTTON_H,
        paddingHorizontal: 16,
        borderRadius: 999,
        backgroundColor: BUTTON_FILL,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    label: { fontSize: 14, lineHeight: 18, fontWeight: '700', color: BUTTON_INK },
});

export default SavedExportRow;
