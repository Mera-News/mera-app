import { useIsFocused } from '@react-navigation/native';
import React, { useEffect, useRef, useState } from 'react';
import { Freeze } from 'react-freeze';

/** Grace period before freezing on blur — avoids a freeze/unfreeze flicker
 * during a quick tab-switch-and-back, and gives in-flight blur animations a
 * moment to settle before the subtree stops re-rendering. */
const BLUR_FREEZE_GRACE_MS = 300;

interface FocusFreezeProps {
    children: React.ReactNode;
    /**
     * Overrides the focus state instead of reading it from `useIsFocused()`.
     * `useIsFocused()` throws when rendered outside a navigator (e.g. a bare
     * `render()` in a component test), so tests can pass this instead of
     * standing up a full navigation container. Screens should leave this
     * undefined in production so focus tracks the real navigator state.
     */
    focused?: boolean;
}

/**
 * Wraps a tab screen's content so it stops re-rendering once the tab has
 * been blurred for a short grace period, and resumes re-rendering the
 * instant it regains focus. Intended to be placed at the top of a screen
 * component's render, inside any providers, so the frozen subtree is just
 * the UI.
 *
 * IMPORTANT: `Freeze` (react-freeze) only pauses React re-renders of the
 * frozen subtree — it does NOT pause effects, timers, intervals, or
 * subscriptions still running inside it (e.g. a WatermelonDB `.observe()`
 * subscription, a `setInterval`). Those keep firing even while frozen and
 * must be focus-gated separately by the screen itself (e.g. via
 * `useFocusEffect`) — FocusFreeze only addresses render/reconciliation cost.
 */
const FocusFreeze: React.FC<FocusFreezeProps> = ({ children, focused }) => {
    const hasOverride = focused !== undefined;
    // `useIsFocused` is only skipped when a `focused` override is supplied,
    // which is a testability escape hatch — real screens never pass it, so
    // for any given mounted instance this call is effectively unconditional.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const navigationFocused = hasOverride ? false : useIsFocused();
    const isFocused = hasOverride ? (focused as boolean) : navigationFocused;

    const [frozen, setFrozen] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (isFocused) {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
            setFrozen(false);
            return;
        }

        timeoutRef.current = setTimeout(() => {
            setFrozen(true);
            timeoutRef.current = null;
        }, BLUR_FREEZE_GRACE_MS);

        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, [isFocused]);

    return (
        <Freeze freeze={frozen} placeholder={null}>
            {children}
        </Freeze>
    );
};

export default FocusFreeze;
