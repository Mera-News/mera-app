import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    makeMutable,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

const STREAMING_LABEL_KEYS = [
    'chat.streamingLabels.understanding',
    'chat.streamingLabels.analyzing',
    'chat.streamingLabels.connectingDots',
    'chat.streamingLabels.contextualizing',
    'chat.streamingLabels.synthesizing',
    'chat.streamingLabels.personalizing',
    'chat.streamingLabels.mappingInterests',
    'chat.streamingLabels.learningPreferences',
    'chat.streamingLabels.buildingProfile',
    'chat.streamingLabels.calibrating',
    'chat.streamingLabels.processing',
    'chat.streamingLabels.refiningTaste',
    'chat.streamingLabels.detectingPatterns',
    'chat.streamingLabels.adaptingFeed',
    'chat.streamingLabels.evaluatingSignals',
    'chat.streamingLabels.updatingModel',
    'chat.streamingLabels.weighingTopics',
    'chat.streamingLabels.discoveringThemes',
    'chat.streamingLabels.tuningRelevance',
    'chat.streamingLabels.optimizing',
] as const;

const STREAMING_LABEL_CYCLE_MS = 2000;
// Half of the label crossfade. The caption fades OUT over this window, swaps
// text at the trough, then fades back IN — so exactly one caption is mounted
// (and painted) at any instant. Do NOT go back to a keyed Animated.View with
// entering/exiting: Reanimated keeps the exiting copy on screen (outside the
// layout flow) while the new one mounts, which drew two captions on top of each
// other inside the fixed-height labelRow.
const LABEL_FADE_MS = 220;

const DEFAULT_LABEL_COLOR = 'rgb(156, 163, 175)';
const DEFAULT_DOT_COLOR = 'rgb(231, 138, 83)';

/** How long a card's note may stay pending before the placeholder gives up and
 *  says so. A scoring bundle that dies whole leaves its rows in
 *  `reason_pending` for good, and a caption cycling forever is a false claim
 *  that work is happening. A reason that lands later still replaces the line. */
export const REASON_PENDING_CAP_MS = 90_000;

// ── ONE shared clock for every mounted indicator ─────────────────────────────
//
// This renders on EVERY Feed card whose note is still pending, so a busy feed
// mounts dozens of them, and tabs stay mounted. Each used to own a setInterval
// and three `withRepeat` loops, with no gate at all: they ran on hidden tabs,
// under Reduce Motion, and forever. Now there is one caption interval and one
// dot phase for the whole app, running only while at least one indicator is
// ACTIVE (visible, motion allowed). Everything else reads the shared values.

const CYCLE_DOT_MS = 900;

let captionIndex = 0;
const captionListeners = new Set<() => void>();
let activeCount = 0;
let captionTimer: ReturnType<typeof setInterval> | null = null;
/** 0..1, advanced on the UI thread while the clock runs. */
const dotPhase = makeMutable(0);

function subscribeCaption(listener: () => void): () => void {
    captionListeners.add(listener);
    return () => {
        captionListeners.delete(listener);
    };
}

function getCaptionIndex(): number {
    return captionIndex;
}

function acquireClock(): void {
    activeCount += 1;
    if (captionTimer !== null) return;
    captionTimer = setInterval(() => {
        captionIndex = (captionIndex + 1) % STREAMING_LABEL_KEYS.length;
        captionListeners.forEach((l) => l());
    }, STREAMING_LABEL_CYCLE_MS);
    dotPhase.value = 0;
    dotPhase.value = withRepeat(
        withTiming(1, { duration: CYCLE_DOT_MS, easing: Easing.linear }),
        -1,
        false,
    );
}

function releaseClock(): void {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount > 0) return;
    if (captionTimer !== null) {
        clearInterval(captionTimer);
        captionTimer = null;
    }
    cancelAnimation(dotPhase);
    dotPhase.value = 0;
}

/** Test seam: how many indicators hold the clock, and whether it is running. */
export function streamingClockStateForTest(): { activeCount: number; running: boolean } {
    return { activeCount, running: captionTimer !== null };
}

/** Scale for dot `i` (0..2) at `phase`: a short bump inside its third of the
 *  cycle, 1 everywhere else. Same rhythm as the old per-dot sequences. */
function dotScale(phase: number, i: number): number {
    'worklet';
    let d = phase - (i / 3 + 1 / 6);
    d = d - Math.round(d);
    const bump = Math.max(0, 1 - Math.abs(d) * 6);
    return 1 + 0.6 * bump;
}

interface StreamingIndicatorProps {
    /** Inline variant: label + dots only, no logo, no vertical padding. */
    compact?: boolean;
    /** Overrides both label and dot color (defaults: gray label, orange dots). */
    color?: string;
    /** When the thing being waited on started (epoch ms). With it, the
     *  indicator stops after {@link REASON_PENDING_CAP_MS} and shows
     *  `terminalText` instead of cycling forever. */
    pendingSinceMs?: number | null;
    /** What to show once the cap has passed. Required for the cap to apply. */
    terminalText?: string;
}

