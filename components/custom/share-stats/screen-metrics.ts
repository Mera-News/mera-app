// Vertical space the chrome around the pager takes, in points.
//
// Its own module, with NO imports, for a mechanical reason: these numbers are
// read by both the share screen and the layout test, and importing them from
// the screen drags in AbstractGradientBackdrop and MeraLogo, and through them
// reanimated, whose native side does not exist under jest — the suite then dies
// on "Native part of Worklets doesn't seem to be initialized" with a stack
// pointing at an import line rather than at anything the test does.
//
// The other half of why they are shared rather than duplicated: a test holding
// its own copy of the layout numbers keeps passing after the layout moves,
// which is the failure this wave has hit repeatedly. One object, rendered from
// and modelled from.
//
// The card gets whatever the Library's Stats page has left after the tab's
// header, these and the tab bar, and its width follows from the export's
// 1080/1420 ratio. So raising any of these makes the card SMALLER on every
// device, and on the floor device that is the number that decides whether it
// is still readable.

/** Space between the tab's header and the card. */
export const STATS_TOP_GAP = 14;

/** Space either side of the card. */
export const STATS_SIDE_GAP = 16;

/** The page-dot row. */
export const DOTS_ALLOWANCE = 28;

/** The share pill plus the privacy line and naming toggle under it. */
export const PILL_ALLOWANCE = 96;

/**
 * The box the card is fitted into on the Stats page.
 *
 * `bottomReserve` is the TAB BAR clearance, not the full list-end clearance:
 * the page scrolls, so the "How this page works" row and the Mera button's
 * clearance live below the fold, while the share pill (centred) never sits
 * under the Mera button (bottom right). Reserving the full ~172pt list end
 * here would shrink the card on the floor device below legible.
 */
export function statsCardBox(
  page: { readonly width: number; readonly height: number },
  headerHeight: number,
  bottomReserve: number,
): { width: number; height: number } {
  return {
    width: Math.max(0, page.width - 2 * STATS_SIDE_GAP),
    height: Math.max(
      0,
      page.height - headerHeight - STATS_TOP_GAP - DOTS_ALLOWANCE - PILL_ALLOWANCE - bottomReserve,
    ),
  };
}
