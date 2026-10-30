import { useMotionAllowed } from '@/lib/motion-gate';
import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

/**
 * The Feed's end-of-list footer, under real cards: card scale, the Mera mark
 * STILL (nothing on the Feed moves unless the feed is updating). An EMPTY
 * Feed never shows it: the empty chain shows the counts card and the
 * shortcuts instead (FinalFeed "Feed, empty after a long gap").
 *
 * The same card is the ONE divider between Mera's picks and the articles Mera
 * has not read (owner, R4): `title` replaces the headline, and with a title
 * and no `body` the cycling message is left out.
 */
interface AllCaughtUpCardProps {
    readonly title?: string;
    readonly body?: string;
    readonly testID?: string;
    /** The footer only: "Are you ready to read more?" and a button that does exactly what
     *  pull-to-refresh does (owner, 2026-10-21: after a cache clear the feed did not grow
     *  until a pull, so the footer was a dead end). */
    readonly onRefresh?: () => void;
    readonly refreshing?: boolean;
    /** The not-read divider while the read hold is on: the upgrade button, under the body. */
    readonly action?: React.ReactNode;
}

const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = ({ title, body, testID = 'all-caught-up-card', onRefresh, refreshing = false, action }) => {
    const { t } = useTranslation();

    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every 3s, only while someone is looking: tabs
    // stay mounted, and a hidden Feed footer re-rendering forever costs a
    // render and a native mount every tick on every other tab.
    const animationsActive = useAnimationsActive();
    // Lite / Reduce Motion: the first message stays; nothing cycles.
    const motion = useMotionAllowed();
    const cycling = title === undefined && body === undefined;
    useEffect(() => {
        if (!animationsActive || !motion || !cycling) return;
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length, animationsActive, motion, cycling]);
    const bodyText = cycling ? messages[currentIndex] : body;

    // `px-4` mirrors ArticleCardBase's own content padding, so the
    // text column starts on the same vertical line as every neighbouring card's.
    // NOTE none of these Texts sets `numberOfLines` — long translations wrap and
    // grow the card rather than clipping.
    const innerContent = (
        <Box className="w-full py-8 px-4 items-center justify-center">
            {/* STILL: a loop here would run at the bottom of every feed. */}
            <Box className="mb-3">
                <MeraLogo size={64} animated={false} />
            </Box>

            <Text
                testID="all-caught-up-headline"
                size="lg"
                className="text-ink text-center font-semibold mb-2"
            >
                {title ?? t('feed.allCaughtUp')}
            </Text>

            {onRefresh ? (
                <Box className="items-center mb-4" style={{ gap: 12 }}>
                    <Text size="md" className="text-ink text-center">
                        {t('feed.readyForMore')}
                    </Text>
                    <Button action="primary" onPress={onRefresh} isDisabled={refreshing} testID="all-caught-up-refresh">
                        {refreshing ? <ButtonSpinner /> : null}
                        <ButtonText>{t('feed.refreshFeedAction')}</ButtonText>
                    </Button>
                </Box>
            ) : null}

            {/* Cycling mindfulness message — the "put the phone down" nudge. */}
            {bodyText ? (
                <Text size="sm" className="text-ink-2 text-center">
                    {bodyText}
                </Text>
            ) : null}

            {action ? <Box className="mt-4">{action}</Box> : null}

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
            testID={testID}
            className="mb-3 rounded-2xl shadow-hard-2"
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
