// Where a notice flies to: the centre of the Feed tab icon, the tab that holds
// the inbox (Feed > Notifications).
//
// approximation: NativeTabs never exposes its frame to JS, so the target is
// worked out from the window, the bottom inset and the tab's index. Close
// enough for "it went into the Feed"; a near miss is hidden by the fade.

/** The Feed is the first of the four tabs. */
const TAB_COUNT = 4;
const INBOX_TAB_INDEX = 0;

export interface Point {
    readonly x: number;
    readonly y: number;
}

export function inboxTabTarget(
    windowWidth: number,
    windowHeight: number,
    bottomInset: number,
    tabBarHeight: number,
    isRTL: boolean,
): Point {
    // Row direction follows the writing direction, so in RTL the Feed sits rightmost.
    const index = isRTL ? TAB_COUNT - 1 - INBOX_TAB_INDEX : INBOX_TAB_INDEX;
    return {
        x: (windowWidth * (index + 0.5)) / TAB_COUNT,
        y: windowHeight - bottomInset - tabBarHeight / 2,
    };
}
