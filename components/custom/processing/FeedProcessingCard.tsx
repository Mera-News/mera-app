import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CARDS_USE_GLASS, CardGlassPlate } from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useForYouDeviceProcessing } from '@/lib/stores/selectors';

import ProcessingArea from './ProcessingArea';
import { PROCESSING_CARD_HEIGHT, PROCESSING_METRICS } from './types';
import { useProcessingSnapshot } from './use-processing-snapshot';

/**
 * The list-level processing surface, replacing `FeedPreparingCard` on both feed
 * screens.
 *
 * ## It is EXACTLY `PROCESSING_CARD_HEIGHT`, and that is not decoration
 *
 * This view lives inside a list under `maintainVisibleContentPosition`, and
 * `for-you/DashboardSectionsFeed.tsx` carries a written record of a
 * pull-to-refresh bug traced to MVCP interacting with constant re-derivation. A
 * list item whose height changes as it loads re-opens that bug class. So: a
 * fixed height, never a `minHeight`, no `layout` transition, and a
 * `numberOfLines` clamp on every string inside so the longest locale cannot
 * push it.
 *
 * ## What it inherits from the card it replaces
 *
 * The two nested Boxes, and the nesting is load-bearing: React Native drops a
 * view's shadow the moment that same view also sets `overflow: hidden`, so the
 * shadow lives on the outer, non-clipping Box and the rounded, clipped surface
 * is the inner one. The glass plate has to hang off an unpadded box and the
 * opaque background has to GO rather than sit under it, since a solid fill
 * painted over glass cancels the effect.
 *
 * It also keeps the `feed-preparing-card` and `feed-preparing-explore-cta`
 * testIDs. Those are not legacy debt: the simulator harness and
 * `components/custom/__tests__/status-cards.test.tsx` both address this surface
 * by them, and renaming them would break a harness runbook for no gain.
 *
 * What it does NOT keep is `StreamingIndicator`, whose twenty captions are
 * hardcoded English and were rendering untranslated on this exact surface.
 */
const FeedProcessingCard: React.FC = () => {
    const { t } = useTranslation();
    const snapshot = useProcessingSnapshot();
    const { isDeviceProcessing } = useForYouDeviceProcessing();

    const inner = (
        <Box
            className="w-full px-6 items-center justify-center"
            style={{ height: PROCESSING_CARD_HEIGHT }}
        >
            {snapshot.visible ? (
                <ProcessingArea snapshot={snapshot} onDevice={isDeviceProcessing} />
            ) : (
                // The area resolves to nothing only in the narrow window where
                // the list is empty and no work is in flight. The old copy is
                // the right thing to say there, and it keeps the card's height
                // identical so nothing below it moves.
                <View style={{ alignItems: 'center' }}>
                    <Text size="md" numberOfLines={2} className="text-gray-400 text-center">
                        {t('feed.preparingFeed')}
                    </Text>
                    <Text size="sm" numberOfLines={2} className="text-gray-500 text-center mt-2">
                        {t('feed.preparingFeedExploreHint')}
                    </Text>
                </View>
            )}

            <Button
                testID="feed-preparing-explore-cta"
                variant="outline"
                action="secondary"
                size="sm"
                style={{ marginTop: PROCESSING_METRICS.ctaGap, height: PROCESSING_METRICS.ctaHeight }}
                onPress={() => router.navigate('/logged-in/app_container/around')}
            >
                <ButtonText>{t('feed.exploreCta')}</ButtonText>
            </Button>
        </Box>
    );

    return (
        <Box testID="feed-preparing-card" className="mb-4 rounded-2xl shadow-hard-2">
            <Box
                className={
                    CARDS_USE_GLASS
                        ? 'rounded-2xl overflow-hidden border border-white/10'
                        : 'rounded-2xl overflow-hidden bg-background-0 border border-white/10'
                }
            >
                <CardGlassPlate />
                {inner}
            </Box>
        </Box>
    );
};

export default FeedProcessingCard;
