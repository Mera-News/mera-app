import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { hapticSelection } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    /** A MaterialIcons name, shown before the label (Appearance: light-mode, dark-mode). */
    icon?: React.ComponentProps<typeof MaterialIcons>['name'];
    /** Header size only: a hook (called in the option's own component, keyed by
     *  value) that says whether the option shows its 7pt "something new" dot. */
    useDot?: () => boolean;
    /** Header size only: the spoken name, given the dot ("Feed, 1 of 2"). */
    accessibilityLabelFor?: (dot: boolean) => string;
}

export interface SegmentedControlProps<T extends string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    /** Names the group for screen readers ("Appearance"). */
    accessibilityLabel: string;
    style?: StyleProp<ViewStyle>;
    /** Options are `${testID}-${value}`; a header option's dot `${testID}-${value}-dot`. */
    testID?: string;
    /**
     * `header`: the tab header's page track (34pt options, 14pt fixed-size
     * labels, a dot). Its selected fill is drawn INSIDE the selected option,
     * so it has exactly that option's bounds, and crossfades on a change
     * (240 ms) instead of sliding: no measured offsets, nothing to misalign.
     * The host gives the selection haptic.
     */
    size?: 'default' | 'header';
}

/** FinalSettings #6: 36pt options inside a 3pt padded, 1pt bordered track,
 *  44pt overall. */
const OPTION_HEIGHT = 36;
const PAD = 3;
const BORDER = 1;

/**
 * Two or three choices on one track; the chosen side is filled orange and the
 * fill slides to a new pick (FinalMotion "Controls": 240 ms, selection haptic,
 * a fade under Reduce Motion). A radio group to screen readers.
 *
 * The fill follows each option's MEASURED x, so it lands right in RTL too
 * (a row lays out mirrored and onLayout reports physical positions).
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
    return props.size === 'header' ? <HeaderTrack {...props} /> : <DefaultTrack {...props} />;
}

function DefaultTrack<T extends string>({
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

/** The tab header's page track (`size="header"`). */
const HEADER_OPTION_HEIGHT = 34;
/** iOS maps `tab` to no trait: a button in a tabbar; Android gets real tabs. */
const HEADER_ROLES =
    Platform.OS === 'ios'
        ? ({ group: 'tabbar', option: 'button' } as const)
        : ({ group: 'tablist', option: 'tab' } as const);
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
const noDot = () => false;

function HeaderTrack<T extends string>({ options, value, onChange, style, testID }: SegmentedControlProps<T>) {
    const colors = useColors();
    return (
        <View
            accessibilityRole={HEADER_ROLES.group}
            testID={testID}
            style={[
                styles.track,
                styles.headerTrack,
                { backgroundColor: colors.trackFill, borderColor: colors.trackBorder },
                style,
            ]}
        >
            {options.map((o) => (
                <HeaderOption
                    key={o.value}
                    option={o}
                    on={o.value === value}
                    onPress={() => {
                        if (o.value !== value) onChange(o.value);
                    }}
                    testID={testID ? `${testID}-${o.value}` : undefined}
                />
            ))}
        </View>
    );
}

/** One header option: its own component so its dot hook has a stable place. */
function HeaderOption<T extends string>({
    option,
    on,
    onPress,
    testID,
}: {
    option: SegmentedOption<T>;
    on: boolean;
    onPress: () => void;
    testID?: string;
}) {
    const colors = useColors();
    const useDot = option.useDot ?? noDot;
    const dot = useDot();
    const fill = useSharedValue(on ? 1 : 0);
    useEffect(() => {
        fill.value = withTiming(on ? 1 : 0, { duration: MOTION.pill.duration, easing: EASE.across });
    }, [on, fill]);
    const fillStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
    const ink = on ? colors.onAccent : colors.muted;
    return (
        // A hidden visual under a CHILDLESS labelled button: a glyph inside a
        // button surfaces on iOS as its own StaticText.
        <View style={styles.headerOption}>
            <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.headerFill, { backgroundColor: colors.accent }, fillStyle]}
            />
            <View pointerEvents="none" style={styles.headerInner} {...HIDDEN}>
                {option.icon ? <MaterialIcons name={option.icon} size={14} color={ink} /> : null}
                <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1}
                    style={[styles.headerLabel, { color: ink, fontWeight: on ? '700' : '500' }]}
                >
                    {option.label}
                </Text>
                {dot ? (
                    <View
                        testID={testID ? `${testID}-dot` : undefined}
                        style={[
                            styles.dot,
                            { backgroundColor: colors.accent },
                            on ? [styles.dotOnPicked, { borderColor: colors.onAccent }] : null,
                        ]}
                    />
                ) : null}
            </View>
            <Pressable
                onPress={onPress}
                accessibilityRole={HEADER_ROLES.option}
                accessibilityState={{ selected: on }}
                accessibilityLabel={option.accessibilityLabelFor?.(dot) ?? option.label}
                testID={testID}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    track: {
        flexDirection: 'row',
        borderRadius: (OPTION_HEIGHT + PAD * 2 + BORDER * 2) / 2,
        borderWidth: BORDER,
        padding: PAD,
        alignSelf: 'flex-start',
    },
    fill: {
        position: 'absolute',
        top: PAD,
        height: OPTION_HEIGHT,
        // An absolute child starts inside the border; onLayout's x includes it.
        left: -BORDER,
        borderRadius: OPTION_HEIGHT / 2,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: OPTION_HEIGHT,
        paddingHorizontal: 14,
    },
    label: { fontSize: 14, fontWeight: '600' },
    headerTrack: { borderRadius: (HEADER_OPTION_HEIGHT + PAD * 2 + BORDER * 2) / 2 },
    headerOption: { height: HEADER_OPTION_HEIGHT, justifyContent: 'center' },
    headerFill: { borderRadius: HEADER_OPTION_HEIGHT / 2 },
    headerInner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
    headerLabel: { fontSize: 14, lineHeight: 18 },
    dot: { width: 7, height: 7, borderRadius: 4, marginLeft: -2 },
    dotOnPicked: { borderWidth: 1.5, width: 9, height: 9, borderRadius: 5 },
});
