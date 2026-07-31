import { GLASS_AVAILABLE, GlassPlate } from '@/components/custom/GlassSurface';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ScrollToTopFabProps {
    visible: boolean;
    onPress: () => void;
    /**
     * Extra bottom clearance on top of `insets.bottom` — set this to
     * TAB_BAR_HEIGHT (lib/navigation/tab-bar.ts) when the host screen sits
     * inside the bottom tab shell, so the FAB doesn't sit under the tab bar.
     */
    extraBottomOffset?: number;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Floating Action Button for scrolling to top of a list
 * Positioned at bottom-right, above the native tab bar
 */
const ScrollToTopFab: React.FC<ScrollToTopFabProps> = ({ visible, onPress, extraBottomOffset = 0 }) => {
    const insets = useSafeAreaInsets();

    if (!visible) return null;

    return (
        <AnimatedPressable
            testID="feed-scroll-top-fab"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            onPress={onPress}
            style={[
                styles.fab,
                // The soft-white pill only applies OFF glass. Where glass paints,
                // the plate is the surface and a solid fill would cancel it.
                GLASS_AVAILABLE ? null : styles.fabSolid,
                { bottom: 20 + insets.bottom + extraBottomOffset },
            ]}
        >
            {/* Radius goes on the plate's own style rather than clipping the
                Pressable: RN drops a view's shadow the moment that same view sets
                `overflow: hidden`, and the FAB's shadow is what lifts it off the
                feed. */}
            <GlassPlate style={{ borderRadius: FAB_RADIUS }} />
            <MaterialIcons
                name="keyboard-arrow-up"
                size={28}
                // Dark-on-white off glass; light-on-glass otherwise, where the
                // surface is the dark page showing through.
                color={GLASS_AVAILABLE ? '#e5e7eb' : '#6b7280'}
            />
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
    // Non-glass fallback only (Android, iOS < 26): without it the FAB would have
    // no surface at all, since GlassPlate renders nothing there.
    fabSolid: {
        backgroundColor: 'rgba(255, 255, 255, 0.9)', // soft white
    },
});

export default ScrollToTopFab;
