import type { ReactNode } from 'react';
import { create } from 'zustand';
import logger from '@/lib/logger';

/**
 * THE TOAST QUEUE.
 *
 * App-owned, module-level, and deliberately NOT React context. It replaces
 * gluestack's `ToastProvider` for one structural reason: `GluestackUIProvider`
 * mounts a `ToastProvider` at the root AND again inside ~24 nested route files,
 * each with its own array and its own `ToastList`. `useToast()` inside a screen
 * therefore resolved to that screen's provider while `toastManager` drove the
 * root one, so two hosts could paint at the same placement with zero knowledge
 * of each other — there was no single queue to stack.
 *
 * A module-level store makes those nested providers inert without editing one
 * of them: nothing calls gluestack's `setToast` any more, so every nested
 * `ToastList` sees an empty `toastInfo` and renders null. `OverlayProvider`
 * stays mounted; every other gluestack overlay still routes through it.
 *
 * `useToast()` in `@/components/ui/toast` returns this module's API, whose
 * shape is byte-identical to gluestack's — `{ show, close, closeAll, isActive }`
 * — so all ~80 call sites and `toastManager` were unchanged by the swap.
 */

/** Floor for how long ANY toast stays on screen. Anything shorter reads as a
 *  flicker — the user cannot finish reading it before it goes. Errors and
 *  successes deliberately sit longer; nothing sits shorter.
 *
 *  It is also the BACKLOG CLAMP: while cards are waiting behind the front one,
 *  the front card is cut down to this floor so a burst drains instead of
 *  holding the screen for the sum of its durations. */
export const TOAST_MIN_DURATION_MS = 2000;

/** Cards held in the stack. The deck only paints three; the rest wait. A cap
 *  exists so the queue cannot grow without bound, not because it is reached in
 *  practice — a burst that big has never been observed. */
export const TOAST_QUEUE_CAP = 5;

/**
 * ONE STACK, AT THE TOP. There used to be a second, bottom lane with its own
 * queue and timer, so a toast shown there never stacked with the one already
 * at the top (the feedback sheet's Undo toast landed there). Owner decision:
 * the top deck is the only toast mechanism. `placement` is still accepted so
 * the gluestack-shaped `show()` signature keeps compiling, and it is IGNORED:
 * a stray 'bottom' joins the same stack behind whatever is showing.
 */
/**
 * Unchanged from gluestack's, deliberately: whether a card is the FRONT one
 * reaches its subtree through `ToastFrontProvider` in `@/components/ui/toast`
 * instead of an argument here, because the things that need it sit inside
 * `Toast` (`ToastTitle`'s assertive announcement) or inside a caller's own
 * component (`NotifiedToast`'s fly-to-bell), and neither can be reached by
 * changing what the ~80 call sites pass.
 */
export interface ToastRenderProps {
    id: string;
}

export interface ToastShowOptions {
    /**
     * Caller-supplied, STABLE id. Showing again with the same id replaces the
     * existing card rather than queueing a second copy — the behaviour
     * `TranslationUnavailablePrompt` leans on, together with `isActive`, to keep
     * exactly one persistent banner per language. Omit it and the queue mints
     * one.
     */
    id?: string;
    /** Ignored. Kept for signature compatibility; every card joins the top stack. */
    placement?: 'top' | 'bottom';
    /** `null` means "until something closes it" — see the persistent lane below. */
    duration?: number | null;
    /**
     * Opt out of the backlog clamp. Set by `showNotifiedToast`, whose duration
     * is sized to its own animation EXACTLY (`notifiedToastDurationMs`): cutting
     * it to the 2000ms floor would tear the toast off mid-flight.
     */
    holdFullDuration?: boolean;
    render: (props: ToastRenderProps) => ReactNode;
}

export interface ToastEntry {
    id: string;
    duration: number | null;
    holdFullDuration: boolean;
    render: (props: ToastRenderProps) => ReactNode;
    /** Arrival order. The sort is stable on this, never on array position. */
    seq: number;
}

interface ToastQueueState {
    /** In DISPLAY order: index 0 is the front card. */
    entries: ToastEntry[];
}

export const useToastQueue = create<ToastQueueState>(() => ({
    entries: [],
}));

let nextId = 1;
let nextSeq = 1;

/**
 * The single armed timer, plus enough bookkeeping to RE-ARM it
 * correctly. `startedAt` is when the front card began showing and `armedFor` is
 * the total lifetime currently promised, so when a new arrival shortens that
 * promise we can fire after `armedFor - elapsed` rather than restarting the
 * clock and accidentally extending the card.
 */
interface ActiveTimer {
    id: string;
    handle: ReturnType<typeof setTimeout>;
    startedAt: number;
    armedFor: number;
}

let timer: ActiveTimer | null = null;

function clearTimer(): void {
    if (timer) {
        clearTimeout(timer.handle);
        timer = null;
    }
}

