import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { hapticSelection } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** A MaterialIcons name, shown before the label (Appearance: light-mode, dark-mode). */
    icon?: React.ComponentProps<typeof MaterialIcons>['name'];
}

export interface SegmentedControlProps<T extends string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    /** Names the group for screen readers ("Appearance"). */
    accessibilityLabel: string;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const HEIGHT = 32;
const PAD = 2;

/**
 * Two or three choices on one track; the chosen side is filled orange and the
 * fill slides to a new pick (FinalMotion "Controls": 240 ms, selection haptic,
 * a fade under Reduce Motion). A radio group to screen readers.
 *
 * The fill follows each option's MEASURED x, so it lands right in RTL too
 * (a row lays out mirrored and onLayout reports physical positions).
 */
export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    accessibilityLabel,
    style,
    testID,
}: SegmentedControlProps<T>) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const [frames, setFrames] = useState<Record<string, { x: number; width: number }>>({});
    const x = useSharedValue(0);
    const width = useSharedValue(0);
    const opacity = useSharedValue(0);
    const picked = frames[value];

    useEffect(() => {
        if (!picked) return;
        const first = opacity.value === 0;
        if (first || reduceMotion) {
            // First paint lands in place; Reduce Motion fades the fill across.
            x.value = picked.x;
            width.value = picked.width;
            opacity.value = first ? 1 : 0;
            if (!first) opacity.value = withTiming(1, { duration: MOTION.pill.duration });
            return;
        }
        x.value = withTiming(picked.x, { duration: MOTION.pill.duration, easing: EASE.across });
        width.value = withTiming(picked.width, { duration: MOTION.pill.duration, easing: EASE.across });
    }, [picked, reduceMotion, x, width, opacity]);

    const fill = useAnimatedStyle(() => ({
        width: width.value,
        opacity: opacity.value,
        transform: [{ translateX: x.value }],
    }));

    return (
        <View
            accessibilityRole="radiogroup"
            accessibilityLabel={accessibilityLabel}
            testID={testID}
            style={[
                styles.track,
                { backgroundColor: colors.trackFill, borderColor: colors.trackBorder },
                style,
            ]}
        >
            <Animated.View pointerEvents="none" style={[styles.fill, { backgroundColor: colors.accent }, fill]} />
            {options.map((o) => {
                const on = o.value === value;
                const ink = on ? colors.onAccent : colors.muted;
                return (
                    <Pressable
                        key={o.value}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={o.label}
                        testID={testID ? `${testID}-${o.value}` : undefined}
                        hitSlop={{ top: 6, bottom: 6 }}
                        onLayout={(e) => {
                            const { x: ox, width: w } = e.nativeEvent.layout;
                            setFrames((f) => ({ ...f, [o.value]: { x: ox, width: w } }));
                        }}
                        onPress={() => {
                            if (on) return;
                            void hapticSelection();
                            onChange(o.value);
                        }}
                        style={styles.option}
                    >
                        {o.icon ? <MaterialIcons name={o.icon} size={16} color={ink} /> : null}
                        <Text style={[styles.label, { color: ink }]} numberOfLines={1}>
                            {o.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    track: {
        flexDirection: 'row',
        height: HEIGHT,
        borderRadius: HEIGHT / 2,
        borderWidth: StyleSheet.hairlineWidth,
        padding: PAD,
        alignSelf: 'flex-start',
    },
    fill: {
        position: 'absolute',
        top: PAD,
        bottom: PAD,
        left: 0,
        borderRadius: (HEIGHT - PAD * 2) / 2,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 12,
        minWidth: 64,
    },
    label: { fontSize: 13, fontWeight: '600' },
});
