// navx2 P2 kit gallery: every kit component of every area, in every state, for
// the design sign-off on the simulator (meraapp://dev-kit). Dev only, and the
// gate lives HERE because Expo Router bundles every file under app/.
// Deleted in P13 with every kit-gallery.tsx.
import { Redirect } from 'expo-router';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import CardsGallery from '@/components/custom/cards/kit-gallery';
import ForYouGallery from '@/components/custom/for-you/kit-gallery';
import MeraButtonGallery from '@/components/custom/mera-button/kit-gallery';
import NavGallery from '@/components/custom/nav/kit-gallery';
import YouGallery from '@/components/custom/you/kit-gallery';
import SharedGallery from '@/components/ui/kit-gallery';
import { useColors } from '@/lib/theme/tokens';

const SECTIONS: [string, React.ComponentType][] = [
    ['Shared kit (S6)', SharedGallery],
    ['Shell (S1)', NavGallery],
    ['Feed and Library (S2)', ForYouGallery],
    ['Cards and reading (S3)', CardsGallery],
    ['Mera button and chat (S4)', MeraButtonGallery],
    ['You and Settings (S5)', YouGallery],
];

function Sections() {
    const colors = useColors();
    return (
        <>
            {SECTIONS.map(([title, Section]) => (
                <View key={title} style={{ marginBottom: 32 }}>
                    <Text style={{ color: colors.ink3, fontSize: 13, fontWeight: '700', marginBottom: 12 }}>
                        {title}
                    </Text>
                    <Section />
                </View>
            ))}
        </>
    );
}

export default function DevKit() {
    const colors = useColors();
    const insets = useSafeAreaInsets();
    if (!__DEV__) return <Redirect href="/" />;
    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: colors.base }}
            contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 48 }}
            testID="dev-kit"
        >
            <Sections />
            {/* The same kit right to left (iOS honours `direction`). */}
            <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '700', marginVertical: 16 }}>RTL</Text>
            <View style={{ direction: 'rtl' }} testID="dev-kit-rtl">
                <Sections />
            </View>
        </ScrollView>
    );
}
