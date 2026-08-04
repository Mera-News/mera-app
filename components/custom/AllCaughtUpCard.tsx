import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

interface AllCaughtUpCardProps {
    /** Rendered under the "all caught up" line. Only the Feed's IN-LIST divider
     *  passes it, to say what the rows below the boundary are ("everything
     *  below, you've already seen"). */
    subtitle?: string;
    /**
     * Render at CARD scale — sized to sit in the feed among the article cards
     * rather than as a full-width panel.
     *
     * Opt-IN, and deliberately so. This component has five call sites and they
     * split two ways: two are rows inside the Feed list (the in-list divider and
     * the end-of-list footer), and three are terminal EMPTY STATES — the Feed's
     * own `renderEmpty`, `for-you/FactFeedScreen`, and `for-you/ForYouScreen` —
     * where the card is the entire screen and its presence is the point.
     * Shrinking those would leave a small card marooned in a blank screen. Making
     * `compact` opt-in means the three empty states keep their current size with
     * no edit at all, which also keeps this change out of files another area owns.
     */
    compact?: boolean;
}

const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = ({ subtitle, compact = false }) => {
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

    // `px-4` in compact mirrors ArticleCardBase's own content padding, so the
    // text column starts on the same vertical line as every neighbouring card's.
    // NOTE none of these Texts sets `numberOfLines` — long translations wrap and
    // grow the card rather than clipping. The worst cases in the locale files are
    // de `allCaughtUp` (60 chars), fr `mindfulness` (60) and de `exploreCta`
    // (21, inside an auto-sizing Button); all wrap to at most two lines here.
    const innerContent = (
        <Box
            className={
                compact
                    ? 'w-full py-8 px-4 items-center justify-center'
                    : 'w-full py-20 px-6 items-center justify-center'
            }
        >
            {/* Mera logo — animated: this card is a rest stop the user
                actually dwells on, so the spotlight sweeps rather than
                sitting on a frozen frame. */}
            <Box className={compact ? 'mb-3' : 'mb-6'}>
                <MeraLogo size={compact ? 64 : 100} animated />
            </Box>

            {/* "You're all caught up" text */}
            <Text
                size={compact ? 'lg' : 'xl'}
                className={`text-white text-center font-semibold ${compact ? 'mb-2' : 'mb-4'}`}
            >
                {t('feed.allCaughtUp')}
            </Text>

            {subtitle ? (
                <Text
                    size="sm"
                    className={`text-typography-400 text-center ${compact ? 'mb-2' : 'mb-4'}`}
                >
                    {subtitle}
                </Text>
            ) : null}

            {/* Cycling mindfulness message */}
            <Text
                size={compact ? 'sm' : 'md'}
                className="text-gray-400 text-center"
            >
                {messages[currentIndex]}
            </Text>

            <Button
                testID="all-caught-up-explore-cta"
                variant="outline"
                action="secondary"
                size="sm"
                className={compact ? 'mt-4' : 'mt-6'}
                onPress={() => router.navigate('/logged-in/app_container/around')}
            >
                <ButtonText>{t('feed.exploreCta')}</ButtonText>
            </Button>
        </Box>
    );

    // Surface copied from ArticleCardBase's FLAT branch — the one the Feed's
    // article cards actually render through (FeedRow passes `flat`). This card
    // previously copied the NON-flat branch, which is why it read as a different
    // kind of surface: `rounded-md` against its neighbours' `rounded-2xl`, and a
    // `Card` wrapper whose own padding stacked on top of the content padding.
    //
    // Two nested Boxes, and the nesting is load-bearing: RN drops a view's shadow
    // the moment that same view also sets `overflow: hidden`, so the shadow lives
    // on the outer, non-clipping Box and the rounded/clipped surface is the inner
    // one. The plate must hang off an UNPADDED box, and the opaque background has
    // to GO rather than sit under it — a solid fill painted over glass cancels
    // the effect entirely. Where glass does not paint (Android, iOS < 26) the
    // opaque `bg-background-0` comes back, exactly as ArticleCardBase does it.
    //
    // The radius is deliberately NOT variant-dependent: the user asked for the
    // suggestion cards' corners, and `rounded-2xl` reads correctly at both
    // scales. Only the SIZE responds to `compact`.
    return (
        <Box
            testID="all-caught-up-card"
            className={`${compact ? 'mb-3' : 'mb-4'} rounded-2xl shadow-hard-2`}
        >
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

export default AllCaughtUpCard;
