import { DIMMED_OPACITY, PRESSED_OPACITY } from '@/components/custom/cards/press-style';
import { Pressable } from '@/components/ui/pressable';
import React, { useCallback, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { useTapGuard } from './use-tap-guard';

type PressableProps = React.ComponentProps<typeof Pressable>;

export interface PressableCardProps extends Omit<PressableProps, 'style'> {
    /** The recorded-verdict treatment (0.75), multiplied by the pressed one. */
    dimmed?: boolean;
}

/**
 * A card or row that visibly reacts while held (pressed state is OPT-IN, see
 * press-style.ts). The pressed state is tracked in React and applied as a
 * STATIC style: a function `style={({ pressed }) => ...}` on a Pressable is
 * dropped on device in this app (the css-interop wrapper), which silently
 * removed both the pressed feedback and the dimmed treatment of read cards.
 *
 * It opens on a TAP only (`useTapGuard`): a release after a sideways drag is
 * not a press, or the tab swipe and any stray drag opened the article.
 */
const PressableCard = React.forwardRef<React.ComponentRef<typeof Pressable>, PressableCardProps>(
    function PressableCard({ dimmed = false, onPressIn, onPressOut, onPress, ...rest }, ref) {
        const [pressed, setPressed] = useState(false);
        const markIn = useCallback(
            (e: GestureResponderEvent) => {
                setPressed(true);
                onPressIn?.(e);
            },
            [onPressIn],
        );
        const tap = useTapGuard(onPress, markIn);
        const handleOut = useCallback(
            (e: GestureResponderEvent) => {
                setPressed(false);
                onPressOut?.(e);
            },
            [onPressOut],
        );
        const base = dimmed ? DIMMED_OPACITY : 1;
        const opacity = pressed ? base * PRESSED_OPACITY : base;
        return (
            <Pressable
                ref={ref}
                {...rest}
                onPress={tap.onPress}
                onPressIn={tap.onPressIn}
                onPressOut={handleOut}
                style={opacity === 1 ? undefined : { opacity }}
            />
        );
    },
);

export default PressableCard;
