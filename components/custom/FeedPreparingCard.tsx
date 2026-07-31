import {
    CARDS_USE_GLASS,
    CardGlassPlate,
    GLASS_CARD_EDGE,
} from '@/components/custom/cards/CardGlassPlate';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
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
        </Box>
    );

    // Glass, matching AllCaughtUpCard and ArticleCardBase's non-flat branch: the
    // plate must hang off an UNPADDED, clipping box, so margin + radius + edge
    // move out here while the `Card` keeps its own padding. The opaque
    // `bg-black` has to GO rather than sit under the plate — a solid fill
    // painted over glass cancels it. Off iOS 26 the original opaque card is kept
    // verbatim, `bg-black border-black` included.
    // `rounded-2xl` rather than the `rounded-md` the other status cards use —
    // this one is a large, mostly-empty waiting panel, and the tighter radius
    // read as a hard-edged slab at that size. The radius lives on the clipping
    // box in the glass branch (the plate is clipped by its parent) and on the
    // Card itself in the fallback.
    return CARDS_USE_GLASS ? (
        <Box
            testID="feed-preparing-card"
            className={`mb-4 rounded-2xl overflow-hidden ${GLASS_CARD_EDGE}`}
        >
            <CardGlassPlate />
            <Card variant="elevated" size="md" className="bg-transparent">
                {innerContent}
            </Card>
        </Box>
    ) : (
        <Card
            variant="elevated"
            size="md"
            className="mb-4 overflow-hidden rounded-2xl bg-black border-black"
            testID="feed-preparing-card"
        >
            {innerContent}
        </Card>
    );
};

export default FeedPreparingCard;
