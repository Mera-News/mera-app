import {
    CARDS_USE_GLASS,
    CardGlassPlate,
    GLASS_CARD_EDGE,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

const NoGeneratedInterestsCard: React.FC = () => {
    const { t } = useTranslation();

    const innerContent = (
        <Box className="w-full py-20 px-6 items-center justify-center">
            {/* Mera Logo */}
            <Box className="mb-6">
                <MeraLogo size={100} />
            </Box>

            {/* Main message */}
            <Text
                size="xl"
                className="text-white text-center mb-4 font-semibold"
            >
                {t('feed.noInterests')}
            </Text>

            {/* Secondary message */}
            <Text
                size="md"
                className="text-gray-400 text-center"
            >
                {t('feed.noInterestsDescription')}
            </Text>
        </Box>
    );

    // Glass, matching AllCaughtUpCard and ArticleCardBase's non-flat branch: the
    // plate must hang off an UNPADDED, clipping box, so margin + radius + edge
    // move out here while the `Card` keeps its own padding. The opaque
    // `bg-black` has to GO rather than sit under the plate — a solid fill
    // painted over glass cancels it. Off iOS 26 the original opaque card is kept
    // verbatim, `bg-black border-black` included.
    return CARDS_USE_GLASS ? (
        <Box
            testID="no-interests-card"
            className={`mb-4 rounded-md overflow-hidden ${GLASS_CARD_EDGE}`}
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
            className="mb-4 overflow-hidden bg-black border-black"
            testID="no-interests-card"
        >
            {innerContent}
        </Card>
    );
};

export default NoGeneratedInterestsCard;
