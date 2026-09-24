// Where the Dashboard stats card's status dropdown goes, and how it measures
// its anchor. Pure geometry plus one native call, apart from the card so both
// are testable: jest's host views mock `measureInWindow` as a no-op that never
// calls back, so a test of the card has to replace the measurement, and the
// geometry is easier to pin as a function than through a rendered Modal.
//
// The dropdown itself (provider + layer) is `stats-dropdown.tsx`.

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
 * never over the tab bar. All in the LAYER's coordinates: `containerHeight`
 * is the tab screen's height and `bottomReserve` is `useTabBarClearance()`
 * (the in-tab inset on iOS, where content runs under the bar; 0 on Android,
 * where content ends at the bar).
 */
export function dropdownFrame(
    anchor: AnchorRect,
    containerHeight: number,
    topInset: number,
    bottomReserve: number,
): DropdownFrame {
    const top = Math.max(anchor.y + anchor.height, topInset + DROPDOWN_EDGE_GAP);
    const bottom = containerHeight - bottomReserve - DROPDOWN_EDGE_GAP;
    return {
        top,
        left: anchor.x,
        width: anchor.width,
        maxHeight: Math.max(0, bottom - top),
    };
}

/** Measure a view in window coordinates (the card, and the layer's own origin). */
export function measureAnchor(node: View | null, done: (rect: AnchorRect) => void): void {
    if (!node) return;
    node.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
}
