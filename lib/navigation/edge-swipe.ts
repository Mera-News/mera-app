/**
 * Width of the Dashboard's right-edge swipe hitbox — the absolutely-positioned,
 * full-height `GestureDetector` strip in `ForYouScreen` whose left-pan opens the
 * Profile tab.
 *
 * It matters OUTSIDE that screen because it is rendered ON TOP of the sub-tab
 * content and its backing view is a plain `View`: a tap landing inside the strip
 * is hit-tested to it, the pan gesture never activates, and because RN's
 * responder system bubbles UP (never sideways to the covered sibling) the tap is
 * simply swallowed. Any control drawn within this band of the right screen edge
 * is therefore DEAD while the Dashboard hosts it.
 *
 * That is exactly what killed the Saved sub-tab's per-card delete button: at
 * `right: 5%` (~20px) its 34px footprint spanned x∈[348, 382] on a 402pt screen,
 * so the centre of the button sat inside the old 40px strip and every tap —
 * by coordinate or by accessibility ref — was eaten.
 *
 * Narrowed to 20 (the iOS system screen-edge-gesture width) and exported so
 * overlapping controls can derive their clearance from it instead of guessing.
 */
export const EDGE_SWIPE_HITBOX_WIDTH = 20;

/** Right inset that clears the edge-swipe strip with a comfortable margin.
 *  Controls pinned to the right edge of a Dashboard-hosted screen use this. */
export const EDGE_SWIPE_SAFE_RIGHT_INSET = EDGE_SWIPE_HITBOX_WIDTH + 8;
