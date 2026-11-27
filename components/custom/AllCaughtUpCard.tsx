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
    /** The Feed's states (D5/D18). Omitted: the legacy footer / divider above.
     *  label: the "Good to know" section label over the first row below the fold.
     *  end: the terminal card, Refresh always kept. reading: the quiet line while
     *  the session's first run is still processing. */
    readonly variant?: 'label' | 'end' | 'reading';
    /** label: the seen stories' label, drawn over the first seen row below the fold. */
    readonly seen?: boolean;
    /** end: picks were held back while the reader read; adds the held line above Refresh. */
    readonly held?: boolean;
}

const AllCaughtUpCardBody: React.FC<AllCaughtUpCardProps> = ({
    title,
    body,
    testID = 'all-caught-up-card',
    onRefresh,
    refreshing = false,
    action,
    variant,
    seen = false,
    held = false,
}) => {
    const { t } = useTranslation();
    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every 3s, only while someone is looking: tabs
    // stay mounted, and a hidden Feed footer re-rendering forever costs a
    // render and a native mount every tick on every other tab.
    const animationsActive = useAnimationsActive();
    // Lite / Reduce Motion: the first message stays; nothing cycles.
    const motion = useMotionAllowed();
    const cycling = !variant && title === undefined && body === undefined;
    useEffect(() => {
        if (!animationsActive || !motion || !cycling) return;
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length, animationsActive, motion, cycling]);
    const bodyText = variant === 'end' ? messages[0] : cycling ? messages[currentIndex] : body;

    if (variant === 'label') {
        return (
            <Box testID={testID} className="px-4 pt-2 pb-3">
                <Text
                    testID={seen ? 'fold-seen-label' : 'fold-label'}
                    accessible
                    accessibilityRole="header"
                    size="sm"
                    className="text-ink-3 font-semibold"
                >
                    {t(seen ? 'feed.fold.seenLabel' : 'feed.fold.label')}
                </Text>
            </Box>
        );
    }
    if (variant === 'reading') {
        return (
            <Box testID={testID} className="px-4 py-6 items-center">
                <Text size="sm" className="text-ink-3 text-center">
                    {t('feed.fold.stillReading')}
                </Text>
            </Box>
        );
    }

    const isEnd = variant === 'end';
    const headline = isEnd ? t('feed.fold.endTitle') : (title ?? t('feed.allCaughtUp'));
    const lead = isEnd ? t('feed.fold.endBody') : null;
    const refreshButton = onRefresh ? (
        <Button action="primary" onPress={onRefresh} isDisabled={refreshing} testID="all-caught-up-refresh">
            {refreshing ? <ButtonSpinner /> : null}
            <ButtonText>{t('feed.refreshFeedAction')}</ButtonText>
        </Button>
    ) : null;

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
                {headline}
            </Text>

            {lead ? (
                <Text size="sm" className="text-ink-2 text-center mb-2" testID="all-caught-up-lead">
                    {lead}
                </Text>
            ) : null}

            {isEnd && bodyText ? (
                <Text size="sm" className="text-ink-3 text-center mb-3" testID="all-caught-up-mindful">
                    {bodyText}
                </Text>
            ) : null}

            {isEnd && held ? (
                <Box className="items-center mb-4" style={{ gap: 12 }}>
                    <Text testID="fold-held-line" size="sm" className="text-ink text-center">
                        {t('feed.fold.held')}
                    </Text>
                    {refreshButton}
                </Box>
            ) : isEnd && refreshButton ? (
                <Box className="items-center mb-4">{refreshButton}</Box>
            ) : null}

            {!variant && onRefresh ? (
                <Box className="items-center mb-4" style={{ gap: 12 }}>
                    <Text size="md" className="text-ink text-center">
                        {t('feed.readyForMore')}
                    </Text>
                    {refreshButton}
                </Box>
            ) : null}

            {/* Cycling mindfulness message — the "put the phone down" nudge. */}
            {bodyText && !isEnd ? (
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

// Keyed by variant: the footer swaps reading / end in place, and the variants differ in style shape
// (shadow, plate). A style that gains a CSS variable after its first render trips react-native-css-interop's
// dev-only upgrade warning, which stringifies navigation props and crashes the Feed. A fresh mount per variant
// keeps every instance's shape fixed from its first render.
const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = (props) => (
    <AllCaughtUpCardBody key={props.variant ?? 'footer'} {...props} />
);

export default AllCaughtUpCard;
