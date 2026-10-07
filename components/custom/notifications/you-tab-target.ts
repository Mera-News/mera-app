// Where a notice flies to: the centre of the You tab icon.
//
// approximation: NativeTabs never exposes its frame to JS, so the target is
// worked out from the window, the bottom inset and the tab's index. Close
// enough for "it went into You"; a near miss is hidden by the fade.

/** You is the last of the four tabs. */
const TAB_COUNT = 4;
const YOU_INDEX = 3;

export interface Point {
    readonly x: number;
    readonly y: number;
}

export function youTabTarget(
    windowWidth: number,
    windowHeight: number,
    bottomInset: number,
    tabBarHeight: number,
    isRTL: boolean,
): Point {
    // Row direction follows the writing direction, so in RTL You sits leftmost.
    const index = isRTL ? TAB_COUNT - 1 - YOU_INDEX : YOU_INDEX;
    return {
        x: (windowWidth * (index + 0.5)) / TAB_COUNT,
        y: windowHeight - bottomInset - tabBarHeight / 2,
    };
}
