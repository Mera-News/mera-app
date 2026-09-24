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
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

export const HEADER_ICON_GLYPH = 24;
export const HEADER_ICON_COLOR = '#ffffff';
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
    /** Overlays drawn over the glyph (the bell's unread badge). */
    readonly children?: React.ReactNode;
}

const HeaderIconButton = React.forwardRef<View, HeaderIconButtonProps>(function HeaderIconButton(
    { icon, onPress, accessibilityLabel, testID, onLayout, children },
    ref,
) {
    return (
        <Pressable
            ref={ref as never}
            onPress={onPress}
            onLayout={onLayout}
            style={FRAME_STYLE}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={testID}
        >
            <MaterialIcons name={icon} size={HEADER_ICON_GLYPH} color={HEADER_ICON_COLOR} />
            {children}
        </Pressable>
    );
});

export default HeaderIconButton;
