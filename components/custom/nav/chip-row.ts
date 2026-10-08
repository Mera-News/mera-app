// Explore's chip row maths, pure and worklet-safe: how much of a chip the
// edge fade lets through, and how far a selection scrolls the row.

/** The row's inset at both ends (the page side inset). */
export const CHIP_ROW_INSET = 14;
/** A chip the viewport edge cuts is never fainter than this. */
export const CHIP_MIN_OPACITY = 0.35;

/**
 * A chip's opacity from its on-screen edges: 1 while the viewport shows all
 * of it, then the visible share of its width, never below the floor. Only a
 * chip the edge actually cuts fades; one fully in view never does.
 */
export function chipOpacity(left: number, width: number, viewport: number): number {
  'worklet';
  if (width <= 0 || viewport <= 0) return 1;
  const visible = Math.min(left + width, viewport) - Math.max(left, 0);
  if (visible >= width) return 1;
  return Math.max(CHIP_MIN_OPACITY, visible / width);
}

/**
 * The scroll offset that just reveals a chip at content `x` (with its inset
 * of room), or null when it is already fully in view: a selection never
 * moves a row that already shows it.
 */
export function revealOffset(
  x: number,
  width: number,
  scrollX: number,
  viewport: number,
  contentWidth: number,
): number | null {
  const max = Math.max(0, contentWidth - viewport);
  let target = scrollX;
  if (x - CHIP_ROW_INSET < scrollX) target = x - CHIP_ROW_INSET;
  else if (x + width + CHIP_ROW_INSET > scrollX + viewport) target = x + width + CHIP_ROW_INSET - viewport;
  target = Math.min(max, Math.max(0, target));
  return target === scrollX ? null : target;
}
