import { GLASS_OVER_CONTENT_FILL } from '@/components/custom/GlassSurface';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface NewStoriesPillProps {
    visible: boolean;
    onPress: () => void;
    /** Distance from the bottom edge (safe area + tab bar + gap), from the host. */
    bottom: number;
}

/**
 * "New stories" pill for a reader who is scrolled down when a sync delivers.
 *
 * The pinned prefix means nothing is ever inserted ABOVE the reader, so new
 * stories land just below the part of the list they have read. Nothing told
 * them that; the pill does. One tap refreshes the feed exactly like a pull at
 * the top (re-sort, re-pin, back to the top), so it carries the refresh glyph,
 * not an arrow. It floats over content, so it carries the dark over-content
 * base.
 */
const NewStoriesPill: React.FC<NewStoriesPillProps> = ({ visible, onPress, bottom }) => {
    const { t } = useTranslation();
    if (!visible) return null;
    return (
        <View pointerEvents="box-none" style={[styles.host, { bottom }]}>
            <Pressable
                testID="feed-new-stories-pill"
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={t('feed.newStoriesPill')}
                hitSlop={8}
                // STATIC style: a function `style` on a Pressable is dropped on
                // device in this app (css-interop), taking the pill's shape with it.
                style={styles.pill}
            >
                <MaterialIcons name="refresh" size={16} color={ACCENT} />
                <Text size="sm" className="font-semibold" style={styles.label}>
                    {t('feed.newStoriesPill')}
                </Text>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 12 },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 22,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(255,255,255,0.18)',
        backgroundColor: GLASS_OVER_CONTENT_FILL,
    },
    label: { color: '#FFFFFF', marginLeft: 6 },
});

export default NewStoriesPill;
