// Open/closed state for a tap-to-reveal status panel.
//
// Both callers pass `autoCollapseMs` = STATUS_PANEL_AUTO_COLLAPSE_MS
// (for-you/FeedStatusPanel.tsx): the Feed's header panel and the Dashboard's
// Overview stats card open the same body and close it the same way. Omitting
// it gives a sticky panel that only closes on a second tap; no caller does.
//
// `available` is the affordance's own visibility: the panel closes when it
// goes false, so an open panel is never stranded after the control that opened
// it unmounts. Both current callers pass `true`: the Feed's Mera mark is on
// screen in every state, and the Dashboard's stats card always renders (its
// dropdown closes on a tab switch through its own blur effect). Kept for a
// caller whose trigger CAN disappear.
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
