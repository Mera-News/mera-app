// Module-level pub/sub so TranslatableDynamic can defer translation work
// until items actually enter the viewport.
//
// Screens that render translated content inside a scrollable wire their
// scroll handler to `notifyScrollTick()`. Each TranslatableDynamic listens,
// re-measures its own position, and only kicks off a translation once its
// view is on (or near) the screen.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Minimum gap between scroll-tick notifications. A native scroll fires many
 *  events per second; each notification makes every waiting TranslatableDynamic
 *  call `measureInWindow`, so we throttle rather than run per-event/per-frame. */
const THROTTLE_MS = 150;

let lastFireAt = 0;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribeScrollTick(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

function fire(): void {
    lastFireAt = Date.now();
    listeners.forEach((fn) => fn());
}

/**
 * Call from any scroll handler. Throttles to at most one notification per
 * `THROTTLE_MS` with leading + trailing edges: the first call fires
 * immediately, further calls inside the window are coalesced into a single
 * trailing fire scheduled for the end of the window — so the final scroll
 * position always gets a tick even if the user stops mid-window.
 */
export function notifyScrollTick(): void {
    const elapsed = Date.now() - lastFireAt;
    if (elapsed >= THROTTLE_MS) {
        // Leading edge — enough time has passed, fire now.
        if (trailingTimer) {
            clearTimeout(trailingTimer);
            trailingTimer = null;
        }
        fire();
        return;
    }
    // Inside the throttle window — ensure exactly one trailing fire is queued.
    if (trailingTimer) return;
    trailingTimer = setTimeout(() => {
        trailingTimer = null;
        fire();
    }, THROTTLE_MS - elapsed);
}
