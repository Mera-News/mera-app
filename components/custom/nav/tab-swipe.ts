// The page swipe's pure decisions: where a finished drag lands (a page, the
// next or previous TAB, or back where it was), which panels stay mounted, and
// whether a fresh touch belongs to the page swipe at all. The gesture wiring
// is PagePager.tsx. Worklet-safe: the activation decision runs on the UI
// thread.

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
/** Horizontal travel (pt) at which a touch is decided for or against the page
 *  swipe. Small, so a fast fling is decided before it ends. */
export const SWIPE_DECIDE_PX = 10;
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

export type SwipeDecision = 'wait' | 'fail' | 'activate';

export interface DecisionInput {
  readonly dx: number;
  readonly dy: number;
  /** The touch started inside a registered horizontal scroller. */
  readonly inScroller: boolean;
  /** That scroller sits at its start / end edge. */
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly rtl: boolean;
}

/**
 * Decide a fresh touch for the page swipe on its first movement, before a
 * fast fling has ended (a bouncing ScrollView never FAILS, so waiting for it
 * cannot work). Inside a horizontal scroller the swipe takes over only at the
 * scroller's edge in the drag direction, so one continuous swipe runs from
 * its last card into the next page.
 */
export function swipeDecision({ dx, dy, inScroller, atStart, atEnd, rtl }: DecisionInput): SwipeDecision {
  'worklet';
  if (Math.abs(dy) > SWIPE_VERTICAL_FAIL_PX && Math.abs(dy) > Math.abs(dx)) return 'fail';
  if (Math.abs(dx) < SWIPE_DECIDE_PX) return 'wait';
  if (!inScroller) return 'activate';
  const towardEnd = dx < 0 !== rtl;
  return (towardEnd ? atEnd : atStart) ? 'activate' : 'fail';
}

/** The pager's fractional page index for a drag in progress (Mera button fade). */
export function fractionalIndex(index: number, translationX: number, width: number, rtl: boolean): number {
  'worklet';
  if (width <= 0) return index;
  const dir = rtl ? -1 : 1;
  return index - (dir * translationX * SWIPE_DAMPING) / width;
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
