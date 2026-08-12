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
// `available` is the affordance's own visibility, and BOTH CURRENT CALLERS PASS
// `true`. It exists for a state that no longer occurs here: an affordance that
// unmounts while its panel is open leaves the panel stranded with nothing left
// to tap. That used to happen on the Feed at the end of every sync, back when
// the status indicator rendered nothing in idle. The indicator is now the Mera
// mark and is on screen in every mode, so passing anything but `true` would do
// the opposite of the original job — yank an open panel shut the moment the
// pipeline settled.
//
// Kept as a parameter rather than deleted because it is the correct guard for
// any future caller whose trigger CAN disappear, and because the behaviour is
// covered by tests either way. Do not re-wire it to the pipeline state.
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
