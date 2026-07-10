import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ScrollToTopFabProps {
    visible: boolean;
    onPress: () => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Floating Action Button for scrolling to top of a list
 * Positioned at bottom-right, above the native tab bar
 */
const ScrollToTopFab: React.FC<ScrollToTopFabProps> = ({ visible, onPress }) => {
    const insets = useSafeAreaInsets();
    const colors = useThemeColors();

    if (!visible) return null;

    return (
        <AnimatedPressable
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            onPress={onPress}
            style={[styles.fab, { bottom: 20 + insets.bottom, backgroundColor: colors.surface }]}
        >
            <MaterialIcons name="keyboard-arrow-up" size={28} color={colors.icon} />
        </AnimatedPressable>
    );
};

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: 20,
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(255, 255, 255, 0.9)', // soft white
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 8, // Android shadow
    },
});

export default ScrollToTopFab;