const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
    compact = false,
    color,
    pendingSinceMs,
    terminalText,
}) => {
    const { t } = useTranslation();
    const labelColor = color ?? DEFAULT_LABEL_COLOR;
    const dotColor = color ?? DEFAULT_DOT_COLOR;

    // Past the cap: a one-shot timer flips this once, no polling.
    const capApplies = typeof pendingSinceMs === 'number' && !!terminalText;
    const [expired, setExpired] = useState(
        () => capApplies && Date.now() - (pendingSinceMs as number) >= REASON_PENDING_CAP_MS,
    );
    useEffect(() => {
        if (!capApplies) {
            setExpired(false);
            return;
        }
        const remaining = (pendingSinceMs as number) + REASON_PENDING_CAP_MS - Date.now();
        if (remaining <= 0) {
            setExpired(true);
            return;
        }
        setExpired(false);
        const timer = setTimeout(() => setExpired(true), remaining);
        return () => clearTimeout(timer);
    }, [capApplies, pendingSinceMs]);

    // `useAnimationsActive` is false only when this screen is blurred or the
    // app is backgrounded, i.e. when nobody is looking. Its own header warns
    // against gating an in-flight liveness signal on something NARROWER than
    // that; pausing while nobody can see it creates no "hung" impression.
    const animationsActive = useAnimationsActive();
    const reduceMotion = useReducedMotion();
    const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
    const moving = animationsActive && !reduceMotion && !staticGradient && !expired;

    useEffect(() => {
        if (!moving) return;
        acquireClock();
        return releaseClock;
    }, [moving]);

    // The shared caption index, crossfaded per instance. The text swaps at the
    // fade trough so exactly one caption is ever painted.
    const sharedIndex = useSyncExternalStore(subscribeCaption, getCaptionIndex, getCaptionIndex);
    const [shownIndex, setShownIndex] = useState(sharedIndex);
    const labelOpacity = useSharedValue(1);
    const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (sharedIndex === shownIndex) return;
        if (!moving) {
            setShownIndex(sharedIndex);
            return;
        }
        labelOpacity.value = withTiming(0, { duration: LABEL_FADE_MS });
        swapTimer.current = setTimeout(() => {
            setShownIndex(sharedIndex);
            labelOpacity.value = withTiming(1, { duration: LABEL_FADE_MS });
        }, LABEL_FADE_MS);
        return () => {
            if (swapTimer.current) clearTimeout(swapTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sharedIndex, moving]);

    const labelStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.value }));
    const dot1Style = useAnimatedStyle(() => ({ transform: [{ scale: moving ? dotScale(dotPhase.value, 0) : 1 }] }));
    const dot2Style = useAnimatedStyle(() => ({ transform: [{ scale: moving ? dotScale(dotPhase.value, 1) : 1 }] }));
    const dot3Style = useAnimatedStyle(() => ({ transform: [{ scale: moving ? dotScale(dotPhase.value, 2) : 1 }] }));

    if (expired && terminalText) {
        return (
            <Text
                testID="card-reason-unavailable"
                size="sm"
                style={[streamingIndicatorStyles.label, { color: labelColor }]}
            >
                {terminalText}
            </Text>
        );
    }

    const labelRow = (
        <View style={streamingIndicatorStyles.labelRow}>
            <View style={streamingIndicatorStyles.labelInner}>
                {/* Only the WORD crossfades. The dots stay at full opacity: they
                    are the liveness signal, and the fade trough would otherwise
                    blank the whole indicator for a beat every cycle. */}
                <Animated.View style={labelStyle}>
                    <Text
                        testID="streaming-caption"
                        size="sm"
                        style={[streamingIndicatorStyles.label, { color: labelColor }]}
                    >
                        {t(STREAMING_LABEL_KEYS[shownIndex % STREAMING_LABEL_KEYS.length])}
                    </Text>
                </Animated.View>
                <View style={streamingIndicatorStyles.dotsRow}>
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot1Style]} />
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot2Style]} />
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot3Style]} />
                </View>
            </View>
        </View>
    );

    if (compact) {
        return labelRow;
    }

    return (
        <View style={streamingIndicatorStyles.container}>
            <MeraLogo size={48} animated />
            {labelRow}
        </View>
    );
};

const streamingIndicatorStyles = StyleSheet.create({
    container: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24, gap: 12 },
    // `minHeight`, not `height`, and no `overflow: 'hidden'`. This row was a
    // hard 22pt box with clipping switched on around text that React Native
    // was already free to scale to ~3.1x — the single worst clip site in the
    // app. 22 still reserves the row so the indicator does not jump as the
    // word crossfades; it just no longer amputates it.
    labelRow: { minHeight: 22, justifyContent: 'center' },
    labelInner: { flexDirection: 'row', alignItems: 'center' },
    // No `fontSize` here: the `size="sm"` token owns it, so this label is on
    // the type scale (and honours the in-app text-size control) instead of
    // being pinned at 13px outside it.
    label: { color: 'rgb(156, 163, 175)' },
    dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 2, marginBottom: -1 },
    dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgb(231, 138, 83)' },
});

export default StreamingIndicator;
