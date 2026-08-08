// ─────────────────────────────────────────────────────────────────────────────
// The translation scheduler
// ─────────────────────────────────────────────────────────────────────────────
//
// THE PROBLEM THIS REPLACES. `lib/translation-service` used to chain every
// native call onto one process-global promise:
//
//     let queue: Promise<void> = Promise.resolve();
//     const promise = queue.then(async () => { ...native call... });
//     queue = promise.then(() => {}, () => {});
//
// Strict FIFO, concurrency 1, no cancellation, no priority, and — the part the
// user actually feels — NO DEQUEUE. Scrolling the Feed enqueues one call per
// visible title; opening a story then enqueues that screen's title BEHIND all
// of them. Nothing is dropped and nothing is re-ordered, so the screen the user
// is looking at waits on N titles they have already scrolled past. With the 20s
// per-call ceiling and a `[200, 600, 1800]` retry ladder, one bad string can
// hold the head of that line for seconds of pure sleeping.
//
// WHAT THIS FIXES, and what it deliberately does not.
//
//  1. ROUTE EPOCH — the highest-value change, and free. Native translation
//     cannot be cancelled (`onTranslateTask` exposes no abort), so a call that
//     has STARTED must run to completion. But a call that has not started can
//     simply never be made. Every route change bumps the epoch; queued items
//     stamped with an older epoch are dropped before dispatch. The work the
//     user navigated away from costs nothing.
//
//  2. PRIORITY — items dispatch by (priority asc, enqueue order asc) instead of
//     pure arrival order, so the text nearest the top of the viewport goes
//     first. See {@link visibilityPriority}.
//
//  3. CONCURRENCY stays at ONE. See {@link TRANSLATION_CONCURRENCY}.
//
// A dropped item resolves with {@link DROPPED} — never rejects, never throws.
// Callers MUST distinguish it from a failure: a failure means "the OS could not
// translate this", a drop means "we chose not to ask yet", and a caller that
// conflates them will mark the text permanently un-translatable for the
// session (see TranslatableDynamic's `firedRef`).

import logger from '@/lib/logger';

/**
 * How many native translation calls may be in flight at once.
 *
 * ONE, unchanged from the promise-chain it replaces, and that is a decision
 * rather than an oversight. The serial queue was load-bearing: Apple's
 * Translation framework cancels concurrent translation sessions, which is the
 * exact transient failure the `TRANSLATE_RETRY_DELAYS_MS` ladder in
 * translation-service exists to absorb. Raising this blind would manufacture
 * more of the failures the retry ladder is paying for, and the failures count
 * toward the availability breaker — i.e. the plausible outcome of a blind raise
 * is LESS translation, not faster translation.
 *
 * Raising it needs a measurement on real hardware (the iOS Simulator cannot
 * translate at all — `deviceCanTranslate()` is false there), which is not
 * something the queue can establish for itself. Until that measurement exists,
 * the win here is ORDERING and NON-DISPATCH, not throughput.
 */
export const TRANSLATION_CONCURRENCY = 1;

/** Resolution value for an item dropped before dispatch. Never an error. */
export const DROPPED = Symbol.for('mera.translation.dropped');
export type Dropped = typeof DROPPED;

export function isDropped(value: unknown): value is Dropped {
    return value === DROPPED;
}

/**
 * Priority for the language-availability probe — ahead of everything.
 *
 * The probe is a deliberate user gesture with a spinner on screen waiting for
 * it, and it is the only caller allowed to present Apple's download sheet. It
 * must never sit behind a screenful of headlines.
 */
export const PROBE_PRIORITY = -1_000_000;

/**
 * Turn a node's measured window-space `y` into a queue priority (lower first).
 *
 * Measured y IS visible rank, and it is a better one than a list's item index:
 * it is per-TEXT-NODE rather than per-card (a card's title and its reason are
 * ranked separately, in reading order), it needs no plumbing through the card
 * components, and it works identically on every screen — including Dashboard
 * and Explore, whose lists have no `viewabilityConfigCallbackPairs` at all.
 *
 * Nodes ABOVE the viewport (negative y — scrolled past, still mounted, still
 * inside the visibility buffer) sort behind everything currently on screen, and
 * further above sorts later still. They are the least likely to be read next.
 */
export function visibilityPriority(y: number): number {
    if (!Number.isFinite(y)) return 0;
    return y >= 0 ? y : 100_000 - y;
}

interface PendingItem {
    readonly seq: number;
    /** null ⇒ exempt from epoch drops (the probe). */
    readonly epoch: number | null;
    readonly priority: number;
    readonly label: string;
    readonly run: () => Promise<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
}

export interface TranslationQueueStats {
    readonly epoch: number;
    readonly pending: number;
    readonly inFlight: number;
    readonly enqueued: number;
    readonly dispatched: number;
    readonly completed: number;
    readonly dropped: number;
}

let epoch = 0;
let seqCounter = 0;
let inFlight = 0;
let pending: PendingItem[] = [];

let enqueuedCount = 0;
let dispatchedCount = 0;
let completedCount = 0;
let droppedCount = 0;

const epochListeners = new Set<() => void>();

/** The current route epoch. Items enqueued now carry this stamp. */
export function getTranslationEpoch(): number {
    return epoch;
}

