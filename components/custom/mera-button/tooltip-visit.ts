// When the current visit to a surface began, shared by every Mera button.
//
// The tooltip shows for TOOLTIP_MS from the start of a VISIT and stays gone
// until the next one. A visit starts when the current surface changes (a page
// swipe, a tab switch, a push, a return from article detail): one stamp in one
// place, so the per-tab button instances, which hide while the chat is open
// and while Arrange or the keyboard is up, can never restart the clock by
// remounting. Memory only; nothing about reading is recorded (invariant 9).

import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';

export const TOOLTIP_MS = 10_000;

let visit = { surface: useCurrentSurfaceStore.getState().surface as string | null, startedAt: Date.now() };

useCurrentSurfaceStore.subscribe((state, prev) => {
  if (state.surface !== prev.surface) visit = { surface: state.surface, startedAt: Date.now() };
});

/** How long the tooltip still has on `surface` in this visit (0 when spent). */
export function tooltipRemainingMs(surface: string, now: number = Date.now()): number {
  if (visit.surface !== surface) return 0;
  return Math.max(0, TOOLTIP_MS - (now - visit.startedAt));
}
