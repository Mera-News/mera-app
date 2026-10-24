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
//  3. CONCURRENCY stays at ONE. See {@link TRANSLATION_CONCURRENCY}. The slot
//     is held past a task's answer while its abandoned native call is still
//     running (`holdSlotUntil`; the service sets the ceiling).
//
//  4. BATCHING. When the slot frees, the head item takes up to
//     TRANSLATION_BATCH_MAX queued items with the same batch key (the service
//     keys by target language), in priority order and under
//     TRANSLATION_BATCH_MAX_CHARS, into ONE task. There is no waiting window:
//     a batch forms only from what queued behind the slot. The probe never
//     batches. TRANSLATION_BATCH_MAX = 1 turns it off.
//
//  5. THE APP AWAY. Inactive holds dispatch; background drops everything but
//     the probe; active resumes and bumps the epoch if anything was dropped.
//     See setAppStateSource below.
//
// Page changes the reader makes (TabPages) bump the epoch like a route change.
//
// A dropped item resolves with {@link DROPPED} — never rejects, never throws.
// Callers MUST distinguish it from a failure: a failure means "the OS could not
// translate this", a drop means "we chose not to ask yet", and a caller that
// conflates them will mark the text permanently un-translatable for the
// session. A node re-asks a dropped text once it is visible again, the app is
// active (useTranslationQueueActive) and its page is the visible one.

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
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

/**
 * Handed to every task. `holdSlotUntil` keeps the slot busy after the task has
 * resolved its caller: a native call abandoned at its JS timeout is still
 * running on the module's one shared view controller, and a second call
 * dispatched now would overwrite it.
 */
export interface TranslationTaskContext {
    holdSlotUntil(settled: Promise<unknown>): void;
}

interface PendingItem {
    readonly seq: number;
    /** null ⇒ exempt from epoch drops (the probe). */
    readonly epoch: number | null;
    readonly priority: number;
    readonly label: string;
    readonly run: (ctx: TranslationTaskContext) => Promise<unknown>;
    readonly batch?: TranslationBatchSpec<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
}

/**
 * Most items one native call may carry, and most characters across them.
 * `TRANSLATION_BATCH_MAX = 1` turns batching off entirely: every item then runs
 * its own task, exactly as before batching existed. That is the revert switch.
 */
export const TRANSLATION_BATCH_MAX = 8;
export const TRANSLATION_BATCH_MAX_CHARS = 1500;
let batchMax = TRANSLATION_BATCH_MAX;

/** Test seam for the revert switch. */
export function __setTranslationBatchMaxForTests(max: number): void {
    batchMax = max;
}

/**
 * How an item may share a native call. Items with the same `key` batch
 * together; the head item's `run` gets every member's `payload` in dispatch
 * order and must answer an array aligned to it (a member's answer may itself
 * be a promise, e.g. the member re-queued alone).
 */
export interface TranslationBatchSpec<P> {
    readonly key: string;
    readonly chars: number;
    readonly payload: P;
    readonly run: (payloads: P[], ctx: TranslationTaskContext) => Promise<unknown[]>;
}

const byDispatchOrder = (a: PendingItem, b: PendingItem): number =>
    a.priority - b.priority || a.seq - b.seq;

