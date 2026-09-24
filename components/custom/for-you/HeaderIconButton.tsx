// The one header icon button every tab header uses for a plain glyph action
// (owner: the Dashboard bell must be "the same size and style as the search
// icon in Explore"; one component so the two cannot drift).
//
// A real 44pt frame pulled back to the 24pt glyph's footprint by a -10 margin,
// not hitSlop: a slop-only button measured 24x24 on device, and the negative
// margin keeps the glyph where it was so no header row reflows. White glyph,
// no chip, no border. A STATIC style, never a function (the css-interop
// wrapper drops function styles on device).

import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

export const HEADER_ICON_GLYPH = 24;
export const HEADER_ICON_COLOR = '#ffffff';
/**
 * The gap between neighbouring right-hand header actions (mark, search,
 * Advanced, refresh, bell), in points and in `style` (the `space` tokens are
 * rem-scaled). 25 keeps two 44pt frames apart even beside the Feed mark, whose
 * frame reaches ~14.4pt past its 15.1pt glyph box at 375; a plain icon's
 * reaches 10.
 */
export const HEADER_ACTIONS_GAP = 25;
const TARGET = 44;
const FRAME_STYLE = {
    width: TARGET,
    height: TARGET,
    margin: -(TARGET - HEADER_ICON_GLYPH) / 2,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

export interface HeaderIconButtonProps {
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly onPress: () => void;
    readonly accessibilityLabel: string;
    readonly testID: string;
    readonly onLayout?: (e: LayoutChangeEvent) => void;
    /** Read after the label (the Profile refresh icon's tooltip text). */
    readonly accessibilityHint?: string;
    /** Work in flight: a spinner replaces the glyph and the button disables. */
    readonly busy?: boolean;
    /** Overlays drawn over the glyph (the bell's unread badge). */
    readonly children?: React.ReactNode;
}

const HeaderIconButton = React.forwardRef<View, HeaderIconButtonProps>(function HeaderIconButton(
    { icon, onPress, accessibilityLabel, testID, onLayout, accessibilityHint, busy = false, children },
    ref,
) {
    return (
        <Pressable
            ref={ref as never}
            onPress={onPress}
            onLayout={onLayout}
            disabled={busy}
            style={FRAME_STYLE}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityState={busy ? { disabled: true, busy: true } : undefined}
            testID={testID}
        >
            {busy ? (
                <Spinner size="small" color={HEADER_ICON_COLOR} testID={`${testID}-spinner`} />
            ) : (
                <MaterialIcons name={icon} size={HEADER_ICON_GLYPH} color={HEADER_ICON_COLOR} />
            )}
            {children}
        </Pressable>
    );
});

export default HeaderIconButton;
