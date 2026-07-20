// use-focus-coalesced-value — focus-aware pass-through for a live value that
// drives an expensive downstream render tree.
//
// Tabs stay mounted now (see FocusFreeze @deprecated), so a blurred screen keeps
// receiving store updates and would otherwise re-run its expensive derivation on
// every one — offscreen, for a tab nobody is looking at. This hook decouples the
// returned value from `live` by focus:
//
//   • FOCUSED  — adopt every new `live` promptly (in a transition, so the
//                downstream tree stays interruptible while the user scrolls).
//   • BLURRED  — trailing-coalesce: recompute at most once per `blurredIntervalMs`
//                with the latest value, so the downstream tree stays WARM offscreen
//                without paying for every intermediate update. On refocus the
//                already-rendered (≤ interval stale) value shows on the first
//                frame, then the latest is adopted — no switch-time render burst.

import { startTransition, useEffect, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';

/** Default trailing-coalesce window while blurred (ms). */
const DEFAULT_BLURRED_INTERVAL_MS = 5000;

export function useFocusCoalescedValue<T>(
  live: T,
  options?: { blurredIntervalMs?: number; focused?: boolean },
): T {
  const hasOverride = options?.focused !== undefined;
  // `useIsFocused` is only skipped when a `focused` override is supplied, which
  // is a testability escape hatch (it throws outside a navigator) — real callers
  // never pass it, so for any mounted instance this call is effectively
  // unconditional. Mirrors FocusFreeze's override pattern.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const navigationFocused = hasOverride ? false : useIsFocused();
  const isFocused = hasOverride ? (options?.focused as boolean) : navigationFocused;

  const blurredIntervalMs = options?.blurredIntervalMs ?? DEFAULT_BLURRED_INTERVAL_MS;

  const [value, setValue] = useState<T>(live);
  // Latest `live` — read at timer-fire time so a blurred coalesce always adopts
  // the newest value, not the one captured when the timer was armed.
  const latestRef = useRef<T>(live);
  latestRef.current = live;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isFocused) {
      // Refocus (or a focused update): drop any pending blurred timer and adopt
      // the latest value in a transition. The first frame after refocus still
      // shows the already-rendered coalesced value, so there is no burst.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      startTransition(() => setValue(latestRef.current));
      return;
    }

    // Blurred: arm a single trailing timer on the first change with none pending.
    // It fires once per interval and adopts whatever the latest value is then,
    // keeping the downstream tree warm without recomputing on every update.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      startTransition(() => setValue(latestRef.current));
    }, blurredIntervalMs);
    // `live` is a dep so a blurred change re-runs this effect and arms the timer.
  }, [live, isFocused, blurredIntervalMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return value;
}

export default useFocusCoalescedValue;
