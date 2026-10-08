import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AccessibilityInfo,
    Modal,
    Pressable,
    StyleSheet,
    View,
    findNodeHandle,
    useWindowDimensions,
    type LayoutChangeEvent,
} from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

import ModalMaterial from '@/components/custom/ModalMaterial';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { EASE, MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export interface HelpModalProps {
    open: boolean;
    /** The X, a scrim tap or Android back. The parent sets `open` to false. */
    onClose: () => void;
    /** The card is fully gone: open what the help pointed to here. */
    onClosed?: () => void;
    title: string;
    children: React.ReactNode;
    testID?: string;
}

const CARD_MAX_WIDTH = 400;
const SIDE_GAP = 16;
const MAX_HEIGHT_FRACTION = 0.7;
const CLOSE_FRAME = 44;

/**
 * Help for a "?": a centred card on the modal material. It opens and closes
 * with the small-modal motion (FinalMotion, `MOTION.smallModal`): a fade from
 * 96% scale in, a fade to 98% out, the scrim fading with it; Reduce Motion
 * fades only. Width min(W − 32, 400), at most 70% of the screen tall with the
 * body scrolling. The X, a scrim tap and Android back close it; focus moves
 * into the card on open.
 */
export function HelpModal({ open, onClose, onClosed, title, children, testID }: HelpModalProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const { width: W, height: H } = useWindowDimensions();
    const cardWidth = Math.min(W - 2 * SIDE_GAP, CARD_MAX_WIDTH);

    const [shown, setShown] = useState(open);
    const [cardHeight, setCardHeight] = useState(0);
    const progress = useSharedValue(0);
    // Closing settles to 98%, opening starts from 96% (the board's two scales).
    const closing = useSharedValue(0);
    const rose = useRef(false);
    const titleRef = useRef<React.ElementRef<typeof Text>>(null);
    const onClosedRef = useRef(onClosed);
    onClosedRef.current = onClosed;

    const focusTitle = useCallback(() => {
        const tag = findNodeHandle(titleRef.current);
        if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, []);

    const finish = useCallback(() => {
        setShown(false);
        setCardHeight(0);
        onClosedRef.current?.();
    }, []);

    // In: once shown and the card has its height.
    useLayoutEffect(() => {
        if (!open) return;
        setShown(true);
        if (cardHeight === 0 || rose.current) return;
        rose.current = true;
        closing.value = 0;
        progress.value = withTiming(1, { duration: MOTION.smallModal.in, easing: EASE.arrive }, (done) => {
            if (done) runOnJS(focusTitle)();
        });
    }, [open, cardHeight, closing, progress, focusTitle]);

    // Out: only when `open` turns false.
    useEffect(() => {
        if (open) return;
        if (!rose.current) {
            if (shown) finish();
            return;
        }
        rose.current = false;
        closing.value = 1;
        progress.value = withTiming(0, { duration: MOTION.smallModal.out, easing: EASE.leave }, (done) => {
            if (done) runOnJS(finish)();
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    const cardStyle = useAnimatedStyle(() => {
        if (reduceMotion) return { opacity: progress.value };
        const from = closing.value ? MOTION.smallModal.toScale : MOTION.smallModal.fromScale;
        return { opacity: progress.value, transform: [{ scale: from + (1 - from) * progress.value }] };
    });

    const onCardLayout = (e: LayoutChangeEvent) => {
        if (cardHeight === 0) setCardHeight(e.nativeEvent.layout.height);
    };

    return (
        <Modal visible={shown} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
            <View style={styles.fill}>
                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]} />
                <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('tutorials.close')}
                    testID={testID ? `${testID}-scrim` : undefined}
                />
                <Animated.View
                    testID={testID}
                    accessibilityViewIsModal
                    onLayout={onCardLayout}
                    style={[
                        styles.card,
                        { width: cardWidth, maxHeight: H * MAX_HEIGHT_FRACTION, borderColor: colors.line },
                        cardStyle,
                    ]}
                >
                    <ModalMaterial />
                    <View style={styles.header}>
                        <Text ref={titleRef} accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                            {title}
                        </Text>
                        <Pressable
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel={t('tutorials.close')}
                            style={styles.close}
                            testID={testID ? `${testID}-x` : undefined}
                        >
                            <MaterialIcons name="close" size={22} color={colors.ink2} />
                        </Pressable>
                    </View>
                    <ScrollView style={styles.scroll} contentContainerStyle={styles.body} bounces={false}>
                        {children}
                    </ScrollView>
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    // The dialog surface (ModalContent): 16pt corners, a 1pt edge, the material behind.
    card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 20, paddingLeft: 24, paddingRight: 8 },
    title: { flex: 1, fontSize: 20, lineHeight: 26, fontWeight: '700', paddingTop: 9 },
    close: { width: CLOSE_FRAME, height: CLOSE_FRAME, alignItems: 'center', justifyContent: 'center' },
    scroll: { flexGrow: 0 },
    body: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 },
});
