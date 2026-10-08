// The segmented header row's side slots: a control on one side (the Feed's
// status icon, the ?) is balanced by an empty slot as wide on the other, so
// the track's centre is the SCREEN's centre on every tab (owner).

/** A side control's frame: the status icon's and the ?'s 44pt. */
export const SIDE_SLOT = 44;

export function headerSideSlots(hasLeading: boolean, hasHelp: boolean): { left: number; right: number } {
  const any = hasLeading || hasHelp;
  return { left: any ? SIDE_SLOT : 0, right: any ? SIDE_SLOT : 0 };
}

/** The x of the track's centre, for a row `screenWidth` wide with `sidePad`
 *  on each edge. */
export function trackCentreX(screenWidth: number, sidePad: number, slots: { left: number; right: number }): number {
  const start = sidePad + slots.left;
  const end = screenWidth - sidePad - slots.right;
  return (start + end) / 2;
}
