// The page swipe's pure decisions: where a finished drag lands (a page, the
// next or previous TAB, or back where it was) and which panels stay mounted.
// The gesture wiring is PagePager.tsx.

/** A page change commits once the (damped) row has moved this much of the width. */
export const PAGE_COMMIT_FRACTION = 0.3;
/** ...or on a flick faster than this, in points per second. */
export const PAGE_COMMIT_VELOCITY = 600;
/** The row follows the finger at this fraction: a short drag reads as "springs back". */
export const SWIPE_DAMPING = 0.6;
/** Past a tab's last (or before its first) page, the next tab takes over only
 *  after this much damped travel, and NEVER on a flick: a fast swipe through
 *  the pages must not throw the reader into another tab. */
export const TAB_HANDOFF_FRACTION = 0.35;
/** Sideways travel (pt) before the page swipe takes the touch. */
export const SWIPE_ACTIVATE_PX = 25;
/** Vertical travel (pt) that hands the touch to the page's list instead. */
export const SWIPE_VERTICAL_FAIL_PX = 12;

export type SwipeOutcome =
  | { readonly kind: 'page'; readonly index: number }
  | { readonly kind: 'tab'; readonly step: 1 | -1 }
  | null;

export interface SwipeInput {
  /** Finger travel, points (negative = leftward). */
  readonly dx: number;
  /** Finger velocity at release, points per second. */
  readonly vx: number;
  readonly width: number;
  readonly index: number;
  readonly count: number;
  /** Right-to-left layout: the direction mirrors. */
  readonly rtl: boolean;
  /** Whether a tab exists before / after this one to hand off to. */
  readonly hasPrevTab: boolean;
  readonly hasNextTab: boolean;
}

/**
 * Where a finished drag lands. LTR: a leftward drag reveals the NEXT page; RTL
 * mirrors it. A flick counts only in the drag's own direction; a big drag one
 * way with a flick the other springs back.
 */
export function swipeOutcome(input: SwipeInput): SwipeOutcome {
  const { dx, vx, width, index, count, rtl, hasPrevTab, hasNextTab } = input;
  if (width <= 0 || dx === 0) return null;
  const travelled = Math.abs(dx) * SWIPE_DAMPING;
  const fast = Math.abs(vx) >= PAGE_COMMIT_VELOCITY;
  if (fast && Math.sign(vx) !== Math.sign(dx)) return null;
  const step: 1 | -1 = dx < 0 !== rtl ? 1 : -1;
  const next = index + step;
  if (next >= 0 && next < count) {
    return travelled >= width * PAGE_COMMIT_FRACTION || fast ? { kind: 'page', index: next } : null;
  }
  const canLeave = step === 1 ? hasNextTab : hasPrevTab;
  return canLeave && travelled >= width * TAB_HANDOFF_FRACTION ? { kind: 'tab', step } : null;
}

/**
 * The panels kept mounted around `index`: the active one FIRST (UIKit and
 * react-native-screens walk `subviews[0]`), then its neighbours, then any
 * keep-mounted page outside that window (the Feed, whose reading session
 * lives in the screen). Duplicates are dropped.
 */
export function swipeWindow(index: number, count: number, keep: readonly number[] = []): number[] {
  if (count <= 0 || index < 0 || index >= count) return [];
  const out: number[] = [];
  for (const i of [index, index - 1, index + 1, ...keep]) {
    if (i >= 0 && i < count && !out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * The page to show: `activeId` while it exists, else the page that sat left
 * of it (a removed country lands on its left neighbour), else the first.
 */
export function survivingPage<T extends string>(
  pages: readonly T[],
  activeId: T | null,
  lastIndex: number,
): T | null {
  if (pages.length === 0) return null;
  if (activeId && pages.includes(activeId)) return activeId;
  return pages[Math.max(0, Math.min(lastIndex - 1, pages.length - 1))];
}
