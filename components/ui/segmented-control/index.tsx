import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type TextLayoutEventData,
    type NativeSyntheticEvent,
    type ViewStyle,
} from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
    LinearTransition,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import { hapticSelection } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { MAX_FONT_SCALE } from '@/lib/typography/policy';

import { HEADER_METRICS, headerOptionParts, headerTrackMode } from './fit';

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
     * `header`: the tab header's page track (38pt options, an icon each,
     * 15.5pt labels on the chrome text-scale tier, a dot). Names alone
     * (`namesFirst`) or icons and names when they all fit `availableWidth`,
     * else icons with only the selected name (fit.ts); it never scrolls. Its selected fill is drawn INSIDE the
     * selected option, so it has exactly that option's bounds, and crossfades
     * on a change (240 ms) instead of sliding. The host gives the haptic.
     */
    size?: 'default' | 'header';
    /** Header size only: the width the host gives the track. */
    availableWidth?: number | null;
    /** Header size only: names alone when they all fit, no icons (fit.ts). */
    namesFirst?: boolean;
    /** Header size only: icons, with only the selected option's name, at any
     *  width (the fit rule is skipped). */
    iconsOnly?: boolean;
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

/** The tab header's page track (`size="header"`): the board's 14pt track
 *  at 1.1x (owner). */
const HEADER_OPTION_HEIGHT = 38;
// The fit rule's metrics (fit.ts) are the ones the track draws.
const HEADER_PAD = HEADER_METRICS.chrome / 2 - BORDER;
const HEADER_ICON = HEADER_METRICS.icon;
const HEADER_OPTION_PAD = HEADER_METRICS.pad;
const HEADER_GAP = HEADER_METRICS.gap;
const HEADER_DOT = 8;
const HEADER_DOT_PICKED = HEADER_METRICS.dot + 2;
/** The whole track's height: the header row is derived from it, never set
 *  on its own (a row shorter than the track clips it). */
export const HEADER_TRACK_HEIGHT = HEADER_OPTION_HEIGHT + 2 * (HEADER_PAD + BORDER);
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
const LABEL_MOTION = MOTION.pill.duration;

function HeaderTrack<T extends string>({
    options,
    value,
    onChange,
    style,
    testID,
    availableWidth = null,
    namesFirst = false,
    iconsOnly = false,
}: SegmentedControlProps<T>) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    // Each label's width, measured at the picked weight and the current text
    // size by a hidden copy, so the decision never depends on what is shown.
    const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
    const onMeasure = useCallback((key: string, e: NativeSyntheticEvent<TextLayoutEventData>) => {
        const w = Math.ceil(e.nativeEvent.lines[0]?.width ?? 0);
        setWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
    }, []);
    const fitMode = useMemo(
        () =>
            headerTrackMode(
                options.map((o) => widths[o.label]),
                options.map((o) => o.useDot !== undefined),
                availableWidth,
                HEADER_METRICS,
                namesFirst,
            ),
        [options, widths, availableWidth, namesFirst],
    );
    const mode = iconsOnly ? 'compact' : fitMode;
    return (
        // The track glides to its new width with its options.
        <Animated.View
            layout={reduceMotion ? undefined : LinearTransition.duration(LABEL_MOTION)}
            accessibilityRole={HEADER_ROLES.group}
            testID={testID}
            style={[
                styles.track,
                styles.headerTrack,
                { backgroundColor: colors.trackFill, borderColor: colors.trackBorder },
                availableWidth ? { maxWidth: availableWidth } : null,
                style,
            ]}
        >
            <View pointerEvents="none" style={styles.measurer} {...HIDDEN}>
                {options.map((o) => (
                    <Text
                        key={o.value}
                        maxFontSizeMultiplier={MAX_FONT_SCALE.chrome}
                        onTextLayout={(e) => onMeasure(o.label, e)}
                        style={[styles.headerLabel, { fontWeight: '700' }]}
                    >
                        {o.label}
                    </Text>
                ))}
            </View>
            {options.map((o) => (
                <HeaderOption
                    key={o.value}
                    option={o}
                    on={o.value === value}
                    parts={headerOptionParts(o.value === value, mode)}
                    onPress={() => {
                        if (o.value !== value) onChange(o.value);
                    }}
                    testID={testID ? `${testID}-${o.value}` : undefined}
                />
            ))}
        </Animated.View>
    );
}

/** One header option: its own component so its dot hook has a stable place. */
function HeaderOption<T extends string>({
    option,
    on,
    parts,
    onPress,
    testID,
}: {
    option: SegmentedOption<T>;
    on: boolean;
    parts: { label: boolean; icon: boolean };
    onPress: () => void;
    testID?: string;
}) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
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
        // button surfaces on iOS as its own StaticText. An icon-only option
        // still speaks its full label ("Saved, 1 of 4").
        <Animated.View
            layout={reduceMotion ? undefined : LinearTransition.duration(LABEL_MOTION)}
            style={[styles.headerOption, on ? styles.headerOptionPicked : null]}
        >
            <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.headerFill, { backgroundColor: colors.accent }, fillStyle]}
            />
            <View
                pointerEvents="none"
                style={[styles.headerInner, parts.icon ? null : styles.headerInnerNames]}
                {...HIDDEN}
            >
                {option.icon && parts.icon ? <MaterialIcons name={option.icon} size={HEADER_ICON} color={ink} /> : null}
                {parts.label ? (
                    <Animated.Text
                        entering={reduceMotion ? undefined : FadeIn.duration(LABEL_MOTION)}
                        exiting={reduceMotion ? undefined : FadeOut.duration(LABEL_MOTION)}
                        numberOfLines={1}
                        maxFontSizeMultiplier={MAX_FONT_SCALE.chrome}
                        style={[styles.headerLabel, styles.headerLabelShrink, { color: ink, fontWeight: on ? '700' : '500' }]}
                    >
                        {option.label}
                    </Animated.Text>
                ) : null}
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
        </Animated.View>
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
    headerTrack: { alignSelf: 'center', padding: HEADER_PAD, borderRadius: (HEADER_OPTION_HEIGHT + HEADER_PAD * 2 + BORDER * 2) / 2 },
    headerOption: { height: HEADER_OPTION_HEIGHT, justifyContent: 'center', flexShrink: 0 },
    // Only the picked option gives way (its label ellipsizes) when even the
    // compact track is wider than the space, at the largest text sizes.
    headerOptionPicked: { flexShrink: 1 },
    headerFill: { borderRadius: HEADER_OPTION_HEIGHT / 2 },
    headerInner: { flexDirection: 'row', alignItems: 'center', gap: HEADER_GAP, paddingHorizontal: HEADER_OPTION_PAD },
    headerInnerNames: { paddingHorizontal: HEADER_METRICS.namesPad },
    headerLabel: { fontSize: 15.5, lineHeight: 20 },
    headerLabelShrink: { flexShrink: 1 },
    // Off screen and unclipped: labels measure at their natural width.
    measurer: { position: 'absolute', top: 0, left: 0, width: 4000, flexDirection: 'row', alignItems: 'flex-start', opacity: 0 },
    dot: { width: HEADER_DOT, height: HEADER_DOT, borderRadius: HEADER_DOT / 2, marginLeft: -2 },
    dotOnPicked: { borderWidth: 1.5, width: HEADER_DOT_PICKED, height: HEADER_DOT_PICKED, borderRadius: HEADER_DOT_PICKED / 2 },
});
