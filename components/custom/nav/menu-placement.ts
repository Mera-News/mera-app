// Where a floating choice menu goes, as a pure function: under its chip when
// it fits, above it when it does not, and clamped inside the safe area when it
// fits neither way. The panel's height is MEASURED by the caller, never
// derived from a row count.

export interface MenuPlacementInput {
  /** The chip's top and height, in window points. */
  readonly chipTop: number;
  readonly chipHeight: number;
  /** The measured panel height. */
  readonly panelHeight: number;
  readonly windowHeight: number;
  /** Safe-area insets: the menu never draws under them. */
  readonly safeTop: number;
  readonly safeBottom: number;
  /** Space between the chip and the menu. */
  readonly gap: number;
}

/** The menu's top, in window points. */
export function menuTop({
  chipTop,
  chipHeight,
  panelHeight,
  windowHeight,
  safeTop,
  safeBottom,
  gap,
}: MenuPlacementInput): number {
  const floor = windowHeight - safeBottom;
  const below = chipTop + chipHeight + gap;
  if (below + panelHeight <= floor) return below;
  const above = chipTop - gap - panelHeight;
  if (above >= safeTop) return above;
  return Math.max(safeTop, Math.min(below, floor - panelHeight));
}
