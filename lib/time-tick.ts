// time-tick — ONE shared, coarse clock for every relative-age label in the app.
//
// THE BUG THIS EXISTS FOR: `formatTimeAgo` is a pure function of (timestamp,
// now), so a rendered "37m ago" is only ever as fresh as the render that
// produced it. Every card that shows an age sits under a `React.memo` boundary
// (ArticleCardBase / ArticleCompactCardBase / ArticleSuggestionCard /
// ArticleSuggestionCompactCard) fed a view-model that does not change once the
// row is in the list — so the row never re-renders and the age string freezes
// at whatever it was when the card first painted. Two rows of the SAME article
// rendered minutes apart therefore disagreed ("1h ago" here, "2h ago" one tap
// away).
//
// THE SHAPE OF THE FIX: a module-level `useSyncExternalStore` source with ONE
// interval for the whole app (never a timer per card — dozens of cards each
// running their own `setInterval` is exactly the failure mode this avoids).
// `ArticleMetaRow` — the single leaf that renders an age, BELOW every memo
// boundary — subscribes. A component's own store subscription re-renders that
// component regardless of any ancestor's memo, and the update never travels
// upward, so no parent (and no ordering snapshot derived in a parent) can see
// a tick. See lib/visibility-tick.ts for the same tiny-shared-notifier style.
//
// LIFECYCLE: the interval is armed lazily on the FIRST subscriber and torn
// down with the LAST one, so nothing ticks when no age is mounted. An AppState
// listener (added/removed on the same edges) stops the interval while the app
// is backgrounded and, on return to `active`, snaps the clock forward
// immediately rather than waiting out the remainder of a tick.

import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

type Listener = () => void;

/**
 * How often the shared clock advances. Deliberately coarse: the finest
 * granularity any age label has is one minute (`feed.minutesAgo`), so ticking
 * faster only buys re-renders, never a different string.
 */
export const TIME_TICK_MS = 60_000;

const listeners = new Set<Listener>();

/** The published snapshot: the clock reading as of the last tick. It is a
 *  stored value, NOT a live `Date.now()` — `useSyncExternalStore` requires a
 *  snapshot that is stable between a render and its commit, and a live clock
 *  would return a new value on every call and re-render forever. */
let tickNow = Date.now();

let interval: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;

function fire(): void {
    const next = Date.now();
    // Identical readings publish nothing: an unchanged snapshot would make
    // every subscriber re-render for no visible difference.
    if (next === tickNow) return;
    tickNow = next;
    listeners.forEach((fn) => fn());
}

function startInterval(): void {
    if (interval) return;
    interval = setInterval(fire, TIME_TICK_MS);
}

function stopInterval(): void {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
}

function handleAppStateChange(state: AppStateStatus): void {
    if (state !== 'active') {
        // Backgrounded / inactive — nothing is on screen to update.
        stopInterval();
        return;
    }
    // Returning to the foreground. Guard on `listeners.size`: the last age
    // label may have unmounted while we were away, and re-arming a timer with
    // no subscribers is precisely the "runs when nothing is mounted" case.
    if (listeners.size === 0) return;
    fire();
    startInterval();
}

/**
 * Subscribe to the shared clock. Returns an unsubscribe. The first subscriber
 * arms the interval + the AppState listener; the last one to leave tears both
 * down.
 */
export function subscribeTimeTick(listener: Listener): () => void {
    const wasDormant = listeners.size === 0;
    listeners.add(listener);
    if (wasDormant) {
        // Waking from dormancy: `tickNow` is as stale as the moment the last
        // subscriber left. Refresh it here rather than notifying — React
        // re-reads `getSnapshot` right after subscribing and re-renders if it
        // moved, which is the whole point.
        tickNow = Date.now();
        appStateSub = AppState.addEventListener('change', handleAppStateChange);
        // Asymmetric on purpose: the STOP path treats anything non-`active` as
        // "don't tick" (conservative), while the START path only refuses on a
        // real `background`. iOS reports `inactive` for transients like the
        // app switcher or a system alert, where content is still on screen —
        // arming there costs one timer and avoids mounting into a dead clock.
        if (AppState.currentState !== 'background') startInterval();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopInterval();
        appStateSub?.remove();
        appStateSub = null;
    };
}

/** The current shared clock reading (epoch ms). */
export function getTimeTick(): number {
    return tickNow;
}

/**
 * Advance the shared clock right now and notify every subscriber.
 *
 * Exposed for callers that know the user is looking at ages again sooner than
 * the next tick — e.g. a screen's `useFocusEffect`. Safe to call at any time:
 * with no subscribers it just refreshes the stored reading.
 */
export function notifyTimeTick(): void {
    fire();
}

/**
 * Subscribe a component to the shared clock. Returns the current reading, to
 * be passed as `formatTimeAgo`'s `now`.
 *
 * Call this in the LEAF that renders the age, never in a list/screen parent:
 * subscribing high would re-render (and re-derive) the whole subtree once a
 * minute, and any order that parent computes would be recomputed with it.
 */
export function useTimeTick(): number {
    return useSyncExternalStore(subscribeTimeTick, getTimeTick, getTimeTick);
}

/** Test-only: drop every subscriber + timer so each spec starts dormant. */
export function __resetTimeTickForTests(): void {
    listeners.clear();
    stopInterval();
    appStateSub?.remove();
    appStateSub = null;
    tickNow = Date.now();
}
