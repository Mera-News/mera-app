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
// WHAT IT DOES.
//
//  1. ROUTE EPOCH. Native translation cannot be cancelled (`onTranslateTask`
//     exposes no abort), so a call that has STARTED must run to completion.
//     But a call that has not started can simply never be made. Every route
//     change bumps the epoch; queued items stamped with an older epoch are
//     dropped before dispatch.
//
//  2. VISIBLE FIRST. Each item carries a class (`priority`: the probe's
//     PROBE_PRIORITY beats everything) and a rank ({@link QueueRank}). Within a
//     class: rows on screen before rows that left it; among those, the ones
//     that most recently BECAME visible (the scroll-tick generation, see
//     lib/visibility-tick) first; then top to bottom. A caller re-ranks or
//     cancels its queued item through the {@link TranslationTaskHandle}, so a
//     row that scrolls away stops competing and one that comes back jumps in.
//
//  3. ONE SLOT, HELD UNTIL NATIVE SETTLES. {@link TRANSLATION_CONCURRENCY} is
//     one. A task may return early (the caller's JS timeout) while its native
//     call is still running; it hands that call to `hold`, and the slot stays
//     taken until it settles. Freeing it at the JS timeout let the next call
//     start on top of a live one, and the native module's shared hosting
//     controller answered "The operation was cancelled" (MERA-APP-7G,
//     MERA-APP-15). Every hold has a ceiling, because the vendored Swift can
//     leak its continuation and never settle; a ceiling release is logged.
//
// A dropped or cancelled item resolves with {@link DROPPED}, never rejects.
// Callers MUST distinguish it from a failure: a failure means "the OS could not
// translate this", a drop means "we chose not to ask yet".

import logger from '@/lib/logger';
import { getScrollTickGeneration } from '@/lib/visibility-tick';

/**
 * How many native translation calls may be in flight at once.
 *
 * ONE, and a decision rather than an oversight: Apple's Translation framework
 * cancels concurrent translation sessions, and the native module keeps one
 * shared hosting controller that a second call overwrites. Raising this blind
 * would manufacture "operation was cancelled" failures, which count toward the
 * availability breaker, i.e. the plausible outcome is LESS translation.
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

/** Where a queued row sits on screen right now. */
export interface QueueRank {
    /** On screen (within the visibility buffer). */
    readonly visible: boolean;
    /** Measured window-space y: lower goes first among equally recent rows. */
    readonly y: number;
}

/** What the caller holds on a scheduled task. */
export interface TranslationTaskHandle<T> {
    /** The task's value, or {@link DROPPED} if it never ran. */
    readonly promise: Promise<T | Dropped>;
    /** Re-rank a still-queued task. No effect once dispatched. */
    setPriority(rank: QueueRank): void;
    /** Drop a still-queued task (it resolves DROPPED). False once dispatched:
     *  a native call cannot be stopped. */
    cancel(): boolean;
}

/** Register a native call the slot must wait for, with a ceiling in ms. */
export type HoldSlot = (native: Promise<unknown>, ceilingMs: number) => void;

interface PendingItem {
    readonly seq: number;
    /** null ⇒ exempt from epoch drops (the probe). */
    readonly epoch: number | null;
    /** Class: lower first, before any rank. */
    readonly priority: number;
    visible: boolean;
    y: number;
    /** Scroll-tick generation at which it last BECAME visible. */
    visibleSince: number;
    readonly label: string;
    readonly run: (hold: HoldSlot) => Promise<unknown>;
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
    /** Class, lower dispatches sooner, before any rank. Default 0; the probe
     *  passes {@link PROBE_PRIORITY}. */
    readonly priority?: number;
    /** Where the row is on screen. Default: visible, at the top. */
    readonly rank?: QueueRank;
    /** Diagnostic only. */
    readonly label?: string;
}

/** Negative when `a` should dispatch before `b`. */
function compare(a: PendingItem, b: PendingItem): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    if (a.visible && a.visibleSince !== b.visibleSince) return b.visibleSince - a.visibleSince;
    if (a.y !== b.y) return a.y - b.y;
    return a.seq - b.seq;
}

/** Index of the next item to dispatch. */
function nextIndex(): number {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
        if (best === -1 || compare(pending[i], pending[best]) < 0) best = i;
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

        // The slot frees when the task has returned AND every native call it
        // handed to `hold` has settled (or hit its ceiling).
        const holds: Promise<unknown>[] = [];
        const hold: HoldSlot = (native, ceilingMs) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const ceiling = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    logger.warn('[TranslationQueue] Native call never settled; freeing the slot at the ceiling', {
                        label: item.label,
                        ceilingMs,
                    });
                    resolve();
                }, ceilingMs);
            });
            const settled = native.then(
                () => undefined,
                () => undefined,
            );
            void settled.then(() => {
                if (timer) clearTimeout(timer);
            });
            holds.push(Promise.race([settled, ceiling]));
        };

        let call: Promise<unknown>;
        try {
            call = Promise.resolve(item.run(hold));
        } catch (err) {
            call = Promise.reject(err);
        }
        call.then(item.resolve, item.reject);
        void call
            .then(
                () => {},
                () => {},
            )
            .then(() => Promise.all(holds))
            .then(() => {
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
 * Queue one native translation call and get a handle on it. Resolves with the
 * task's value, or {@link DROPPED} if it was cancelled or the route moved on
 * before it was dispatched.
 */
export function scheduleTranslationTask<T>(
    run: (hold: HoldSlot) => Promise<T>,
    options: EnqueueOptions = {},
): TranslationTaskHandle<T> {
    const itemEpoch = options.epoch === undefined ? epoch : options.epoch;
    const priority = options.priority ?? 0;
    const label = options.label ?? 'translate';
    const rank = options.rank ?? { visible: true, y: 0 };

    let item!: PendingItem;
    const promise = new Promise<T | Dropped>((resolve, reject) => {
        seqCounter += 1;
        enqueuedCount += 1;
        item = {
            seq: seqCounter,
            epoch: itemEpoch,
            priority,
            visible: rank.visible,
            y: Number.isFinite(rank.y) ? rank.y : 0,
            visibleSince: getScrollTickGeneration(),
            label,
            run: run as (hold: HoldSlot) => Promise<unknown>,
            resolve: resolve as (value: unknown) => void,
            reject,
        };
        pending.push(item);
    });
    logger.debug('[TranslationQueue] Enqueue', { label, epoch: itemEpoch, priority, pending: pending.length });
    pump();

    return {
        promise,
        setPriority: (next) => {
            if (!pending.includes(item)) return;
            if (next.visible && !item.visible) item.visibleSince = getScrollTickGeneration();
            item.visible = next.visible;
            item.y = Number.isFinite(next.y) ? next.y : 0;
        },
        cancel: () => {
            const index = pending.indexOf(item);
            if (index === -1) return false;
            pending.splice(index, 1);
            droppedCount += 1;
            item.resolve(DROPPED);
            return true;
        },
    };
}

/**
 * Queue one native translation call when the caller needs only its value (the
 * probe, and anything that never re-ranks or cancels).
 */
export function enqueueTranslationTask<T>(
    run: (hold: HoldSlot) => Promise<T>,
    options: EnqueueOptions = {},
): Promise<T | Dropped> {
    return scheduleTranslationTask(run, options).promise;
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
