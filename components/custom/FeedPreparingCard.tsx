import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';

const FeedPreparingCard: React.FC = () => {
    const { t } = useTranslation();

    const innerContent = (
        <Box className="w-full py-12 px-6 items-center justify-center">
            <StreamingIndicator />
            <Text size="md" className="text-gray-400 text-center mt-4">
                {t('feed.preparingFeed')}
            </Text>
            <Text size="sm" className="text-gray-500 text-center mt-2">
                {t('feed.preparingFeedExploreHint')}
            </Text>

            <Button
                testID="feed-preparing-explore-cta"
                variant="outline"
                action="secondary"
                size="sm"
                className="mt-6"
                onPress={() => router.navigate('/logged-in/app_container/around')}
            >
                <ButtonText>{t('feed.exploreCta')}</ButtonText>
            </Button>
        </Box>
    );

    // Surface copied from ArticleCardBase's FLAT branch — the one the Feed's
    // article cards actually render through — via AllCaughtUpCard, which is the
    // reference implementation for every list-level card. This card already had
    // the right `rounded-2xl` radius, but it kept the NON-flat branch's structure:
    // no shadow, and a `Card` wrapper whose own `p-4` stacked on top of the
    // content's `py-12 px-6` — 40px of horizontal padding where 24 was intended.
    //
    // Two nested Boxes, and the nesting is load-bearing: RN drops a view's shadow
    // the moment that same view also sets `overflow: hidden`, so the shadow lives
    // on the outer, non-clipping Box and the rounded/clipped surface is the inner
    // one. The plate must hang off an UNPADDED box, and the opaque background has
    // to GO rather than sit under it — a solid fill painted over glass cancels the
    // effect entirely. Where glass does not paint, the opaque `bg-background-0`
    // comes back (NOT the old `bg-black border-black`, which no other card uses).
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
                {innerContent}
            </Box>
        </Box>
    );
};

export default FeedPreparingCard;
