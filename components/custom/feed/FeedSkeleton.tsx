import { CardGlassPlate } from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { HERO_IMAGE_CLASS } from '@/lib/layout/card-metrics';
import React from 'react';
import { View } from 'react-native';

/** Placeholder bar tone: a faint lift over the card plate. */
const BAR = 'rgba(255,255,255,0.08)';

/**
 * Two card-shaped placeholders shown while the Feed's local cache is still
 * loading on launch. Before this, that window fell through the empty-state
 * chain to "Mera is preparing your feed" for 2-4s on every cold start even
 * with cached cards present.
 *
 * STATIC on purpose: no shimmer, so there is nothing to gate on Reduce Motion
 * and nothing to cost battery. Same outer geometry as a flat hero card
 * (`rounded-2xl`, `h-48` hero, `mb-3`), so the real cards replace it without
 * the list jumping.
 *
 * Hidden from VoiceOver/TalkBack: grey bars mean nothing read aloud. The
 * caller announces "Loading your feed" once instead.
 */
const FeedSkeleton: React.FC = () => (
    <View
        testID="feed-skeleton"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
    >
        {[0, 1].map((i) => (
            <Box key={i} className="mb-3 rounded-2xl overflow-hidden border border-white/10">
                <CardGlassPlate />
                <Box className={`w-full ${HERO_IMAGE_CLASS}`} style={{ backgroundColor: BAR }} />
                <Box className="px-4 py-4">
                    <View style={{ height: 10, width: '40%', borderRadius: 5, backgroundColor: BAR }} />
                    <View style={{ height: 14, width: '92%', borderRadius: 7, backgroundColor: BAR, marginTop: 14 }} />
                    <View style={{ height: 14, width: '70%', borderRadius: 7, backgroundColor: BAR, marginTop: 8 }} />
                    <View style={{ height: 40, width: '100%', borderRadius: 10, backgroundColor: BAR, marginTop: 16 }} />
                </Box>
            </Box>
        ))}
    </View>
);

export default FeedSkeleton;
