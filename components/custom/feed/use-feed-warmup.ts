import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Show nothing for this long first: a cache that loads fast never flashes a
 *  skeleton. */
export const SKELETON_DELAY_MS = 200;
/** Give up waiting for local candidates after this long. A genuinely empty
 *  database has none to wait for, and the empty-state chain must take over. */
export const CANDIDATES_WAIT_MS = 3000;

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
 *  - candidates loaded: at least one candidate AND ingest has run, or
 *    CANDIDATES_WAIT_MS passed with none (a genuinely empty database).
 * Once any row renders, it is ready for good.
 */
export function useFeedWarmup(input: FeedWarmupInput): FeedWarmupPhase {
    const { orderHydrated, openedHydrated, candidateCount, renderedCount, ingested, announcement } = input;

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
    const candidatesLoaded = (candidateCount > 0 && ingested) || waitedOut;
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
