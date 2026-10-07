// S4's section of the navx2 P2 kit gallery (app/dev-kit.tsx): every kit piece
// this area owns, in every state. Dev only; deleted in P13.
import MeraLogo, { LayeredMark } from '@/components/custom/MeraLogo';
import { COLORS, useColors } from '@/lib/theme/tokens';
import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import MeraButton from './MeraButton';

const row: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 24, padding: 16, borderRadius: 12 };

/** Static (the one-Svg path), the layered path forced still at -15 degrees
 *  whatever the motion settings (the pixel-parity pair: these two must match),
 *  then the layered path moving (still under Reduce Motion or Lite). */
function LogoPair({ ink, ground }: { ink: string; ground: string }) {
    return (
        <View style={[row, { backgroundColor: ground, gap: 16 }]} testID="kit-mera-logo-pair">
            <MeraLogo size={96} color={ink} />
            <LayeredMark size={96} color={ink} cone cards still />
            <MeraLogo size={96} color={ink} animated scrollCards />
        </View>
    );
}

function Label({ children }: { children: string }) {
    const colors = useColors();
    return <Text style={{ color: colors.ink3, fontSize: 12, marginTop: 12, marginBottom: 4 }}>{children}</Text>;
}

export default function KitGallery() {
    const colors = useColors();
    return (
        <View>
            <Label>Mera mark, 96pt: static, layered frozen at -15, layered moving</Label>
            <LogoPair ink={COLORS.dark.ink} ground={COLORS.dark.base} />
            <LogoPair ink={COLORS.light.ink} ground={COLORS.light.base} />
            <Label>Mera mark, status icon colours</Label>
            <View style={[row, { backgroundColor: colors.base }]}>
                <MeraLogo size={28} color={colors.ink} />
                <MeraLogo size={28} color={colors.ink} animated />
                <MeraLogo size={28} color={colors.accentMark} />
                <MeraLogo size={28} color={colors.negative} />
            </View>
            <Label>Mera button: rest, working, unread</Label>
            <View style={[row, { backgroundColor: colors.base, gap: 40, paddingHorizontal: 28 }]}>
                <MeraButton surface="kit" page="feed" />
                <MeraButton surface="kit" page="feed" working />
                <MeraButton surface="kit" page="feed" unread />
            </View>
        </View>
    );
}
