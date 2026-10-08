// The page swipe's pure decisions: where a finished drag lands (a page of
// THIS tab, or back where it was) and which panels stay mounted. A swipe
// never leaves its tab (owner): bottom tabs change only from the tab bar.
// The gesture wiring is PagePager.tsx.

/** A page change commits once the (damped) row has moved this much of the width. */
export const PAGE_COMMIT_FRACTION = 0.3;
/** ...or on a flick faster than this, in points per second. */
export const PAGE_COMMIT_VELOCITY = 600;
/** The row follows the finger at this fraction: a short drag reads as "springs back". */
export const SWIPE_DAMPING = 0.6;
/** Past the first or last page the row follows the finger only this much:
 *  the edge's resistance, then it springs back. */
export const SWIPE_EDGE_DAMPING = 0.2;
/** Sideways travel (pt) before the page swipe takes the touch. */
export const SWIPE_ACTIVATE_PX = 25;
/** Vertical travel (pt) that hands the touch to the page's list instead. */
export const SWIPE_VERTICAL_FAIL_PX = 12;

/** The page a finished drag lands on, or null: it springs back. */
export type SwipeOutcome = { readonly kind: 'page'; readonly index: number } | null;

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
}

/**
 * Where a finished drag lands. LTR: a leftward drag reveals the NEXT page; RTL
 * mirrors it. A flick counts only in the drag's own direction; a big drag one
 * way with a flick the other springs back.
 */
export function swipeOutcome(input: SwipeInput): SwipeOutcome {
  const { dx, vx, width, index, count, rtl } = input;
  if (width <= 0 || dx === 0) return null;
  const travelled = Math.abs(dx) * SWIPE_DAMPING;
  const fast = Math.abs(vx) >= PAGE_COMMIT_VELOCITY;
  if (fast && Math.sign(vx) !== Math.sign(dx)) return null;
  const step: 1 | -1 = dx < 0 !== rtl ? 1 : -1;
  const next = index + step;
  if (next < 0 || next >= count) return null;
  return travelled >= width * PAGE_COMMIT_FRACTION || fast ? { kind: 'page', index: next } : null;
}

/**
 * How far the row follows a drag `dx` from page `index`: damped, and damped
 * much harder toward a page that does not exist (past the first or last).
 */
export function dragFollow(dx: number, index: number, count: number, rtl: boolean): number {
  'worklet';
  const step = dx < 0 !== rtl ? 1 : -1;
  const next = index + step;
  return dx * (next < 0 || next >= count ? SWIPE_EDGE_DAMPING : SWIPE_DAMPING);
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
