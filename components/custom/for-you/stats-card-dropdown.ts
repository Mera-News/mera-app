// Where the Dashboard stats card's status dropdown goes, and how it measures
// its anchor. Pure geometry plus one native call, apart from the card so both
// are testable: jest's host views mock `measureInWindow` as a no-op that never
// calls back, so a test of the card has to replace the measurement, and the
// geometry is easier to pin as a function than through a rendered Modal.
//
// Why a dropdown at all: the card is the head of the Overview list, and
// growing it in place was captured growing UPWARD under the header at scroll
// offset 0 (the list keeps its visible content position), hiding the first
// rows of the body. A dropdown in a Modal never changes the list's height.

import type { View } from 'react-native';

export interface AnchorRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface DropdownFrame {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    /** The body scrolls inside this when it is taller. */
    readonly maxHeight: number;
}

/** Gap kept from the status bar at the top and the tab bar at the bottom. */
export const DROPDOWN_EDGE_GAP = 8;

/**
 * The dropdown sits directly under the card, never above the status bar and
 * never over the tab bar.
 *
 * `bottomReserve` is what the tab bar and home indicator take at the bottom
 * of the WINDOW (the Modal covers the whole window, tab bar included). On iOS
 * that is the in-tab `insets.bottom`, which already contains the bar; on
 * Android it is the inset plus the bar. See `dropdownBottomReserve`.
 */
export function dropdownFrame(
    anchor: AnchorRect,
    windowHeight: number,
    topInset: number,
    bottomReserve: number,
): DropdownFrame {
    const top = Math.max(anchor.y + anchor.height, topInset + DROPDOWN_EDGE_GAP);
    const bottom = windowHeight - bottomReserve - DROPDOWN_EDGE_GAP;
    return {
        top,
        left: anchor.x,
        width: anchor.width,
        maxHeight: Math.max(0, bottom - top),
    };
}

/**
 * The window-bottom reserve for the tab bar. NOT `tabBarClearance`: that
 * answers "inside the tab's content area", which on Android already ends at
 * the bar, while a Modal draws over the bar and has to step over it.
 */
export function dropdownBottomReserve(os: string, insetsBottom: number, tabBarHeight: number): number {
    return os === 'ios' ? insetsBottom : insetsBottom + tabBarHeight;
}

/** Measure the card in window coordinates; the Modal draws in the same space. */
export function measureAnchor(node: View | null, done: (rect: AnchorRect) => void): void {
    if (!node) return;
    node.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
}
