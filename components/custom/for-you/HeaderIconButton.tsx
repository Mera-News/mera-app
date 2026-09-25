// The one header icon button every tab header uses for a plain glyph action
// (owner: the Dashboard bell must be "the same size and style as the search
// icon in Explore"; one component so the two cannot drift).
//
// A real 44pt frame pulled back to the 24pt glyph's footprint by a -10 margin,
// not hitSlop: a slop-only button measured 24x24 on device, and the negative
// margin keeps the glyph where it was so no header row reflows. White glyph,
// no chip, no border. A STATIC style, never a function (the css-interop
// wrapper drops function styles on device).
//
// The glyph (and any overlay, the bell badge) is drawn in a hidden visual layer
// with a CHILDLESS labelled Pressable laid over it. A glyph inside a button
// surfaced on iOS as its own StaticText, hidden props or not (captured). So
// the frame style lives on the wrapper `${testID}-frame`, and `ref` and
// `onLayout` land there too: it is the node the bell measures.

import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

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
const VISUAL_STYLE = { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' } as const;

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
        <View ref={ref} onLayout={onLayout} style={FRAME_STYLE} testID={`${testID}-frame`}>
            <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={VISUAL_STYLE}
            >
                <MaterialIcons
                    name={icon}
                    size={HEADER_ICON_GLYPH}
                    color={HEADER_ICON_COLOR}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />
                {children}
            </View>
            <Pressable
                onPress={onPress}
                style={StyleSheet.absoluteFill}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                testID={testID}
            />
        </View>
    );
});

export default HeaderIconButton;
