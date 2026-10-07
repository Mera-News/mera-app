// The counts card, slid in at the top of the list when the status icon is
// tapped (FinalFeedStatus #1-5). No dimming and no popup: it hides 5 s after
// the last touch, on a swipe up, on a second tap of the icon, or when the tab
// loses focus. While a screen reader runs it never hides by itself, and it is
// announced when it appears.
//
// An OVERLAY pinned at the header's bottom edge, never a list item: a card
// mounting and unmounting at the head of a list is the geometry change that
// shifted the Feed under its anchoring and grew Interests upward under the
// header. Mounted once per tab, OUTSIDE TabPages, so it serves every page of
// the Feed tab. The container clips at the header edge so the card slides out
// from under the header.

import { useHeaderBottom } from '@/components/custom/nav/current-surface';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { EASE, MOTION } from '@/lib/motion';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DashboardStatsCard from './DashboardStatsCard';
import { a11yStateKey } from './status-ink';

/** Hidden this long after the last touch on the card. */
export const STATUS_SLIDE_IN_HIDE_MS = 5000;
/** A swipe up past this, or a flick, dismisses. */
const DISMISS_DISTANCE = 32;
const DISMISS_VELOCITY = 500;
/** Gap under the header, matching the lists' top gap. */
const TOP_GAP = 8;

export interface StatusCardSlideInProps {
    readonly visible: boolean;
    readonly onHide: () => void;
    /** Injected by the kit gallery; the live mode otherwise. */
    readonly mode?: FeedStatusMode;
    /** Top inside the layer, for the kit gallery (no tab header there). */
    readonly topOverride?: number;
}

function useScreenReader(): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        let live = true;
        void AccessibilityInfo.isScreenReaderEnabled().then((v) => live && setOn(v));
        const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
        return () => {
            live = false;
            sub.remove();
        };
    }, []);
    return on;
}

const StatusCardSlideIn: React.FC<StatusCardSlideInProps> = ({ visible, onHide, mode: modeOverride, topOverride }) => {
    const { t } = useTranslation();
    const tAny = t as unknown as (key: string) => string;
    const liveMode = useFeedStatusMode();
    const mode = modeOverride ?? liveMode;
    const reduceMotion = useReducedMotion();
    const screenReader = useScreenReader();
    const focused = useIsFocusedSafe();
    const insets = useSafeAreaInsets();
    const headerBottom = useHeaderBottom();

    // Window y of this layer, so a window-space header bottom maps into it.
    const layerRef = useRef<View>(null);
    const [layerY, setLayerY] = useState(0);
    const top = topOverride ?? (headerBottom ?? insets.top + 56) - layerY + TOP_GAP;

    // Mounted from show until the exit slide ends. Parked far above until its
    // first layout says how far to slide.
    const [mounted, setMounted] = useState(visible);
    const offset = useSharedValue(-2000);
    const height = useRef(0);
    const entered = useRef(false);

    const hideRef = useRef(onHide);
    hideRef.current = onHide;
    // Stable, so the gesture (built once) never calls a stale handler.
    const requestHide = useCallback(() => hideRef.current(), []);
    const finishExit = useCallback(() => setMounted(false), []);

    useEffect(() => {
        if (visible) {
            if (mounted && height.current > 0) {
                // Re-shown mid-exit: the exit's completion is cancelled.
                entered.current = true;
                offset.value = reduceMotion ? 0 : withTiming(0, { duration: MOTION.status.open, easing: EASE.arrive });
            } else {
                entered.current = false;
                setMounted(true);
            }
            AccessibilityInfo.announceForAccessibility(tAny(a11yStateKey(mode)));
        } else if (reduceMotion) {
            setMounted(false);
        } else {
            offset.value = withTiming(
                -(height.current + TOP_GAP),
                { duration: MOTION.status.close, easing: EASE.leave },
                (done) => {
                    if (done) runOnJS(finishExit)();
                },
            );
        }
        // Announce on the show edge only, not on every mode change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // Hide on tab blur.
    useEffect(() => {
        if (!focused && visible) requestHide();
    }, [focused, visible, requestHide]);

    // 5 s after the last touch; never while a screen reader runs.
    const [touchEpoch, setTouchEpoch] = useState(0);
    useEffect(() => {
        if (!visible || screenReader) return;
        const id = setTimeout(requestHide, STATUS_SLIDE_IN_HIDE_MS);
        return () => clearTimeout(id);
    }, [visible, screenReader, touchEpoch, requestHide]);
    const touched = useCallback(() => setTouchEpoch((n) => n + 1), []);

    const onCardLayout = useCallback(
        (h: number) => {
            height.current = h;
            if (entered.current || !visible) return;
            entered.current = true;
            if (reduceMotion) {
                offset.value = 0;
                return;
            }
            offset.value = -(h + TOP_GAP);
            offset.value = withTiming(0, { duration: MOTION.status.open, easing: EASE.arrive });
        },
        [offset, visible, reduceMotion],
    );

    const pan = useMemo(
        () =>
            Gesture.Pan()
                .activeOffsetY([-10, 10])
                .onUpdate((e) => {
                    offset.value = Math.min(0, e.translationY);
                })
                .onEnd((e) => {
                    if (e.translationY < -DISMISS_DISTANCE || e.velocityY < -DISMISS_VELOCITY) {
                        runOnJS(requestHide)();
                    } else {
                        offset.value = withTiming(0, { duration: 160 });
                    }
                }),
        [offset, requestHide],
    );

    const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

    return (
        <View
            ref={layerRef}
            collapsable={false}
            pointerEvents="box-none"
            style={StyleSheet.absoluteFill}
            onLayout={() => layerRef.current?.measureInWindow((_x, y) => setLayerY(y))}
            testID="status-slide-in-layer"
        >
            {mounted ? (
                <View pointerEvents="box-none" style={[styles.clip, { top }]}>
                    <GestureDetector gesture={pan}>
                        <Animated.View
                            style={[styles.card, cardStyle]}
                            onLayout={(e) => onCardLayout(e.nativeEvent.layout.height)}
                            onTouchStart={touched}
                            testID="status-slide-in"
                        >
                            <DashboardStatsCard
                                mode={modeOverride}
                                overContent
                                onBeforeNavigate={onHide}
                                testID="status-slide-in-card"
                            />
                        </Animated.View>
                    </GestureDetector>
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    // Clips the card where the header ends, so it slides out from under it.
    clip: { position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' },
    card: { marginHorizontal: 12 },
});

export default StatusCardSlideIn;
