import type { PressableStateCallbackType, ViewStyle } from 'react-native';

/** Opacity multiplier while a card or row is held down. */
export const PRESSED_OPACITY = 0.7;
/** Opacity of a card carrying a recorded verdict (existing treatment). */
export const DIMMED_OPACITY = 0.75;

/**
 * Pressed feedback for a CARD or ROW, opt-in per surface.
 *
 * Deliberately NOT a default on the shared `components/ui/pressable`: a list
 * row that dims the moment a finger lands flashes on every scroll that starts
 * on it, and read cards already carry their own inline opacity. So only the
 * card bases and list rows opt in, through this one helper, and the two
 * treatments multiply rather than overwrite: a dimmed card still visibly
 * reacts when pressed (0.75 x 0.7).
 */
export function cardPressStyle(
    dimmed: boolean = false,
): (state: PressableStateCallbackType) => ViewStyle | undefined {
    return ({ pressed }) => {
        const base = dimmed ? DIMMED_OPACITY : 1;
        const opacity = pressed ? base * PRESSED_OPACITY : base;
        return opacity === 1 ? undefined : { opacity };
    };
}
