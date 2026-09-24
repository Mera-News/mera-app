import { DIMMED_OPACITY, PRESSED_OPACITY } from '@/components/custom/cards/press-style';
import { Pressable } from '@/components/ui/pressable';
import React, { useCallback, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';

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
 */
const PressableCard = React.forwardRef<React.ComponentRef<typeof Pressable>, PressableCardProps>(
    function PressableCard({ dimmed = false, onPressIn, onPressOut, ...rest }, ref) {
        const [pressed, setPressed] = useState(false);
        const handleIn = useCallback(
            (e: GestureResponderEvent) => {
                setPressed(true);
                onPressIn?.(e);
            },
            [onPressIn],
        );
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
                onPressIn={handleIn}
                onPressOut={handleOut}
                style={opacity === 1 ? undefined : { opacity }}
            />
        );
    },
);

export default PressableCard;
