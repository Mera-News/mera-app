// ChatPopover — the morphing shell for the floating chat. Expands out of the
// floating bubble's current position into a near-full-screen panel and
// collapses back into it. Owns only the shell (backdrop, panel chrome, header,
// keyboard avoidance) — the conversation itself is passed in as children and
// is mounted fresh on every open (unmount on close guarantees a fresh session).

import MeraLogo from '@/components/custom/MeraLogo';
import { Button } from '@/components/ui/button';
import { hapticLight } from '@/lib/haptics';
import { useFloatingChatIsExpanded, useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = 'rgb(231,138,83)';
const PANEL_BG = '#1a1a1a';
const BUBBLE_SIZE = 64; // diameter of the floating bubble the panel morphs from

// Swipe-down-to-close thresholds (header grab zone only).
const SWIPE_CLOSE_DISTANCE = 90; // px of downward travel that commits a close
const SWIPE_CLOSE_VELOCITY = 900; // px/s downward fling that commits a close

// Near-critically damped (ζ ≈ 0.9): snappy settle with no visible overshoot at
// the clipped panel edges (overflow: hidden makes any overshoot read as a
// glitch). damping 22 vs the critical ~24 for stiffness 160 / mass 0.9.
const SPRING_CONFIG = { damping: 22, stiffness: 160, mass: 0.9 };

// Local lifecycle so children mount when opening begins and unmount only after
// the collapse animation completes (never mid-morph, never while visible).
export type PopoverPhase = 'closed' | 'opening' | 'open' | 'closing';

// Exposes the morph phase to descendants (e.g. ChatThread) so the input can
// autofocus only once the open morph fully settles — focusing earlier fights
// the scale transform and janks the keyboard slide-up.
export const PopoverPhaseContext = createContext<PopoverPhase>('closed');

interface ChatPopoverProps {
    children: React.ReactNode;
}

const ChatPopover: React.FC<ChatPopoverProps> = ({ children }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const isExpanded = useFloatingChatIsExpanded();
    // Frame-by-frame keyboard geometry on the UI thread. `height` is negative
    // while the keyboard is visible (it's authored as a translateY), so the
    // positive keyboard height is `-keyboard.height.value`.
    const keyboard = useReanimatedKeyboardAnimation();

    const [phase, setPhase] = useState<PopoverPhase>('closed');

    // 0 = fully collapsed into the bubble, 1 = fully expanded panel.
    const progress = useSharedValue(0);
    // The bubble center the morph anchors to. Captured at open start and again
    // at collapse start so the panel always shrinks toward the bubble's
    // CURRENT position, even if it moved while the panel was open.
    const originX = useSharedValue(0);
    const originY = useSharedValue(0);
    // Subtle header reveal (slide up 8→0 + fade) once the morph fully settles.
    const headerReveal = useSharedValue(0);
    // Follows the finger during a swipe-down-to-close drag on the header grab
    // zone; springs back to 0 if released under threshold.
    const dragTranslateY = useSharedValue(0);

    // Panel geometry — background must visibly peek at every edge.
    const panelTop = insets.top + 24;
    const panelBottom = insets.bottom + 10;
    const panelWidth = screenWidth - 20; // left: 10, right: 10
    const panelHeight = screenHeight - panelTop - panelBottom;
    const panelCenterX = screenWidth / 2;
    const panelCenterY = panelTop + panelHeight / 2;

    const finishOpen = useCallback(() => {
        setPhase((p) => (p === 'opening' ? 'open' : p));
    }, []);

    const finishClose = useCallback(() => {
        // Idempotent when the collapse came from the store; required when the
        // close started from a backdrop/X tap (store still says expanded).
        useFloatingChatStore.getState().collapse();
        setPhase((p) => (p === 'closing' ? 'closed' : p));
    }, []);

    const startClosing = useCallback(() => {
        const { bubbleCenter } = useFloatingChatStore.getState();
        originX.value = bubbleCenter.x;
        originY.value = bubbleCenter.y;
        setPhase('closing');
        progress.value = withSpring(0, SPRING_CONFIG, (finished) => {
            if (finished) runOnJS(finishClose)();
        });
    }, [originX, originY, progress, finishClose]);

    // User-initiated close (backdrop tap or X). Must work mid-stream — nothing
    // here is gated on generation state.
    const requestClose = useCallback(() => {
        setPhase((p) => {
            if (p !== 'open' && p !== 'opening') return p;
            Keyboard.dismiss();
            startClosing();
            return p; // startClosing sets 'closing'; keep this updater pure-ish
        });
    }, [startClosing]);

    const onClosePress = useCallback(() => {
        hapticLight();
        requestClose();
    }, [requestClose]);

    // Start a fresh conversation without leaving the popover. MeraChatSession
    // watches the store's newChatNonce, creates a new conversation row, resets
    // the cloud store, and remounts the thread (intro + starter chips again).
    const onNewChatPress = useCallback(() => {
        hapticLight();
        useFloatingChatStore.getState().requestNewChat();
    }, []);

    // Swipe-down-to-close on the header grab zone only (never the message list —
    // this gesture is mounted around the logo/title, not the FlatList). Requires
    // downward intent (activeOffsetY) and bails on horizontal drift so it never
    // competes with taps on the X or with vertical scroll below the header.
    const swipeDownGesture = useMemo(
        () =>
            Gesture.Pan()
                .activeOffsetY(14)
                .failOffsetX([-24, 24])
                .onUpdate((e) => {
                    'worklet';
                    // Only track downward motion; ignore upward drags entirely.
                    dragTranslateY.value = Math.max(0, e.translationY);
                })
                .onEnd((e) => {
                    'worklet';
                    if (e.translationY > SWIPE_CLOSE_DISTANCE || e.velocityY > SWIPE_CLOSE_VELOCITY) {
                        // Commit: same collapse path as the X/backdrop (dismisses
                        // keyboard + reverse morph). Ease the drag offset out so it
                        // doesn't fight the morph's own translateY back to origin.
                        runOnJS(requestClose)();
                        dragTranslateY.value = withTiming(0, { duration: 220 });
                    } else {
                        dragTranslateY.value = withSpring(0, SPRING_CONFIG);
                    }
                }),
        [dragTranslateY, requestClose],
    );

    // Drive the phase machine from the store's isExpanded flag.
    useEffect(() => {
        if (isExpanded && (phase === 'closed' || phase === 'closing')) {
            const { bubbleCenter } = useFloatingChatStore.getState();
            originX.value = bubbleCenter.x;
            originY.value = bubbleCenter.y;
            setPhase('opening');
            progress.value = withSpring(1, SPRING_CONFIG, (finished) => {
                if (finished) runOnJS(finishOpen)();
            });
        } else if (!isExpanded && (phase === 'open' || phase === 'opening')) {
            // Collapse initiated outside this component (e.g. store.collapse()
            // from navigation) — still animate back into the bubble.
            Keyboard.dismiss();
            startClosing();
        }
    }, [isExpanded, phase, originX, originY, progress, finishOpen, startClosing]);

    // Reveal the header only after the panel finishes opening; reset when fully
    // closed so it replays on the next open.
    useEffect(() => {
        if (phase === 'open') {
            headerReveal.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) });
        } else if (phase === 'closed') {
            headerReveal.value = 0;
        }
    }, [phase, headerReveal]);

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
    }));

    const headerStyle = useAnimatedStyle(() => ({
        opacity: headerReveal.value,
        transform: [{ translateY: interpolate(headerReveal.value, [0, 1], [8, 0]) }],
    }));

    const panelStyle = useAnimatedStyle(() => {
        const p = progress.value;
        const collapsedScale = BUBBLE_SIZE / panelWidth;
        // Shrink the panel's bottom edge up to sit just above the keyboard so the
        // input row is anchored on top of it. `panelBottom` already includes the
        // safe-area inset, so subtract it out of the keyboard height to avoid
        // double-counting: effective bottom = panelBottom + max(0, kb - inset).
        // The morph math (panelCenterY/panelHeight) stays on the FULL keyboard-
        // closed geometry — close dismisses the keyboard first, so bottom returns
        // to panelBottom as the panel collapses into the bubble.
        const keyboardHeight = -keyboard.height.value;
        const extraBottom = Math.max(0, keyboardHeight - insets.bottom);
        return {
            opacity: interpolate(p, [0, 0.35], [0, 1], Extrapolation.CLAMP),
            bottom: panelBottom + extraBottom,
            transform: [
                { translateX: (1 - p) * (originX.value - panelCenterX) },
                { translateY: (1 - p) * (originY.value - panelCenterY) + dragTranslateY.value },
                { scale: collapsedScale + p * (1 - collapsedScale) },
            ],
        };
    });

    if (phase === 'closed') return null;

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {/* Backdrop — always tappable, even mid-morph or mid-stream */}
            <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
                <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={requestClose}
                    accessibilityLabel={t('floatingChat.close')}
                    accessibilityRole="button"
                />
            </Animated.View>

            {/* Morphing panel. `bottom` is driven by panelStyle (keyboard-aware). */}
            <Animated.View
                style={[
                    styles.panel,
                    {
                        top: panelTop,
                        left: 10,
                        right: 10,
                    },
                    panelStyle,
                ]}
            >
                <Animated.View style={[styles.header, headerStyle]}>
                    {/* Grab zone (logo + title) — pans down to close. Kept off the X
                        so a swipe-down never eats a tap on the close button. */}
                    <GestureDetector gesture={swipeDownGesture}>
                        <View style={styles.headerGrab}>
                            <MeraLogo size={28} />
                            <Text style={styles.title}>{t('floatingChat.title')}</Text>
                        </View>
                    </GestureDetector>
                    {/* Gluestack Buttons (className/tva-driven), NOT Pressables with
                        function-form style props: under NativeWind v4's babel interop
                        the function form gets dropped, which erased these buttons'
                        background fills at runtime (item-13 bug). Dark-mode tokens:
                        primary-400 = rgb(231,138,83) (ACCENT), error-400 = #ef4444. */}
                    <Button
                        onPress={onNewChatPress}
                        accessibilityLabel={t('floatingChat.newChat')}
                        hitSlop={12}
                        action="default"
                        className="w-9 h-9 p-0 rounded-full bg-primary-400/25 data-[active=true]:bg-primary-400/40"
                    >
                        <MaterialIcons name="add-comment" size={20} color={ACCENT} />
                    </Button>
                    <Button
                        onPress={onClosePress}
                        accessibilityLabel={t('floatingChat.close')}
                        hitSlop={12}
                        action="negative"
                        className="w-9 h-9 p-0 rounded-full bg-error-400 data-[active=true]:bg-error-300"
                    >
                        <MaterialIcons name="close" size={22} color="#fff" />
                    </Button>
                </Animated.View>

                {/* The panel itself shrinks above the keyboard (see panelStyle), so
                    no KeyboardAvoidingView is needed — it was redundant here and
                    couldn't measure reliably inside the morph transform. */}
                <View style={styles.body}>
                    <PopoverPhaseContext.Provider value={phase}>{children}</PopoverPhaseContext.Provider>
                </View>
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    backdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    panel: {
        position: 'absolute',
        borderRadius: 24,
        backgroundColor: PANEL_BG,
        borderWidth: 1,
        borderColor: ACCENT,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255, 255, 255, 0.12)',
        zIndex: 2, // keep header (and its tappable X) above the body content
    },
    headerGrab: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    title: {
        flex: 1,
        color: '#fff',
        fontSize: 17,
        fontWeight: '600',
    },
    body: {
        flex: 1,
    },
});

export default ChatPopover;