/** The head plus every queued item that may ride with it, removed from the queue. */
function takeBatch(head: PendingItem): PendingItem[] {
    const spec = head.batch;
    if (!spec || batchMax <= 1) return [head];
    const group = [head];
    let chars = spec.chars;
    for (const item of pending.filter((p) => p.batch?.key === spec.key).sort(byDispatchOrder)) {
        if (group.length >= batchMax) break;
        if (chars + item.batch!.chars > TRANSLATION_BATCH_MAX_CHARS) continue;
        chars += item.batch!.chars;
        group.push(item);
    }
    if (group.length > 1) pending = pending.filter((p) => !group.includes(p));
    return group;
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
    /** Lets this item share one native call with queued items of the same key. */
    readonly batch?: TranslationBatchSpec<any>;
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

const noop = (): void => {};

function pump(): void {
    while (inFlight < TRANSLATION_CONCURRENCY && appMode === 'active') {
        // Belt and braces: `bumpTranslationEpoch` already swept, but an item can
        // be enqueued against an epoch that advances before it reaches the head.
        sweepStale();
        const index = nextIndex();
        if (index === -1) return;
        const [item] = pending.splice(index, 1);
        const group = takeBatch(item);
        inFlight += 1;
        dispatchedCount += group.length;
        logger.debug('[TranslationQueue] Dispatch', {
            label: item.label,
            epoch: item.epoch,
            priority: item.priority,
            batch: group.length,
            pending: pending.length,
        });
        const holds: Promise<unknown>[] = [];
        const ctx: TranslationTaskContext = {
            holdSlotUntil: (settled) => {
                holds.push(settled.then(noop, noop));
            },
        };
        let call: Promise<unknown>;
        try {
            call = group.length === 1
                ? Promise.resolve(item.run(ctx))
                : Promise.resolve(item.batch!.run(group.map((g) => g.batch!.payload), ctx));
        } catch (err) {
            call = Promise.reject(err);
        }
        if (group.length === 1) {
            call.then(item.resolve, item.reject);
        } else {
            call.then(
                (answers) => group.forEach((g, i) => g.resolve((answers as unknown[])[i])),
                (err) => group.forEach((g) => g.reject(err)),
            );
        }
        void call.then(noop, noop).then(() => Promise.all(holds)).then(() => {
            inFlight -= 1;
            completedCount += group.length;
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
    run: (ctx: TranslationTaskContext) => Promise<T>,
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
            run: run as (ctx: TranslationTaskContext) => Promise<unknown>,
            batch: options.batch,
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

// ── The app leaving the foreground ──
//
// `inactive` (Control Center, the app switcher, a system prompt) holds dispatch
// and keeps the queue: the reader is usually back in a moment. `background`
// drops every queued item except the probe, because the screen may be gone by
// the time the app returns. Calls already in flight are untouched either way.
// On `active`, dispatch resumes, and the epoch bumps only if something was
// dropped, so dropped nodes re-ask. The probe is held, never dropped.

/** What the queue needs from react-native's AppState. Injected so tests can drive it. */
export interface AppStateSource {
    readonly currentState?: string | null;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

type AppMode = 'active' | 'inactive' | 'background';
let appMode: AppMode = 'active';
/** Advanced on every move to background, so a call can tell it spanned one. */
let backgroundGeneration = 0;
let droppedWhileAway = false;
let appStateSubscription: { remove(): void } | null = null;
const activeListeners = new Set<() => void>();

function modeOf(state: string | null | undefined): AppMode {
    return state === 'background' ? 'background' : state === 'inactive' ? 'inactive' : 'active';
}

function applyAppState(state: string | null | undefined): void {
    const next = modeOf(state);
    if (next === appMode) return;
    const wasActive = appMode === 'active';
    appMode = next;
    if (next === 'background') {
        backgroundGeneration += 1;
        const casualties = pending.filter((item) => item.epoch !== null);
        if (casualties.length > 0) {
            pending = pending.filter((item) => item.epoch === null);
            droppedCount += casualties.length;
            droppedWhileAway = true;
            logger.debug('[TranslationQueue] Dropped queued items on background', { dropped: casualties.length });
            for (const item of casualties) item.resolve(DROPPED);
        }
    }
    if (next === 'active') {
        if (droppedWhileAway) {
            droppedWhileAway = false;
            bumpTranslationEpoch('app-active');
        }
        pump();
    }
    if (wasActive !== (next === 'active')) activeListeners.forEach((listener) => listener());
}

/** Swap the AppState the queue listens to (tests). `null` stops listening and counts as active. */
export function setAppStateSource(source: AppStateSource | null): void {
    appStateSubscription?.remove();
    appStateSubscription = null;
    applyAppState(source?.currentState ?? 'active');
    if (source) appStateSubscription = source.addEventListener('change', applyAppState);
}

/** False while the app is inactive or backgrounded: nothing dispatches then. */
export function isTranslationQueueActive(): boolean {
    return appMode === 'active';
}

/** Changes every time the app goes to the background. */
export function getTranslationBackgroundGeneration(): number {
    return backgroundGeneration;
}

function subscribeQueueActive(listener: () => void): () => void {
    activeListeners.add(listener);
    return () => {
        activeListeners.delete(listener);
    };
}

/** Reactive {@link isTranslationQueueActive}. A node re-asks a dropped text only while this is true. */
export function useTranslationQueueActive(): boolean {
    return useSyncExternalStore(subscribeQueueActive, isTranslationQueueActive, () => true);
}

setAppStateSource(AppState);

/** Test seam — clears every module-level scheduler state. */
export function __resetTranslationQueueForTests(): void {
    const casualties = pending;
    pending = [];
    appMode = 'active';
    backgroundGeneration = 0;
    droppedWhileAway = false;
    epoch = 0;
    batchMax = TRANSLATION_BATCH_MAX;
    seqCounter = 0;
    inFlight = 0;
    enqueuedCount = 0;
    dispatchedCount = 0;
    completedCount = 0;
    droppedCount = 0;
    epochListeners.clear();
    for (const item of casualties) item.resolve(DROPPED);
}
