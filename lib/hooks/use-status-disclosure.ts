// Open/closed state for a tap-to-reveal status panel.
//
// Two callers, two different contracts, one hook:
//   • The Feed passes `autoCollapseMs` — the panel shows what you asked for and
//     then gets out of the way on its own. The Feed is a reading surface, and a
//     status panel left open on it is the ambient chrome this screen exists to
//     not have.
//   • The Dashboard passes nothing — the panel is sticky, tap to close, which is
//     how its accordion has always behaved. The Dashboard is where you go to
//     look at the numbers, so it lets you keep looking.
//
// `available` is the affordance's own visibility. Without it there is a state
// with no way out: the pipeline goes idle while the panel is open, the indicator
// that opened it unmounts, and the panel is stranded on screen with nothing left
// to tap. That is not hypothetical — on the Feed the indicator disappears at the
// end of every single sync.
//
// No refs and no manual clearing: the timer is armed by an effect keyed on
// `expanded`, so React's own cleanup covers unmount, a re-tap, and the panel
// being closed from anywhere else, all through one path.

import { useCallback, useEffect, useState } from 'react';

export interface StatusDisclosure {
    readonly expanded: boolean;
    readonly toggle: () => void;
    readonly collapse: () => void;
}

/**
 * @param available Whether the control that opens this panel is on screen at
 *   all. The panel closes when it goes false.
 * @param autoCollapseMs Close automatically this long after opening. Omit for a
 *   sticky panel that only closes on a second tap.
 */
export function useStatusDisclosure(
    available: boolean,
    autoCollapseMs?: number,
): StatusDisclosure {
    const [expanded, setExpanded] = useState(false);

    const toggle = useCallback(() => setExpanded((v) => !v), []);
    const collapse = useCallback(() => setExpanded(false), []);

    useEffect(() => {
        if (!expanded || autoCollapseMs == null) return;
        const id = setTimeout(() => setExpanded(false), autoCollapseMs);
        return () => clearTimeout(id);
    }, [expanded, autoCollapseMs]);

    useEffect(() => {
        if (!available) setExpanded(false);
    }, [available]);

    return { expanded, toggle, collapse };
}
