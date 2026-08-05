// Resolves the Mera News Free script to real, translated strings — reading the
// on-device counts that decide which state-gated lines are TRUE.
//
// The DB services are `import()`ed lazily rather than imported at module scope
// on purpose: `MeraChatInvite` (Profile) is one of the two consumers and has no
// database in its dependency graph today. A static import here would drag the
// WatermelonDB SQLite adapter into it — the same native-JSI-at-import-time trap
// that already wedges three unrelated test suites in this repo.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    freeTierLineKeys,
    UNCONDITIONAL_LINE_KEYS,
    type FreeTierLineState,
} from './free-tier-lines';

/** Nothing known yet. Yields only the unconditional lines — see the note in
 *  `free-tier-lines.ts` about failing towards silence, never towards a lie. */
const UNKNOWN_STATE: FreeTierLineState = { savedCount: 0, trackedCount: 0 };

/**
 * Read both counts. Never throws: a failure leaves the count at 0, which drops
 * the corresponding line rather than asserting something unverified.
 */
async function readState(): Promise<FreeTierLineState> {
    const [savedCount, trackedCount] = await Promise.all([
        import('@/lib/database/services/saved-article-suggestion-service')
            .then((m) => m.countSavedItems())
            .catch(() => 0),
        import('@/lib/database/services/tracked-story-service')
            .then((m) => m.countActive())
            .catch(() => 0),
    ]);
    return { savedCount, trackedCount };
}

/**
 * The translated lines Mera may truthfully say on Mera News Free.
 *
 * @param enabled pass `false` when the caller will not render the lines (an
 *   entitled user), so the counts are never read at all.
 *
 * Counts are read ONCE per mount, not observed. That is deliberate: the only
 * drift a stale count can produce is a true line appearing one mount late (the
 * user saved their first article while this card was already on screen), which
 * is the harmless direction. Observing both tables to catch it would put two
 * live subscriptions behind a list header for a line of prose.
 */
export function useFreeTierLines(enabled = true): string[] {
    const { t } = useTranslation();
    const [state, setState] = useState<FreeTierLineState>(UNKNOWN_STATE);

    useEffect(() => {
        // `enabled` is not a nicety. Both consumers must call this hook
        // unconditionally (rules of hooks) but render nothing unless the device
        // is locked — and `FreeTierCard` is mounted on BOTH the Feed and the
        // Dashboard for every user, entitled ones included. Without this, every
        // paying user pays two COUNT queries per mount for lines that are never
        // shown.
        if (!enabled) return;
        let cancelled = false;
        void readState().then((s) => {
            if (!cancelled) setState(s);
        });
        return () => {
            cancelled = true;
        };
    }, [enabled]);

    const keys = freeTierLineKeys(state);
    // Cast: these are literal keys the typed `t` cannot narrow from a string[].
    return keys.map((k) => (t as unknown as (key: string) => string)(k));
}

/** Exported for tests and for any caller that must not touch the database. */
export { UNCONDITIONAL_LINE_KEYS };
