import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useColors, useThemeMode, type ThemeMode } from '@/lib/theme/tokens';

/**
 * The ONE material for every bottom sheet and centred dialog (Modals board):
 * an opaque base, a warm orange glow top left, violet on the right, blue at
 * the bottom, and a faint wash over all of it. Light theme: the same glow,
 * stronger, over white.
 *
 * It absolute-fills its parent, so put it first inside a container that owns
 * the radius and `overflow: 'hidden'`, then the content on top.
 *
 * Static on purpose: one Svg drawn once, no clock, no Reanimated, so a modal
 * costs nothing per frame and a jest suite that renders one needs no worklets.
 * Positions and radii are the board's CSS (`radial-gradient(Wpx Hpx at X% Y%)`)
 * in points, so a small dialog shows less of each glow, as on the board.
 */

interface Glow {
    id: string;
    cx: string;
    cy: string;
    rx: number;
    ry: number;
    color: string;
}

const GLOWS: Record<ThemeMode, { wash: string; glows: Glow[] }> = {
    dark: {
        wash: 'rgba(255,255,255,0.02)',
        glows: [
            { id: 'mm-orange', cx: '10%', cy: '8%', rx: 220, ry: 240, color: 'rgba(231,138,83,0.20)' },
            { id: 'mm-violet', cx: '96%', cy: '72%', rx: 240, ry: 240, color: 'rgba(150,120,220,0.14)' },
            { id: 'mm-blue', cx: '40%', cy: '112%', rx: 260, ry: 200, color: 'rgba(13,166,242,0.12)' },
        ],
    },
    light: {
        wash: 'rgba(18,17,19,0.07)',
        glows: [
            { id: 'mm-orange', cx: '10%', cy: '8%', rx: 220, ry: 240, color: 'rgba(231,138,83,0.34)' },
            { id: 'mm-violet', cx: '96%', cy: '72%', rx: 240, ry: 240, color: 'rgba(150,120,220,0.26)' },
            { id: 'mm-blue', cx: '40%', cy: '112%', rx: 260, ry: 200, color: 'rgba(13,166,242,0.22)' },
        ],
    },
};

export default function ModalMaterial({ style }: { style?: StyleProp<ViewStyle> }) {
    const colors = useColors();
    const { wash, glows } = GLOWS[useThemeMode()];
    return (
        <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.modalBase }, style]}
        >
            <Svg width="100%" height="100%">
                <Defs>
                    {glows.map((g) => (
                        <RadialGradient
                            key={g.id}
                            id={g.id}
                            cx={g.cx}
                            cy={g.cy}
                            fx={g.cx}
                            fy={g.cy}
                            rx={g.rx}
                            ry={g.ry}
                            gradientUnits="userSpaceOnUse"
                        >
                            <Stop offset="0" stopColor={g.color} />
                            <Stop offset="1" stopColor={g.color} stopOpacity={0} />
                        </RadialGradient>
                    ))}
                </Defs>
                {glows.map((g) => (
                    <Rect key={g.id} width="100%" height="100%" fill={`url(#${g.id})`} />
                ))}
                <Rect width="100%" height="100%" fill={wash} />
            </Svg>
        </View>
    );
}
