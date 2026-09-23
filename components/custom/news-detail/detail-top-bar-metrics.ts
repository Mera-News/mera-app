// The detail top bar's geometry, apart from DetailTopBar itself so the
// scroll container can use it without importing Reanimated (a jest suite
// that loads Reanimated for real dies on the uninitialised worklets runtime).

/** The back button's offset below the safe-area top. */
export const DETAIL_BACK_TOP_OFFSET = 8;
/** The back button: `p-3` around a 24pt icon. */
export const DETAIL_BACK_SIZE = 48;
/** The bar's height below the safe-area top: the button plus the same gap
 *  under it as above. Content scrolled past this line is under the bar. */
export const DETAIL_TOP_BAR_HEIGHT = DETAIL_BACK_TOP_OFFSET + DETAIL_BACK_SIZE + DETAIL_BACK_TOP_OFFSET;
