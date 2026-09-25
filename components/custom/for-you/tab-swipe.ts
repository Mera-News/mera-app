// Swipe between tabs (ux2 B3): the pure decision of where a finished drag
// lands. Shared by the Dashboard pills and the Explore scopes; the gesture
// wiring is SwipeTabs.tsx.

/** A change commits once the (damped) panel has moved this much of the width. */
export const TAB_SWIPE_COMMIT_FRACTION = 0.3;
/** ...or on a flick faster than this, in points per second. */
export const TAB_SWIPE_COMMIT_VELOCITY = 600;
/** The panel follows the finger at this fraction: a damped drag, so the
 *  content resists a little and a short drag reads as "springs back". */
export const TAB_SWIPE_DAMPING = 0.6;

export interface SwipeInput {
    /** Finger travel, points (negative = leftward). */
    readonly dx: number;
    /** Finger velocity at release, points per second. */
    readonly vx: number;
    readonly width: number;
    readonly index: number;
    readonly count: number;
    /** Right-to-left layout (Arabic): the direction mirrors. */
    readonly rtl: boolean;
}

/**
 * The tab a finished drag lands on, or null to spring back.
 *
 * LTR: a leftward swipe reveals the NEXT tab (content moves left); RTL mirrors
 * it, as the tab row itself is mirrored. A flick counts only in the drag's own
 * direction: a big drag one way with a flick the other is ambiguous and
 * springs back.
 */
export function swipeTarget({ dx, vx, width, index, count, rtl }: SwipeInput): number | null {
    if (width <= 0 || count <= 1 || dx === 0) return null;
    const travelled = Math.abs(dx) * TAB_SWIPE_DAMPING >= width * TAB_SWIPE_COMMIT_FRACTION;
    const flicked = Math.abs(vx) >= TAB_SWIPE_COMMIT_VELOCITY && Math.sign(vx) === Math.sign(dx);
    const against = Math.abs(vx) >= TAB_SWIPE_COMMIT_VELOCITY && Math.sign(vx) !== Math.sign(dx);
    if (against || !(travelled || flicked)) return null;
    const leftward = dx < 0;
    const step = leftward !== rtl ? 1 : -1;
    const next = index + step;
    return next >= 0 && next < count ? next : null;
}

/**
 * The panels a pager keeps mounted around `index`, the active one FIRST
 * (owner: cache and warm one screen each side; the ends only one). Never more
 * than 3. Active first, so a native walk of `subviews[0]` (react-native-
 * screens) lands on the list the reader is looking at.
 */
export function swipeWindow(index: number, count: number): number[] {
    if (count <= 0 || index < 0 || index >= count) return [];
    return [index, index - 1, index + 1].filter((i) => i >= 0 && i < count);
}
