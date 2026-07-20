import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';

interface NewStoriesPillProps {
    /** Number of held new stories waiting to be adopted. */
    readonly count: number;
    /** Adopt the held arrivals and scroll to top. */
    readonly onPress: () => void;
    /** Distance from the top of the feed container (below the header). */
    readonly topOffset?: number;
}

/**
 * Floating, centered "N new stories" pill that hovers below the header over the
 * feed. Rendered only when the held-feed hook reports pending arrivals AND the
 * Feed sub-tab is active (gated by the parent). Tapping adopts the held rows and
 * scrolls to top.
 */
const NewStoriesPill: React.FC<NewStoriesPillProps> = ({ count, onPress, topOffset = 8 }) => {
    const { t } = useTranslation();
    return (
        <Animated.View
            entering={FadeInDown.springify().damping(18)}
            exiting={FadeOutUp.duration(150)}
            pointerEvents="box-none"
            style={[styles.container, { top: topOffset }]}
        >
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={t('forYou.newStoriesPill', { count })}
                className="flex-row items-center rounded-full bg-primary-400 px-4 py-2 shadow-hard-2"
            >
                <MaterialIcons name="arrow-upward" size={16} color="#000000" style={{ marginRight: 6 }} />
                <Text size="sm" className="text-black font-semibold">
                    {t('forYou.newStoriesPill', { count })}
                </Text>
            </Pressable>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 30,
    },
});

export default NewStoriesPill;
