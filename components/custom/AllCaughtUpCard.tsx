import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import IdleScene from './IdleScene';
import MeraLogo from './MeraLogo';

/**
 * The end-of-list "you're all caught up" card: the Feed's end-of-list footer,
 * and the empty state of both Feed views (FeedScreen and InterestsPage).
 *
 * There used to be two MORE instances of this same card, spliced in-list at
 * each Feed attention-tier boundary (`variant="seen"` / `"read"`), each with
 * its own headline and instruction line. The user reported their position
 * wasn't reliable — a card that moves as new stories arrive and old ones sink
 * is a moving target — so both were removed; only the terminal footer/empty
 * card remains, everywhere.
 */
interface AllCaughtUpCardProps {
    /**
     * Render at CARD scale — sized to sit in the feed among the article cards
     * rather than as a full-width panel.
     *
     * The call sites split two ways: the Feed's end-of-list footer is
     * `compact`, and the two terminal EMPTY STATES (FeedScreen's and
     * `for-you/InterestsPage`'s) are roomy, where the card is the entire screen and its presence is the
     * point. Shrinking those would leave a small card marooned in a blank
     * screen.
     */
    compact?: boolean;
}

const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = ({ compact = false }) => {
    const { t } = useTranslation();

    // Two different questions, both asked, the same pair `use-processing-
    // snapshot.ts` already resolves for the processing card.
    //
    //  - `isStatic` is the reader's standing PREFERENCE: OS Reduce Motion, or
    //    the app's own "Static background", which already defaults ON below
    // The gating rationale for that scene moved to it: see IdleScene.tsx.

    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every 3s, only while someone is looking: tabs
    // stay mounted, and a hidden Feed footer re-rendering forever costs a
    // render and a native mount every tick on every other tab.
    const animationsActive = useAnimationsActive();
    useEffect(() => {
        if (!animationsActive) return;
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length, animationsActive]);

    // `px-4` in compact mirrors ArticleCardBase's own content padding, so the
    // text column starts on the same vertical line as every neighbouring card's.
    // NOTE none of these Texts sets `numberOfLines` — long translations wrap and
    // grow the card rather than clipping.
    const innerContent = (
        <Box
            className={
                compact
                    ? 'w-full py-8 px-4 items-center justify-center'
                    : 'w-full py-20 px-6 items-center justify-center'
            }
        >
            {/* The idle scene, on the ROOMY branch only. Size and gating both
                live in IdleScene.tsx, which FeedProcessingCard's fallback draws
                too; the number matters because these surfaces swap as a run
                starts and ends.

                The COMPACT branch keeps the Mera mark, STILL. That branch is
                the Feed's end-of-list footer, so any loop there runs at the
                bottom of every feed forever, and the owner's rule is that
                nothing on the Feed moves unless the feed is updating. */}
            <Box className={compact ? 'mb-3' : 'mb-6'}>
                {compact ? (
                    <MeraLogo size={64} animated={false} />
                ) : (
                    <IdleScene testID="all-caught-up-idle-scene" />
                )}
            </Box>

            <Text
                testID="all-caught-up-headline"
                size={compact ? 'lg' : 'xl'}
                className={`text-ink text-center font-semibold ${compact ? 'mb-2' : 'mb-4'}`}
            >
                {t('feed.allCaughtUp')}
            </Text>

            {/* Cycling mindfulness message — the "put the phone down" nudge. */}
            <Text
                size={compact ? 'sm' : 'md'}
                className="text-ink-2 text-center"
            >
                {messages[currentIndex]}
            </Text>

        </Box>
    );

    // Surface copied from ArticleCardBase's FLAT branch — the one the Feed's
    // article cards actually render through (FeedRow passes `flat`).
    //
    // Two nested Boxes, and the nesting is load-bearing: RN drops a view's shadow
    // the moment that same view also sets `overflow: hidden`, so the shadow lives
    // on the outer, non-clipping Box and the rounded/clipped surface is the inner
    // one. The plate must hang off an UNPADDED box, and the opaque background has
    // to GO rather than sit under it — a solid fill painted over glass cancels
    // the effect entirely. Where glass does not paint (Android, iOS < 26) the
    // opaque `bg-background-0` comes back, exactly as ArticleCardBase does it.
    return (
        <Box
            testID="all-caught-up-card"
            className={`${compact ? 'mb-3' : 'mb-4'} rounded-2xl shadow-hard-2`}
        >
            <Box
                className={
                    CARDS_USE_GLASS
                        ? 'rounded-2xl overflow-hidden border border-line'
                        : 'rounded-2xl overflow-hidden bg-background-0 border border-line'
                }
            >
                <CardGlassPlate />
                {innerContent}
            </Box>
        </Box>
    );
};

export default AllCaughtUpCard;
