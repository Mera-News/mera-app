import { armPendingFocus, takeFocus, usePendingFocusIds, type FocusId } from '@/lib/navigation/focus-target';
import { useFocusEffect } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Dimensions, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** What a screen that can be jumped to gives its targets: the view the
 *  targets measure against (the scroll content) and how to scroll there. */
export interface FocusHost {
    readonly contentRef: React.RefObject<View | null>;
    readonly scrollToY: (y: number, animated: boolean) => void;
}

const FocusHostContext = createContext<FocusHost | null>(null);

/** Wrap a jump destination's scroll content. Arms the pending target (its
 *  expiry clock) when the screen gains focus. */
export const FocusHostProvider: React.FC<{ readonly host: FocusHost; readonly children: React.ReactNode }> = ({
    host,
    children,
}) => {
    useFocusEffect(
        useCallback(() => {
            armPendingFocus();
        }, []),
    );
    return <FocusHostContext.Provider value={host}>{children}</FocusHostContext.Provider>;
};

/** Seen this long on screen before the highlight fades (owner rule). */
export const HIGHLIGHT_SEEN_MS = 2_000;
const HIGHLIGHT_FADE_MS = 1_000;
const SEEN_POLL_MS = 500;
/** A target never on screen stops polling after this. */
const HIGHLIGHT_MAX_MS = 60_000;
const SCROLL_MARGIN = 16;

interface FocusTargetProps {
    readonly id: FocusId;
    /** Spoken when the jump lands here (the card or row title). */
    readonly announce: string;
    readonly radius?: number;
    readonly style?: StyleProp<ViewStyle>;
    readonly children: React.ReactNode;
}

/**
 * Wraps a card or row a jump can land on. When its id is pending and it is
 * laid out, it takes the id (one-shot), the first one asked for scrolls into
 * view and gets screen-reader focus, and every taken target shows an orange
 * outline with a 10% fill that holds until it has been on screen for
 * HIGHLIGHT_SEEN_MS, then fades. Under Reduce Motion the scroll is instant and
 * the highlight disappears without a fade.
 *
 * Core Animated on purpose: Reanimated here would drag the worklets native
 * module into every suite that renders a settings screen.
 */
const FocusTarget: React.FC<FocusTargetProps> = ({ id, announce, radius = 16, style, children }) => {
    const host = useContext(FocusHostContext);
    const pendingIds = usePendingFocusIds();
    const ref = useRef<View>(null);
    const laidOut = useRef(false);
    const reduceMotion = useRef(false);
    const opacity = useRef(new Animated.Value(0)).current;
    const [lit, setLit] = useState(false);

    const tryTake = useCallback(() => {
        if (!laidOut.current || !pendingIds.includes(id)) return;
        const take = takeFocus(id);
        if (take === 'none') return;
        AccessibilityInfo.isReduceMotionEnabled()
            .catch(() => false)
            .then((reduce) => {
                reduceMotion.current = reduce;
                const node = ref.current;
                const content = host?.contentRef.current;
                if (take === 'scroll') {
                    if (node && content) {
                        node.measureLayout(
                            content,
                            (_x, y) => host?.scrollToY(Math.max(0, y - SCROLL_MARGIN), !reduce),
                            () => { /* not measurable: no scroll, still highlighted */ },
                        );
                    }
                    AccessibilityInfo.announceForAccessibility(announce);
                    if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
                }
                opacity.setValue(1);
                setLit(true);
            });
    }, [id, pendingIds, host, announce, opacity]);

    useEffect(() => {
        tryTake();
    }, [tryTake]);

    // Hold until seen, then fade.
    useEffect(() => {
        if (!lit) return undefined;
        let seen = 0;
        let elapsed = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearInterval(timer);
            if (reduceMotion.current) {
                setLit(false);
                return;
            }
            Animated.timing(opacity, { toValue: 0, duration: HIGHLIGHT_FADE_MS, useNativeDriver: true }).start(() =>
                setLit(false),
            );
        };
        const timer = setInterval(() => {
            elapsed += SEEN_POLL_MS;
            if (elapsed >= HIGHLIGHT_MAX_MS) return finish();
            ref.current?.measureInWindow((_x, y, _w, h) => {
                const windowHeight = Dimensions.get('window').height;
                if (h > 0 && y < windowHeight && y + h > 0) seen += SEEN_POLL_MS;
                if (seen >= HIGHLIGHT_SEEN_MS) finish();
            });
        }, SEEN_POLL_MS);
        return () => {
            done = true;
            clearInterval(timer);
        };
    }, [lit, opacity]);

    return (
        <View
            ref={ref}
            collapsable={false}
            style={style}
            onLayout={() => {
                laidOut.current = true;
                tryTake();
            }}
        >
            {children}
            {lit ? (
                <Animated.View
                    testID={`focus-highlight-${id}`}
                    pointerEvents="none"
                    style={[
                        StyleSheet.absoluteFill,
                        {
                            borderRadius: radius,
                            borderWidth: 1.5,
                            borderColor: 'rgba(231,138,83,0.8)',
                            backgroundColor: 'rgba(231,138,83,0.10)',
                            opacity,
                        },
                    ]}
                />
            ) : null}
        </View>
    );
};

export default FocusTarget;
