import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import ModalMaterial from '@/components/custom/ModalMaterial';
import { hapticLight } from '@/lib/haptics';
import { EASE, MOTION, SPRING } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export interface BottomSheetProps {
    /** Showing. Set false (from `onClose`) to slide it away. */
    open: boolean;
    /** Scrim tap, a drag down past the threshold, or hardware back. The parent
     *  sets `open` to false; the sheet never closes itself. */
    onClose: () => void;
    /** The sheet is fully gone (iOS: the Modal's onDismiss; Android: the
     *  slide-down ended). Present native UI (share, browser, Intercom) here,
     *  never on a timer: iOS refuses to present over a Modal still leaving. */
    onClosed?: () => void;
    children: React.ReactNode;
    testID?: string;
    /** The scrim's screen-reader label. Defaults to Cancel. */
    scrimLabel?: string;
}

const SHEET_INSET = 8;
const SHEET_RADIUS = 28;

/** Drag this far, or flick this fast, to dismiss. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
/** If the Modal never reports onShow, rise anyway this long after layout. */
const PRESENT_FALLBACK_MS = 150;

/**
 * The ONE bottom sheet (FinalMotion "Sheets"): an RN Modal over the tab bar,
 * the 78% scrim, the ModalMaterial surface with a grab handle. Rises 320 ms
 * ease-out, leaves 220 ms; drag down to dismiss; Reduce Motion fades in place.
 *
 * The rise waits until the sheet can be SEEN (the Modal presented AND the sheet
 * laid out). Started earlier it ran behind a Modal not yet on screen, and the
 * reader saw a dark scrim with the sheet already most of the way up. The Modal
 * stays shown until the slide-down ends, so `onClosed` is a real "gone".
 *
 * Content does not scroll for you: wrap a long body in a ScrollView with a
 * max height.
 */
export function BottomSheet({ open, onClose, onClosed, children, testID, scrimLabel }: BottomSheetProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const reduceMotion = useReducedMotion();

    const [shown, setShown] = useState(open);
    const [presented, setPresented] = useState(false);
    const [laidOut, setLaidOut] = useState(false);
    const progress = useSharedValue(0);
    const drag = useSharedValue(0);
    const rose = useRef(false);
    const onClosedRef = useRef(onClosed);
    onClosedRef.current = onClosed;

    useEffect(() => {
        if (!open || presented || !laidOut) return;
        const id = setTimeout(() => setPresented(true), PRESENT_FALLBACK_MS);
        return () => clearTimeout(id);
    }, [open, presented, laidOut]);

    // Rise once shown and visible.
    useLayoutEffect(() => {
        if (!open) return;
        setShown(true);
        if (!presented || !laidOut) return;
        rose.current = true;
        drag.value = 0;
        progress.value = withTiming(1, {
            duration: reduceMotion ? MOTION.sheet.reduce : MOTION.sheet.open,
            easing: EASE.arrive,
        });
        void hapticLight();
    }, [open, presented, laidOut, reduceMotion, progress, drag]);

    const finish = useCallback(() => {
        setShown(false);
        setPresented(false);
        setLaidOut(false);
        // iOS reports the real dismissal through Modal.onDismiss.
        if (Platform.OS !== 'ios') onClosedRef.current?.();
    }, []);

    // Fall: only when `open` itself turns false.
    useLayoutEffect(() => {
        if (open) return;
        if (!rose.current) {
            if (shown) finish();
            return;
        }
        rose.current = false;
        progress.value = withTiming(
            0,
            { duration: reduceMotion ? MOTION.sheet.reduce : MOTION.sheet.close, easing: EASE.across },
            (finished) => {
                if (finished) runOnJS(finish)();
            },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const pan = Gesture.Pan()
        .enabled(open)
        .activeOffsetY(10)
        .failOffsetX([-20, 20])
        .onUpdate((e) => {
            drag.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
            if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
                runOnJS(onClose)();
                return;
            }
            drag.value = withSpring(0, SPRING.settle);
        });

    const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    const sheetStyle = useAnimatedStyle(() =>
        reduceMotion
            ? { opacity: laidOut ? progress.value : 0 }
            : {
                  opacity: laidOut ? 1 : 0,
                  transform: [{ translateY: (1 - progress.value) * windowHeight + drag.value }],
              },
    );

    return (
        <Modal
            visible={shown}
            transparent
            animationType="none"
            statusBarTranslucent
            onShow={() => setPresented(true)}
            onDismiss={() => onClosedRef.current?.()}
            onRequestClose={onClose}
        >
            <GestureHandlerRootView style={styles.fill}>
                <Animated.View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]}
                />
                <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={scrimLabel ?? t('common.cancel')}
                    testID={testID ? `${testID}-scrim` : undefined}
                />
                <GestureDetector gesture={pan}>
                    {/* Two layers: the outer one casts the shadow (a view that
                        clips drops its shadow), the inner one clips the material
                        to the 28pt corners. */}
                    <Animated.View
                        testID={testID}
                        accessibilityViewIsModal
                        onLayout={() => setLaidOut(true)}
                        style={[styles.sheet, { marginBottom: SHEET_INSET }, sheetStyle]}
                    >
                        <View style={[styles.sheetClip, { borderColor: colors.line }]}>
                            <ModalMaterial />
                            <View style={styles.handleRow}>
                                <View style={[styles.handle, { backgroundColor: colors.ink3 }]} />
                            </View>
                            <View style={{ paddingBottom: Math.max(insets.bottom - SHEET_INSET, 0) + 12 }}>{children}</View>
                        </View>
                    </Animated.View>
                </GestureDetector>
            </GestureHandlerRootView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1, justifyContent: 'flex-end' },
    // Modals #1 / FinalWorld #7: 8pt from the sides and the bottom, 28pt
    // corners all round, a 1pt edge and a soft drop shadow.
    sheet: {
        marginHorizontal: SHEET_INSET,
        borderRadius: SHEET_RADIUS,
        shadowColor: '#000',
        shadowOpacity: 0.6,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 18 },
        elevation: 16,
    },
    sheetClip: {
        borderRadius: SHEET_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
    },
    handleRow: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
    handle: { width: 36, height: 5, borderRadius: 3 },
});