/**
 * Advance the route epoch and DROP every queued item from an older one.
 *
 * Called from `lib/nav-state` on every pathname change — one call covers every
 * screen, exactly like the age-tick it sits beside. Items already dispatched
 * keep running; nothing can stop them.
 */
export function bumpTranslationEpoch(reason?: string): number {
    epoch += 1;
    const survivors: PendingItem[] = [];
    const casualties: PendingItem[] = [];
    for (const item of pending) {
        if (item.epoch !== null && item.epoch < epoch) casualties.push(item);
        else survivors.push(item);
    }
    pending = survivors;
    if (casualties.length > 0) {
        droppedCount += casualties.length;
        logger.debug('[TranslationQueue] Dropped stale items on route change', {
            epoch,
            reason: reason ?? null,
            dropped: casualties.length,
            remaining: pending.length,
        });
        // Resolve AFTER the queue state is consistent — a `.then` handler that
        // re-enqueues must not observe a half-swept queue.
        for (const item of casualties) item.resolve(DROPPED);
    }
    epochListeners.forEach((listener) => listener());
    return epoch;
}

/**
 * Subscribe to epoch changes. Used by render surfaces that need to un-latch a
 * node whose request was dropped, so it can ask again.
 */
export function subscribeTranslationEpoch(listener: () => void): () => void {
    epochListeners.add(listener);
    return () => {
        epochListeners.delete(listener);
    };
}

export interface EnqueueOptions {
    /**
     * Epoch stamp. Omit to use the current epoch (the normal case). Pass `null`
     * to make the item epoch-EXEMPT — the probe does this, because a route
     * change during the language-switch flow (picker modal → dismiss) must not
     * swallow the one call that verifies the language and opens the gate.
     */
    readonly epoch?: number | null;
    /** Lower dispatches sooner. Default 0. */
    readonly priority?: number;
    /** Diagnostic only. */
    readonly label?: string;
}

/** Index of the next item to dispatch: lowest priority, then lowest seq. */
function nextIndex(): number {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
        if (best === -1) {
            best = i;
            continue;
        }
        const a = pending[i];
        const b = pending[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return best;
}

/** Remove and resolve any items left over from an older epoch. */
function sweepStale(): void {
    if (pending.length === 0) return;
    const survivors: PendingItem[] = [];
    const casualties: PendingItem[] = [];
    for (const item of pending) {
        if (item.epoch !== null && item.epoch < epoch) casualties.push(item);
        else survivors.push(item);
    }
    if (casualties.length === 0) return;
    pending = survivors;
    droppedCount += casualties.length;
    for (const item of casualties) item.resolve(DROPPED);
}

function pump(): void {
    while (inFlight < TRANSLATION_CONCURRENCY) {
        // Belt and braces: `bumpTranslationEpoch` already swept, but an item can
        // be enqueued against an epoch that advances before it reaches the head.
        sweepStale();
        const index = nextIndex();
        if (index === -1) return;
        const [item] = pending.splice(index, 1);
        inFlight += 1;
        dispatchedCount += 1;
        logger.debug('[TranslationQueue] Dispatch', {
            label: item.label,
            epoch: item.epoch,
            priority: item.priority,
            pending: pending.length,
        });
        let call: Promise<unknown>;
        try {
            call = Promise.resolve(item.run());
        } catch (err) {
            call = Promise.reject(err);
        }
        call.then(item.resolve, item.reject);
        void call.then(
            () => {},
            () => {},
        ).then(() => {
            inFlight -= 1;
            completedCount += 1;
            logger.debug('[TranslationQueue] Complete', {
                label: item.label,
                epoch: item.epoch,
                pending: pending.length,
            });
            pump();
        });
    }
}

/**
 * Queue one native translation call. Resolves with the task's value, or with
 * {@link DROPPED} if the route moved on before it was ever dispatched.
 */
export function enqueueTranslationTask<T>(
    run: () => Promise<T>,
    options: EnqueueOptions = {},
): Promise<T | Dropped> {
    const itemEpoch = options.epoch === undefined ? epoch : options.epoch;
    const priority = options.priority ?? 0;
    const label = options.label ?? 'translate';

    return new Promise<T | Dropped>((resolve, reject) => {
        seqCounter += 1;
        enqueuedCount += 1;
        pending.push({
            seq: seqCounter,
            epoch: itemEpoch,
            priority,
            label,
            run: run as () => Promise<unknown>,
            resolve: resolve as (value: unknown) => void,
            reject,
        });
        logger.debug('[TranslationQueue] Enqueue', {
            label,
            epoch: itemEpoch,
            priority,
            pending: pending.length,
        });
        pump();
    });
}

export function getTranslationQueueStats(): TranslationQueueStats {
    return {
        epoch,
        pending: pending.length,
        inFlight,
        enqueued: enqueuedCount,
        dispatched: dispatchedCount,
        completed: completedCount,
        dropped: droppedCount,
    };
}

/** Test seam — clears every module-level scheduler state. */
export function __resetTranslationQueueForTests(): void {
    const casualties = pending;
    pending = [];
    epoch = 0;
    seqCounter = 0;
    inFlight = 0;
    enqueuedCount = 0;
    dispatchedCount = 0;
    completedCount = 0;
    droppedCount = 0;
    epochListeners.clear();
    for (const item of casualties) item.resolve(DROPPED);
}