/**
 * Transient cards first, then arrival order.
 *
 * The persistent lane is what stops `TranslationUnavailablePrompt`'s
 * `duration: null` banner from owning the front slot forever and deadlocking
 * the queue: it sits at the back while transient confirmations pass in front of
 * it, and returns to front — still untimed — once it is the only card left.
 */
function inDisplayOrder(entries: ToastEntry[]): ToastEntry[] {
    return [...entries].sort((a, b) => {
        const persistentA = a.duration === null ? 1 : 0;
        const persistentB = b.duration === null ? 1 : 0;
        if (persistentA !== persistentB) return persistentA - persistentB;
        return a.seq - b.seq;
    });
}

/**
 * Arm, re-arm or clear the timer for the front card.
 *
 * ONLY the front card is ever timed, and its clock starts when it BECOMES the
 * front card, not when it was enqueued. That is the whole of "they go away one
 * by one": under FIFO the second card cannot expire while it is still an
 * unreadable sliver behind the first.
 */
function syncTimer(): void {
    const entries = useToastQueue.getState().entries;
    const front = entries[0];

    if (!front || front.duration === null) {
        clearTimer();
        return;
    }

    const backlog = entries.length > 1;
    const desired =
        backlog && !front.holdFullDuration
            ? Math.min(front.duration, TOAST_MIN_DURATION_MS)
            : front.duration;

    if (timer && timer.id === front.id) {
        // Already counting down for this card. Only ever SHORTEN it: a backlog
        // that drains must not hand the front card extra time it was already
        // most of the way through.
        if (timer.armedFor <= desired) return;
        clearTimeout(timer.handle);
        const remaining = Math.max(0, desired - (Date.now() - timer.startedAt));
        timer = {
            id: front.id,
            handle: setTimeout(() => close(front.id), remaining),
            startedAt: timer.startedAt,
            armedFor: desired,
        };
        return;
    }

    clearTimer();
    timer = {
        id: front.id,
        handle: setTimeout(() => close(front.id), desired),
        startedAt: Date.now(),
        armedFor: desired,
    };
}

/**
 * Enforce the cap. The card dropped is the OLDEST WAITING transient, never the
 * front card (it is mid-read) and never the newest arrival (it is the event the
 * user just caused). If every waiting card is persistent there is nothing safe
 * to drop, so the newest goes instead.
 */
function applyCap(entries: ToastEntry[]): ToastEntry[] {
    if (entries.length <= TOAST_QUEUE_CAP) return entries;

    const victim = entries.findIndex((entry, index) => index >= 1 && entry.duration !== null);
    const dropAt = victim === -1 ? entries.length - 1 : victim;
    logger.info(
        `[toast-queue] queue over ${TOAST_QUEUE_CAP}, dropping toast ${entries[dropAt].id}`,
    );
    return entries.filter((_, index) => index !== dropAt);
}

export function show(options: ToastShowOptions): string {
    const id = options.id ?? `${nextId++}`;
    // Replacing in place, not queueing a duplicate. Clear the timer first: the
    // card being replaced may be the one currently counting down.
    if (isActive(id)) close(id);
    const entry: ToastEntry = {
        id,
        // `undefined` means "not specified" and takes gluestack's old 5000ms
        // default; `null` means persistent and must survive the check.
        duration: options.duration === undefined ? 5000 : options.duration,
        holdFullDuration: options.holdFullDuration === true,
        render: options.render,
        seq: nextSeq++,
    };

    useToastQueue.setState((state) => ({
        entries: applyCap(inDisplayOrder([...state.entries, entry])),
    }));

    syncTimer();
    return id;
}

/**
 * Remove a card wherever it sits, not just cancel a timer it may never have
 * owned — `TranslationUnavailablePrompt` closes its own persistent card, which
 * normally lives at the BACK of the queue and has never been timed.
 */
export function close(id: string): void {
    const queue = useToastQueue.getState().entries;
    if (!queue.some((entry) => entry.id === id)) return;

    if (timer?.id === id) clearTimer();
    useToastQueue.setState({ entries: queue.filter((entry) => entry.id !== id) });
    syncTimer();
}

export function closeAll(): void {
    clearTimer();
    useToastQueue.setState({ entries: [] });
}

export function isActive(id: string): boolean {
    return useToastQueue.getState().entries.some((entry) => entry.id === id);
}

/** Test-only: drop every card and every timer, and rewind the id counters so
 *  assertions on ids do not depend on what ran before them. */
export function resetToastQueue(): void {
    closeAll();
    nextId = 1;
    nextSeq = 1;
}

/**
 * The object `useToast()` hands out. Module-level and frozen in identity, so it
 * is a stable dependency for every `useCallback`/`useMemo` that closes over it —
 * `ToastInitializer`'s effect in particular runs exactly once.
 */
export const toastApi = { show, close, closeAll, isActive } as const;
