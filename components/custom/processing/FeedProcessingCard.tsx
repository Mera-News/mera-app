import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
 * ## It has no card chrome, deliberately
 *
 * No border, no radius, no shadow, no glass plate. It used to carry all four,
 * inherited from the card it replaced, which meant an outlined plate floating
 * alone on an otherwise empty page: that reads as a card that failed to load
 * rather than as the page working. The two nested Boxes went with them, since
 * their only job was that RN drops a view's shadow when the same view clips.
 *
 * ## What it keeps
 *
 * It keeps the `feed-preparing-card` and `feed-preparing-explore-cta`
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

    // No card chrome. This surface is not one item among many, it is the ONLY
    // thing on the screen while a run is in flight, and an outlined plate
    // floating on an empty page reads as a card that failed to fill rather than
    // as the page itself working. So: no border, no radius, no shadow, and no
    // glass plate, which exists to separate a card from the cards around it and
    // has nothing to separate this from. The backdrop shows through directly.
    //
    // The height stays fixed and the `mb-4` stays with it. Both are about the
    // list, not about the look: this renders inside a list under
    // `maintainVisibleContentPosition`, where an item whose height moves as it
    // loads re-opens a recorded pull-to-refresh bug.
    return (
        <Box testID="feed-preparing-card" className="mb-4">
            {inner}
        </Box>
    );
};

export default FeedProcessingCard;
