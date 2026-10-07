// ChatPopover: the chat's shell. The panel grows out of the Mera button
// wherever it sits and shrinks back into it (FinalMotion "Chat opens out of
// the button": 320 ms arrive, 200 ms leave, a fade under Reduce Motion). Owns
// only the shell (backdrop, material, header, keyboard avoidance); the
// conversation is passed in as children and unmounts on close, which costs a
// running turn nothing: turns live in the chat session (lib/chat-session).
//
// ONE MERA MARK ON SCREEN: the button hides while the panel shows, and a
// riding mark carries the button's disc and logo from the button up to the
// header's avatar slot on the same progress, and back down on close.

import MeraLogo from '@/components/custom/MeraLogo';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { GlyphSafeIconButton } from './glyph-safe';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { hapticLight } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { prewarmCloudChat } from '@/lib/llm/prewarm';
import { useFloatingChatIsExpanded, useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The header's avatar slot, where the riding mark lands (FinalMeraChat #5). */
const AVATAR = 24;
const HEADER_PAD_TOP = 14;
const HEADER_PAD_LEFT = 16;
/** The header row is as tall as its 44pt buttons. */
const HEADER_ROW = 44;
/** The button's logo at rest (MeraButton draws it at 38 pt). */
const BUTTON_LOGO = 38;
const PANEL_INSET = 10;

// Swipe-down-to-close thresholds (header grab zone only).
const SWIPE_CLOSE_DISTANCE = 90; // px of downward travel that commits a close
const SWIPE_CLOSE_VELOCITY = 900; // px/s downward fling that commits a close

// A header drag released under the threshold springs back: near-critically
// damped, so the clipped panel edge never overshoots.
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
    const colors = useColors();
    const reduceMotion = useReducedMotion();
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
    // Follows the finger during a swipe-down-to-close drag on the header grab
    // zone; springs back to 0 if released under threshold.
    const dragTranslateY = useSharedValue(0);

    // Panel geometry — background must visibly peek at every edge.
    const panelTop = insets.top + 24;
    const panelBottom = insets.bottom + 10;
    const panelWidth = screenWidth - 2 * PANEL_INSET;
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
        progress.value = withTiming(
            0,
            reduceMotion
                ? { duration: MOTION.chat.reduce }
                : { duration: MOTION.chat.close, easing: EASE.leave },
            (finished) => {
                if (finished) runOnJS(finishClose)();
            },
        );
    }, [originX, originY, progress, finishClose, reduceMotion]);

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

    // Start a fresh conversation without leaving the popover. requestNewChat
    // nulls the store's conversationId; MeraChatSession's level-triggered
    // ensure-conversation effect sees the null, creates a new conversation row,
    // resets the cloud store, and remounts the thread (intro + starter chips
    // again via key={conversationId}).
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
            // Earliest single hook on the expand path: warm the cloud-chat
            // critical path (attestation + JWT) the instant the panel starts
            // opening, before MeraChatSession mounts. Idempotent + no-op on-device.
            prewarmCloudChat();
            const { bubbleCenter } = useFloatingChatStore.getState();
            originX.value = bubbleCenter.x;
            originY.value = bubbleCenter.y;
            setPhase('opening');
            progress.value = withTiming(
                1,
                reduceMotion
                    ? { duration: MOTION.chat.reduce }
                    : { duration: MOTION.chat.open, easing: EASE.arrive },
                (finished) => {
                    if (finished) runOnJS(finishOpen)();
                },
            );
        } else if (!isExpanded && (phase === 'open' || phase === 'opening')) {
            // Collapse initiated outside this component (e.g. store.collapse()
            // from navigation) — still animate back into the bubble.
            Keyboard.dismiss();
            startClosing();
        }
    }, [isExpanded, phase, originX, originY, progress, finishOpen, startClosing, reduceMotion]);

    // The Mera button hides for as long as the panel is on screen, motion
    // included, so its mark and the panel's are never both shown.
    useEffect(() => {
        useFloatingChatStore.getState().setChatShown(phase !== 'closed');
    }, [phase]);

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
    }));

    const panelStyle = useAnimatedStyle(() => {
        const p = progress.value;
        const collapsedScale = MERA_BUTTON_SIZE / panelWidth;
        // Shrink the panel's bottom edge up to sit just above the keyboard so the
        // input row is anchored on top of it. `panelBottom` already includes the
        // safe-area inset, so subtract it out of the keyboard height to avoid
        // double-counting: effective bottom = panelBottom + max(0, kb - inset).
        // The morph math (panelCenterY/panelHeight) stays on the FULL keyboard-
        // closed geometry — close dismisses the keyboard first, so bottom returns
        // to panelBottom as the panel collapses into the bubble.
        const keyboardHeight = -keyboard.height.value;
        const extraBottom = Math.max(0, keyboardHeight - insets.bottom);
        if (reduceMotion) {
            return {
                opacity: p,
                bottom: panelBottom + extraBottom,
                transform: [{ translateY: dragTranslateY.value }],
            };
        }
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

    // The riding mark: centred on the button at 0, on the header's avatar
    // slot at 1. Its disc and dark logo fade out as it rises and the light
    // logo fades in, so it lands as the avatar. Under Reduce Motion it does
    // not travel: it sits on the slot and fades with the panel.
    const slotX = PANEL_INSET + HEADER_PAD_LEFT + AVATAR / 2;
    const slotY = panelTop + HEADER_PAD_TOP + HEADER_ROW / 2;
    const riderStyle = useAnimatedStyle(() => {
        const p = progress.value;
        const travel = reduceMotion ? 1 : p;
        const x = originX.value + (slotX - originX.value) * travel;
        const y = originY.value + (slotY - originY.value) * travel + dragTranslateY.value;
        return {
            opacity: reduceMotion ? p : 1,
            transform: [
                { translateX: x - MERA_BUTTON_SIZE / 2 },
                { translateY: y - MERA_BUTTON_SIZE / 2 },
                { scale: 1 + (AVATAR / BUTTON_LOGO - 1) * travel },
            ],
        };
    });
    const discStyle = useAnimatedStyle(() => ({ opacity: reduceMotion ? 0 : 1 - progress.value }));
    const lightMarkStyle = useAnimatedStyle(() => ({ opacity: reduceMotion ? 1 : progress.value }));

    if (phase === 'closed') return null;

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {/* Backdrop: always tappable, even mid-morph or mid-stream */}
            <Animated.View
                style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, backdropStyle]}
            >
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
                    { top: panelTop, left: PANEL_INSET, right: PANEL_INSET, borderColor: colors.line },
                    panelStyle,
                ]}
            >
                <ModalMaterial />
                {/* The header arrives WITH the panel, on the panel's own morph.
                    A separate reveal after the morph settled made it pop in
                    220ms after the body (audit F10). */}
                <View style={[styles.header, { borderBottomColor: colors.line }]}>
                    {/* Grab zone (avatar slot + title): pans down to close.
                        Kept off the buttons so a swipe never eats a tap. The
                        slot is empty: the riding mark sits over it. */}
                    <GestureDetector gesture={swipeDownGesture}>
                        <View style={styles.headerGrab}>
                            <View style={styles.avatarSlot} />
                            <Text style={[styles.title, { color: colors.ink }]}>{t('floatingChat.title')}</Text>
                        </View>
                    </GestureDetector>
                    {/* Real 44pt frames (ux2 batch 26): a childless labelled
                        Pressable sized by NUMBER with the icon laid over it, or
                        the icon surfaces as its own StaticText. */}
                    <GlyphSafeIconButton
                        onPress={onNewChatPress}
                        accessibilityLabel={t('floatingChat.newChat')}
                        testID="chat-header-new-chat"
                    >
                        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="add-comment" size={22} color={colors.ink} />
                    </GlyphSafeIconButton>
                    <GlyphSafeIconButton
                        onPress={onClosePress}
                        accessibilityLabel={t('floatingChat.close')}
                        testID="chat-header-close"
                    >
                        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="close" size={22} color={colors.ink} />
                    </GlyphSafeIconButton>
                </View>

                {/* The panel itself shrinks above the keyboard (see panelStyle), so
                    no KeyboardAvoidingView is needed: it couldn't measure
                    reliably inside the morph transform. */}
                <View style={styles.body}>
                    <PopoverPhaseContext.Provider value={phase}>{children}</PopoverPhaseContext.Provider>
                </View>
            </Animated.View>

            {/* The riding mark, above the panel, never a touch target. */}
            <Animated.View
                pointerEvents="none"
                {...DECORATIVE_ICON_A11Y}
                style={[styles.rider, riderStyle]}
                testID="chat-riding-mark"
            >
                <Animated.View style={[styles.riderDisc, { backgroundColor: colors.ink }, discStyle]}>
                    <MeraLogo size={BUTTON_LOGO} color={colors.base} animated />
                </Animated.View>
                <Animated.View style={[styles.riderDisc, lightMarkStyle]}>
                    <MeraLogo size={BUTTON_LOGO} color={colors.ink} animated />
                </Animated.View>
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    panel: {
        position: 'absolute',
        borderRadius: 24,
        borderWidth: 1,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingTop: HEADER_PAD_TOP,
        paddingBottom: 10,
        paddingLeft: HEADER_PAD_LEFT,
        paddingRight: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        zIndex: 2, // keep header (and its tappable X) above the body content
    },
    headerGrab: {
        flex: 1,
        height: HEADER_ROW,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    avatarSlot: { width: AVATAR, height: AVATAR },
    title: {
        flex: 1,
        fontSize: 17,
        fontWeight: '600',
    },
    body: {
        flex: 1,
    },
    rider: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: MERA_BUTTON_SIZE,
        height: MERA_BUTTON_SIZE,
    },
    riderDisc: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: MERA_BUTTON_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default ChatPopover;
