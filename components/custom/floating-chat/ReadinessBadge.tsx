import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

/**
 * The readiness pill left of New chat: a turning refresh icon while the ping is out, a tick once the
 * model answered, an error mark on failure. Drawn only: the title block's label carries the status, so
 * the pill and its glyph stay out of the accessibility tree. The turn stops under Lite / Reduce Motion.
 */
const ReadinessBadge: React.FC<{
    readonly label: string;
    readonly tone: 'neutral' | 'positive' | 'negative';
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly spinning: boolean;
}> = ({ label, tone, icon, spinning }) => {
    const colors = useColors();
    const motion = useMotionAllowed();
    const ink = { neutral: colors.ink2, positive: colors.positive, negative: colors.negative }[tone];
    const fill = { neutral: colors.ink3, positive: colors.positive, negative: colors.negative }[tone];
    const turn = useSharedValue(0);
    useEffect(() => {
        if (spinning && motion) {
            turn.value = 0;
            turn.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
        } else {
            cancelAnimation(turn);
            turn.value = 0;
        }
        return () => cancelAnimation(turn);
    }, [spinning, motion, turn]);
    const turning = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
    return (
        <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.readiness}
            testID="chat-header-readiness"
        >
            <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, opacity: 0.16 }]} />
            <Animated.View style={turning}>
                <MaterialIcons {...DECORATIVE_ICON_A11Y} name={icon} size={13} color={ink} />
            </Animated.View>
            <Text style={{ color: ink, fontSize: 12, fontWeight: '600' }}>{label}</Text>
        </View>
    );
};

export default ReadinessBadge;

const styles = StyleSheet.create({
    readiness: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        // A minimum, never a height: a fixed 22 clipped the label at any large text size.
        minHeight: 22,
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 999,
        overflow: 'hidden',
        marginRight: 2,
    },
});
