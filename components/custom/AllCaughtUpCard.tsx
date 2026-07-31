import {
    CARDS_USE_GLASS,
    CardGlassPlate,
    GLASS_CARD_EDGE,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

const AllCaughtUpCard: React.FC = () => {
    const { t } = useTranslation();
    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every second
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length]);

    const innerContent = (
        <Box className="w-full py-20 px-6 items-center justify-center">
            {/* Mera logo — animated: this card is a rest stop the user
                actually dwells on, so the spotlight sweeps rather than
                sitting on a frozen frame. */}
            <Box className="mb-6">
                <MeraLogo size={100} animated />
            </Box>

            {/* "You're all caught up" text */}
            <Text
                size="xl"
                className="text-white text-center mb-4 font-semibold"
            >
                {t('feed.allCaughtUp')}
            </Text>

            {/* Cycling mindfulness message */}
            <Text
                size="md"
                className="text-gray-400 text-center"
            >
                {messages[currentIndex]}
            </Text>
        </Box>
    );

    // Glass, exactly as the article cards do it (ArticleCardBase's non-flat
    // branch): the plate must hang off an UNPADDED, clipping box, so the margin
    // + radius + edge move out here and the `Card` keeps its own padding. The
    // opaque `bg-black` has to GO rather than sit under the plate — a solid fill
    // painted over glass cancels the effect — and without this branch the card
    // was a full-width black block punched through the page backdrop.
    // Where glass does not paint (Android, iOS < 26) the original opaque card is
    // kept verbatim, `bg-black border-black` included.
    return CARDS_USE_GLASS ? (
        <Box
            testID="all-caught-up-card"
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
            testID="all-caught-up-card"
        >
            {innerContent}
        </Card>
    );
};

export default AllCaughtUpCard;
