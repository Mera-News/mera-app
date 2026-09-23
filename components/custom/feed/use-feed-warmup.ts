import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Show nothing for this long first: a cache that loads fast never flashes a
 *  skeleton. */
export const SKELETON_DELAY_MS = 200;
/** Safety cap only: stop waiting for the local read after this long, so a read
 *  that hangs can never leave the skeleton up for good. The real signal is
 *  `suggestionsHydrated`. It was a 3s guess, and a cold launch whose local read
 *  took ~13s showed "all caught up" for the gap before the cards arrived. */
export const CANDIDATES_WAIT_MS = 20_000;

export interface FeedWarmupInput {
    /** The persisted order store has hydrated (true even when hydrate failed). */
    orderHydrated: boolean;
    /** The opened-stories store has hydrated. */
    openedHydrated: boolean;
    /** How many local candidates the store holds right now. */
    candidateCount: number;
    /** Rows the list would render right now. */
    renderedCount: number;
    /** The ingest effect has run at least once with candidates in hand. */
    ingested: boolean;
    /** The first local read of suggestions has finished (for-you-store). */
    suggestionsHydrated: boolean;
    /** Text announced once to a screen reader when the skeleton appears. */
    announcement: string;
}

export type FeedWarmupPhase = 'blank' | 'skeleton' | 'ready';

/**
 * Whether the Feed is still warming up on launch, and what to draw meanwhile.
 *
 * WARMING means the list is empty because the local cache has not loaded yet,
 * not because there is nothing to show. The empty-state chain ("preparing your
 * feed", "all caught up") must never render during that window.
 *
 * It resolves on real signals, never on order length alone (persisted ids
 * whose items aged out would keep it forever):
 *  - both stores hydrated (they report hydrated even when hydrate fails), and
 *  - candidates loaded: the local read has FINISHED and, if it found any,
 *    ingest has run. A genuinely empty database resolves the moment its read
 *    returns; CANDIDATES_WAIT_MS is only the cap for a read that never does.
 * Once any row renders, it is ready for good.
 */
export function useFeedWarmup(input: FeedWarmupInput): FeedWarmupPhase {
    const { orderHydrated, openedHydrated, candidateCount, renderedCount, ingested, suggestionsHydrated, announcement } =
        input;

    const [waitedOut, setWaitedOut] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setWaitedOut(true), CANDIDATES_WAIT_MS);
        return () => clearTimeout(timer);
    }, []);

    const [delayPassed, setDelayPassed] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setDelayPassed(true), SKELETON_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);

    const everReady = useRef(false);
    const candidatesLoaded = (suggestionsHydrated && (candidateCount === 0 || ingested)) || waitedOut;
    const warming =
        !everReady.current &&
        renderedCount === 0 &&
        (!orderHydrated || !openedHydrated || !candidatesLoaded);
    if (!warming) everReady.current = true;

    const phase: FeedWarmupPhase = !warming ? 'ready' : delayPassed ? 'skeleton' : 'blank';

    const announced = useRef(false);
    useEffect(() => {
        if (phase !== 'skeleton' || announced.current) return;
        announced.current = true;
        AccessibilityInfo.announceForAccessibility(announcement);
    }, [phase, announcement]);

    return phase;
}
