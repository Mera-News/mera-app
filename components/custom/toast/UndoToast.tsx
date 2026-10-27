import { Undo } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { EASE_SETTLE, REDUCED_FADE, TOAST_MOTION } from './deck-motion';
import { useMotionAllowed } from '@/lib/motion-gate';
import MeraToast from './MeraToast';

/**
 * THE UNDO TOAST: every "done, with Undo" confirmation (the feedback leaf's
 * "Got it: feed updated", the ••• menu's "Fewer from <source>"). A success
 * MeraToast with one Undo action: inline when there is only a title, a pill
 * under the text when there is a body. Show it through
 * `toastManager.showUndoToast`, never hand-built.
 *
 * Undo swaps the content IN PLACE to `undoneTitle` ("Change undone"), which the
 * manager holds for 1.4 s before the card leaves. `onUndo` resolves whether to
 * swap (false: the undo was refused, or there is no undone title, and the card
 * has already been closed). `undone` is the manager's record of a swap, so a
 * fresh mount of the same card (the deck's exit clone) keeps the swapped face.
 */
export interface UndoToastProps {
    title: string;
    body?: string;
    undoLabel: string;
    undoneTitle?: string;
    /** Required: a reusable primitive carries no default testID. */
    undoTestID: string;
    undone?: boolean;
    onUndo: () => Promise<boolean>;
}

export default function UndoToast({ title, body, undoLabel, undoneTitle, undoTestID, undone = false, onUndo }: UndoToastProps) {
    const [swapped, setSwapped] = useState(undone);
    if ((swapped || undone) && undoneTitle) {
        return (
            // A fresh mount of an already-swapped card (the exit clone) shows it still.
            <SwapIn still={undone}>
                <MeraToast tone="neutral" icon={Undo} title={undoneTitle} />
            </SwapIn>
        );
    }
    return (
        <MeraToast
            tone="success"
            title={title}
            body={body}
            actions={[
                {
                    label: undoLabel,
                    testID: undoTestID,
                    onPress: () => {
                        void onUndo().then((swap) => {
                            if (swap) setSwapped(true);
                        });
                    },
                },
            ]}
        />
    );
}

/** The undone face swapping in place: up from 4pt and in over 220 ms (Motion board); a 180 ms fade when reduced. */
function SwapIn({ still, children }: { still: boolean; children: React.ReactNode }) {
    const reduced = !useMotionAllowed();
    const opacity = useSharedValue(still ? 1 : 0);
    const translateY = useSharedValue(0);
    useEffect(() => {
        if (still) return;
        if (reduced) {
            opacity.value = withTiming(1, REDUCED_FADE);
            return;
        }
        const settle = { duration: TOAST_MOTION.swap.ms, easing: EASE_SETTLE };
        translateY.value = TOAST_MOTION.swap.fromY;
        translateY.value = withTiming(0, settle);
        opacity.value = withTiming(1, settle);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, []);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: translateY.value }] }));
    return <Animated.View style={style}>{children}</Animated.View>;
}
