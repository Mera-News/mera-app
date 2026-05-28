// Module-level pub/sub so TranslatableDynamic can defer translation work
// until items actually enter the viewport.
//
// Screens that render translated content inside a scrollable wire their
// scroll handler to `notifyScrollTick()`. Each TranslatableDynamic listens,
// re-measures its own position, and only kicks off a translation once its
// view is on (or near) the screen.

type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;

export function subscribeScrollTick(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/** Call from any scroll handler. Coalesces to one notification per frame. */
export function notifyScrollTick(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
        pending = false;
        listeners.forEach((fn) => fn());
    });
}
