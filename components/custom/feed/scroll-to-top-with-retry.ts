// Pulled out of FeedScreen.tsx into its own module for one reason: unit
// testability. FeedScreen.tsx pulls in ~25 stores/hooks/gluestack components
// to render at all, none of which bear on this logic — importing it from a
// test file drags the whole gluestack/nativewind import chain (untransformed
// ESM) along for the ride. This file has zero such dependencies, so a test
// can exercise the retry logic directly against a fake ref.

/** Minimal shape `scrollToTopWithRetry` needs from the list ref — narrowed so
 *  it can be unit-tested with a plain object instead of a real FlatList. */
export interface ScrollToOffsetRef {
  current: { scrollToOffset: (p: { offset: number; animated: boolean }) => void } | null;
}

/** How long to wait before deciding an issued scroll never took effect. Must
 *  be well past one frame: an animated `scrollToOffset` reports its first
 *  motion via `onScroll`, which (a) an OS scroll-position animation doesn't
 *  necessarily dispatch within the first ~16ms and (b) is additionally capped
 *  by this list's `scrollEventThrottle={16}` — so checking one frame later
 *  would misread a perfectly healthy in-flight animation as "swallowed" and
 *  fire a spurious retry. 120ms gives a real animation several throttled
 *  scroll events to report motion before we conclude it never landed. */
const VERIFY_DELAY_MS = 120;

/**
 * Scroll a FlatList-like ref to the top, verifying the call actually landed
 * and retrying once if it didn't.
 *
 * This exists because a `scrollToOffset` issued on the Feed list can be
 * silently absorbed when it lands inside a window where something else is
 * also touching layout/scroll position — the same class of drop already
 * documented on FeedScreen's post-refresh reset effect (`pendingScrollResetRef`),
 * which needs its own `requestAnimationFrame` guard for exactly this reason.
 * The FAB itself can't collide in the SAME frame as that reset (it only shows
 * past `SCROLL_THRESHOLD`, and a refresh always starts from offset 0, so the
 * FAB is hidden until the user scrolls back down well after the reset has
 * run). The most likely wider-window trigger: pull-to-refresh kicks off a
 * sync whose newly-Complete suggestions can get PREPENDED by the `ingest`
 * effect while it runs, and each prepend re-triggers
 * `maintainVisibleContentPosition`'s anchor adjustment on this very list — an
 * animated `scrollToOffset` racing that adjustment could be overridden with
 * no visible effect. That's the leading hypothesis, not a proven trace — this
 * fix deliberately doesn't need to pin down the exact trigger, only detect
 * whether the call actually worked.
 *
 * Rather than special-case "just after a refresh", this verifies the general
 * postcondition — did the offset move at all `VERIFY_DELAY_MS` later — and
 * reissues once if not. Checking "changed" rather than "is 0" keeps it safe
 * under an in-flight animated scroll that just hasn't arrived at 0 yet. The
 * retry itself is `animated: false`: if the first call actually WAS still in
 * flight and this fires anyway, jumping immediately to 0 just lands the user
 * there instead of fighting/cancelling the original animation.
 *
 * `schedule` (defaults to `requestAnimationFrame`) defers the initial call
 * past the current render/layout pass; `verify` (defaults to a
 * `VERIFY_DELAY_MS` timeout) defers the landed-or-not check. Both are
 * overridable so a test can drive them deterministically instead of racing
 * real timers.
 */
export function scrollToTopWithRetry(
  ref: ScrollToOffsetRef,
  getOffset: () => number,
  schedule: (cb: () => void) => void = requestAnimationFrame,
  verify: (cb: () => void) => void = (cb) => setTimeout(cb, VERIFY_DELAY_MS),
): void {
  schedule(() => {
    const before = getOffset();
    ref.current?.scrollToOffset({ offset: 0, animated: true });
    verify(() => {
      const after = getOffset();
      // `after === before` alone would also match "we were already at rest
      // at the top the whole time" — unreachable today (the FAB only shows
      // past SCROLL_THRESHOLD, so `before` is never 0), but the `after > 0`
      // guard costs nothing and keeps a future consumer with a lower/no
      // threshold from retrying into a list that's already correctly at 0.
      if (after === before && after > 0) {
        ref.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
  });
}
