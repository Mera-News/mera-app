import { GLASS_OVER_CONTENT_FILL, GlassPlate } from '@/components/custom/GlassSurface';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ScrollToTopFabProps {
    visible: boolean;
    onPress: () => void;
    /**
     * Extra bottom clearance on top of `insets.bottom`. Ignored when
     * `bottomInset` is given.
     */
    extraBottomOffset?: number;
    /**
     * The whole bottom clearance, replacing `insets.bottom + extraBottomOffset`.
     * A host INSIDE the tab navigator passes `useTabBarClearance()` here: on iOS
     * the tab's own inset already includes the bar, so adding TAB_BAR_HEIGHT to
     * it counts the bar twice.
     */
    bottomInset?: number;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Floating Action Button for scrolling to top of a list
 * Positioned at bottom-right, above the native tab bar
 */
const ScrollToTopFab: React.FC<ScrollToTopFabProps> = ({
    visible,
    onPress,
    extraBottomOffset = 0,
    bottomInset,
}) => {
    const insets = useSafeAreaInsets();

    if (!visible) return null;

    return (
        <AnimatedPressable
            testID="feed-scroll-top-fab"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            onPress={onPress}
            style={[styles.fab, { bottom: 20 + (bottomInset ?? insets.bottom + extraBottomOffset) }]}
        >
            {/* Radius goes on the plate's own style rather than clipping the
                Pressable: RN drops a view's shadow the moment that same view sets
                `overflow: hidden`, and the FAB's shadow is what lifts it off the
                feed.

                The dark base is the button's real surface. With the glass plate
                as the only surface, a settled screen could show a bare arrow
                over the text behind it (seen on device): the plate can paint
                nothing. The glass on top only tints the base. */}
            <View
                testID="feed-scroll-top-fab-base"
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.base]}
            />
            <GlassPlate style={{ borderRadius: FAB_RADIUS }} />
            <MaterialIcons name="keyboard-arrow-up" size={28} color="#e5e7eb" />
        </AnimatedPressable>
    );
};

const FAB_RADIUS = 25;

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: 20,
        width: 50,
        height: 50,
        borderRadius: FAB_RADIUS,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 8, // Android shadow
    },
    base: {
        borderRadius: FAB_RADIUS,
        backgroundColor: GLASS_OVER_CONTENT_FILL,
    },
});

export default ScrollToTopFab;
