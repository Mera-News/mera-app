import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Platform,
    Pressable,
    I18nManager,
    StyleSheet,
    Text,
    View,
    type LayoutChangeEvent,
    type StyleProp,
    type TextLayoutEventData,
    type NativeSyntheticEvent,
    type ViewStyle,
} from 'react-native';
import Animated, {
    Easing,
    LinearTransition,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import { hapticSelection } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { MAX_FONT_SCALE } from '@/lib/typography/policy';

import { HEADER_METRICS, headerOptionParts, headerTrackMode } from './fit';
import { fillAt, settleFill, type OptionBox } from './fill';
import { useMotionAllowed } from '@/lib/motion-gate';

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
    /** Header size only: the pager's fractional page index. The ONE selected
     *  fill rides it (fill.ts), so a swipe drags it and a tap's slide carries
     *  it; without it the fill slides to the picked option on its own. */
    progress?: SharedValue<number>;
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
/** A page change in the header: the pager's tap slide (PagePager
 *  TAP_SLIDE_MS) and its ease-out, so labels, reflow, fill and page land
 *  together. */
const PAGE_MOTION = { duration: 300, easing: Easing.out(Easing.cubic) };
const optionReflow = LinearTransition.duration(PAGE_MOTION.duration).easing(PAGE_MOTION.easing);
/** A label leaving scales to 0 into its own leading edge (next to its icon)
 *  as it fades; one arriving grows from there. The default ReduceMotion
 *  (System) lets LiteMotionConfig land both at once. */
function labelIn() {
    'worklet';
    return {
        initialValues: { opacity: 0, transform: [{ scale: 0 }] },
        animations: {
            opacity: withTiming(1, PAGE_MOTION),
            transform: [{ scale: withTiming(1, PAGE_MOTION) }],
        },
    };
}
function labelOut() {
    'worklet';
    return {
        initialValues: { opacity: 1, transform: [{ scale: 1 }] },
        animations: {
            opacity: withTiming(0, PAGE_MOTION),
            transform: [{ scale: withTiming(0, PAGE_MOTION) }],
        },
    };
}

function HeaderTrack<T extends string>({
    options,
    value,
    onChange,
    style,
    testID,
    availableWidth = null,
    namesFirst = false,
    iconsOnly = false,
    progress,
}: SegmentedControlProps<T>) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const motionAllowed = useMotionAllowed();
    // ONE selected fill under the options, moving between their MEASURED
    // boxes (x and width) by the driver: the pager's progress when given,
    // else its own slide to the picked index. All on the UI thread.
    // The JS copy is the truth: a shared value written from JS reaches the UI
    // thread on a later tick, so reading it back on JS returns the OLD value
    // (several options reporting in one tick each overwrote the others).
    const boxesRef = useRef<(OptionBox | null)[]>(options.map(() => null));
    const boxes = useSharedValue<(OptionBox | null)[]>(boxesRef.current);
    const fillY = useSharedValue(0);
    // A new layout (a label in or out, a text size change) moves the boxes
    // at once; the fill settles from the old set onto the new one.
    const boxesFrom = useSharedValue<(OptionBox | null)[]>(boxesRef.current);
    const settle = useSharedValue(1);
    const appliedRef = useRef<(OptionBox | null)[] | null>(null);
    const flushQueued = useRef(false);
    // Until every option has reported its box, the picked option draws its
    // own still fill, so the track never shows with no selection.
    const [measured, setMeasured] = useState(false);
    useEffect(() => {
        if (boxesRef.current.length === options.length) return;
        boxesRef.current = Array<OptionBox | null>(options.length).fill(null);
        boxes.value = boxesRef.current;
        appliedRef.current = null;
        setMeasured(false);
    }, [options.length, boxes]);
    const onOptionLayout = useCallback(
        (i: number, e: LayoutChangeEvent) => {
            const { x, y, width } = e.nativeEvent.layout;
            const prev = boxesRef.current[i];
            if (prev && prev.x === x && prev.width === width) return;
            const next = boxesRef.current.slice();
            next[i] = { x, width };
            boxesRef.current = next;
            fillY.value = y;
            if (!(next.length === options.length && next.every(Boolean))) return;
            setMeasured(true);
            // Options report one by one in the same tick: apply the set once.
            if (flushQueued.current) return;
            flushQueued.current = true;
            queueMicrotask(() => {
                flushQueued.current = false;
                const to = boxesRef.current;
                const from = appliedRef.current ?? to;
                appliedRef.current = to;
                boxesFrom.value = from;
                boxes.value = to;
                settle.value = 0;
                settle.value = motionAllowed && from !== to ? withTiming(1, PAGE_MOTION) : 1;
            });
        },
        [boxes, boxesFrom, settle, fillY, options.length, motionAllowed],
    );
    const pickedIndex = Math.max(0, options.findIndex((o) => o.value === value));
    const own = useSharedValue(pickedIndex);
    useEffect(() => {
        own.value = motionAllowed
            ? withTiming(pickedIndex, PAGE_MOTION)
            : pickedIndex;
    }, [pickedIndex, motionAllowed, own]);
    const driver = progress ?? own;
    const fillStyle = useAnimatedStyle(() => {
        const b = settleFill(fillAt(driver.value, boxesFrom.value), fillAt(driver.value, boxes.value), settle.value);
        if (!b) return { opacity: 0 };
        return { opacity: 1, width: b.width, transform: [{ translateX: b.x }, { translateY: fillY.value }] };
    });
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
            layout={reduceMotion ? undefined : optionReflow}
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
            {/* Over the track's border box, laid out LTR: onLayout's x is
                physical, and a plain `left` flips to the right under RTL. */}
            <View pointerEvents="none" style={styles.sliderFrame}>
                <Animated.View style={[styles.headerSlider, { backgroundColor: colors.accent }, fillStyle]} />
            </View>
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
            {options.map((o, i) => (
                <HeaderOption
                    key={o.value}
                    option={o}
                    onLayout={(e) => onOptionLayout(i, e)}
                    on={o.value === value}
                    stillFill={!measured && o.value === value}
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
    onLayout,
    stillFill,
    testID,
}: {
    option: SegmentedOption<T>;
    onLayout: (e: LayoutChangeEvent) => void;
    stillFill: boolean;
    on: boolean;
    parts: { label: boolean; icon: boolean };
    onPress: () => void;
    testID?: string;
}) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const useDot = option.useDot ?? noDot;
    const dot = useDot();
    const ink = on ? colors.onAccent : colors.muted;
    return (
        // A hidden visual under a CHILDLESS labelled button: a glyph inside a
        // button surfaces on iOS as its own StaticText. An icon-only option
        // still speaks its full label ("Saved, 1 of 4").
        <Animated.View
            layout={reduceMotion ? undefined : optionReflow}
            style={[styles.headerOption, on ? styles.headerOptionPicked : null]}
            onLayout={onLayout}
        >
            {stillFill ? (
                <View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, styles.headerFill, { backgroundColor: colors.accent }]}
                />
            ) : null}
            <View
                pointerEvents="none"
                style={[styles.headerInner, parts.icon ? null : styles.headerInnerNames]}
                {...HIDDEN}
            >
                {option.icon && parts.icon ? <MaterialIcons name={option.icon} size={HEADER_ICON} color={ink} /> : null}
                {parts.label ? (
                    <Animated.Text
                        entering={reduceMotion ? undefined : labelIn}
                        exiting={reduceMotion ? undefined : labelOut}
                        numberOfLines={1}
                        maxFontSizeMultiplier={MAX_FONT_SCALE.chrome}
                        style={[styles.headerLabel, styles.headerLabelShrink, styles.labelOrigin, { color: ink, fontWeight: on ? '700' : '500' }]}
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
    // The one sliding fill, in a frame over the track's border box (the
    // origin of the options' measured x and y). Equal insets and LTR, so RTL
    // neither flips the frame nor the fill's offset.
    sliderFrame: { position: 'absolute', top: -BORDER, bottom: -BORDER, left: -BORDER, right: -BORDER, direction: 'ltr' },
    headerSlider: {
        position: 'absolute',
        left: 0,
        top: 0,
        height: HEADER_OPTION_HEIGHT,
        borderRadius: HEADER_OPTION_HEIGHT / 2,
    },
    headerInner: { flexDirection: 'row', alignItems: 'center', gap: HEADER_GAP, paddingHorizontal: HEADER_OPTION_PAD },
    headerInnerNames: { paddingHorizontal: HEADER_METRICS.namesPad },
    headerLabel: { fontSize: 15.5, lineHeight: 20 },
    headerLabelShrink: { flexShrink: 1 },
    // The leading edge, where the label meets its icon.
    labelOrigin: { transformOrigin: I18nManager.isRTL ? 'right center' : 'left center' },
    // Off screen and unclipped: labels measure at their natural width.
    measurer: { position: 'absolute', top: 0, left: 0, width: 4000, flexDirection: 'row', alignItems: 'flex-start', opacity: 0 },
    dot: { width: HEADER_DOT, height: HEADER_DOT, borderRadius: HEADER_DOT / 2, marginLeft: -2 },
    dotOnPicked: { borderWidth: 1.5, width: HEADER_DOT_PICKED, height: HEADER_DOT_PICKED, borderRadius: HEADER_DOT_PICKED / 2 },
});
