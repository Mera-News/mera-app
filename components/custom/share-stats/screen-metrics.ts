// Vertical space the chrome around each Stats card takes, in points.
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

/** One card's Share pill under it (PILL_METRICS: 18 top margin + 44 tall). */
export const CARD_SHARE_ALLOWANCE = 62;

/**
 * The box each card is fitted into on the Stats page: the content width, and
 * a height that lets one card plus its Share pill sit between the tab's header
 * and the tab bar, so no card is ever taller than the screen.
 *
 * `bottomReserve` is the TAB BAR clearance, not the full list-end clearance:
 * the page scrolls, so the "How this page works" row and the Mera button's
 * clearance live below the last card.
 */
export function statsCardBox(
  page: { readonly width: number; readonly height: number },
  headerHeight: number,
  bottomReserve: number,
): { width: number; height: number } {
  return {
    width: Math.max(0, page.width - 2 * STATS_SIDE_GAP),
    height: Math.max(0, page.height - headerHeight - STATS_TOP_GAP - CARD_SHARE_ALLOWANCE - bottomReserve),
  };
}
