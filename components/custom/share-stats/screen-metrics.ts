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
// The card gets whatever is left after these and the safe-area insets, and its
// width follows from the export's 1080/1420 ratio. So raising any of these
// makes the card SMALLER on every device, and on the floor device that is the
// number that decides whether it is still readable.

/** Title, subtitle and back affordance above the pager. */
export const HEADER_ALLOWANCE = 72;

/** The page-dot row. */
export const DOTS_ALLOWANCE = 28;

/** The share pill plus the privacy line and naming toggle under it. */
export const PILL_ALLOWANCE = 96;
