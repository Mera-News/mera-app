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

/**
 * WHICH boundary this card is marking.
 *
 *  - `seen` — the Feed's FIRST divider: everything below has been seen but not
 *    read.
 *  - `read` — the Feed's SECOND divider: everything below has been read.
 *  - `end`  — the end of the list. No boundary to name; the card exists purely
 *    to say "that's everything" and to nudge the user off the phone.
 *
 * `end` is the DEFAULT so the end-of-list footer and the three full-screen
 * empty states need no variant at all — the user's "the basic all caught up
 * card, with no props".
 */
export type AllCaughtUpVariant = 'seen' | 'read' | 'end';

/** The one line that differs per variant. `end` has none — it is the terminal
 *  card, and there is no boundary below it to describe.
 *
 *  `as const` is load-bearing, not decoration: `t` is typed against the literal
 *  union of keys generated from en.json, so a widened `string` here does not
 *  type-check. This way a typo'd or deleted key is a compile error rather than
 *  the raw key path rendering on a device. */
const BOUNDARY_KEY = {
    seen: 'feed.divider.seenLine',
    read: 'feed.divider.readLine',
    end: null,
} as const satisfies Record<AllCaughtUpVariant, string | null>;

interface AllCaughtUpCardProps {
    /**
     * Which boundary this instance marks. ONE component, three variants, and
     * exactly ONE line of copy differs between them — the headline, the cycling
     * mindfulness nudge and the Explore CTA are identical everywhere.
     *
     * Deliberately NOT a free-text `subtitle` prop (which this replaced): with
     * both a variant and a subtitle there would be two ways to say the same
     * thing, and the two would drift. The boundary copy is resolved from
     * `BOUNDARY_KEY` here, so every call site naming the same boundary is
     * guaranteed to render the same words.
     */
    variant?: AllCaughtUpVariant;
    /**
     * Render at CARD scale — sized to sit in the feed among the article cards
     * rather than as a full-width panel.
     *
     * ORTHOGONAL to `variant`, and opt-IN. The call sites split two ways: three
     * are rows inside the Feed list (both dividers and the end-of-list footer,
     * all `compact`), and three are terminal EMPTY STATES — the Feed's own
     * `renderEmpty`, `for-you/FactFeedScreen`, and `for-you/ForYouScreen` —
     * where the card is the entire screen and its presence is the point.
     * Shrinking those would leave a small card marooned in a blank screen.
     * Making `compact` opt-in means the three empty states keep their current
     * size with no edit at all. So the footer is `end` + compact, and the empty
     * states are `end` + roomy: same words, different scale.
     */
    compact?: boolean;
}

const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = ({
    variant = 'end',
    compact = false,
}) => {
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

    const boundaryKey = BOUNDARY_KEY[variant];
    const boundaryLine = boundaryKey ? t(boundaryKey) : null;

    // `px-4` in compact mirrors ArticleCardBase's own content padding, so the
    // text column starts on the same vertical line as every neighbouring card's.
    // NOTE none of these Texts sets `numberOfLines` — long translations wrap and
    // grow the card rather than clipping. The worst cases in the locale files are
    // de `allCaughtUp` (60 chars), fr `mindfulness` (60) and de `exploreCta`
    // (21, inside an auto-sizing Button); all wrap to at most two lines here. The
    // boundary line is ~46-49 chars in en and German runs ~1.4x, so expect three
    // lines there — it grows the card, which is the intended trade for not
    // truncating a line that explains what the boundary means.
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

            {/* "You're all caught up" text. IDENTICAL in all three variants — this
                is one card shown in three places, not three cards, and the user
                asked for exactly one line to differ. */}
            <Text
                size={compact ? 'lg' : 'xl'}
                className={`text-white text-center font-semibold ${compact ? 'mb-2' : 'mb-4'}`}
            >
                {t('feed.allCaughtUp')}
            </Text>

            {/* The boundary line is FUNCTIONAL — it names which divider this is and what
                the rows below it are — while the mindfulness line below is decorative and
                cycles every 3s. Rendered at the same weight they read as equal-weight
                siblings and the user cannot tell which one is telling them something
                structural (observed on device). So the boundary line leads: brighter and
                medium weight, with the cycling line receding beneath it. Keep the two
                visually distinct; do not collapse them back to one class. */}
            {boundaryLine ? (
                <Text
                    size="sm"
                    className={`text-typography-200 font-medium text-center ${compact ? 'mb-2' : 'mb-4'}`}
                >
                    {boundaryLine}
                </Text>
            ) : null}

            {/* Cycling mindfulness message — the "put the phone down" nudge, and it renders
                in EVERY variant, which is the user's explicit instruction. Dimmer than the
                boundary line when one is present; the `end` variant has no boundary line,
                so there it is the primary line and its appearance is unchanged from before
                the variants existed. */}
            <Text
                size={compact ? 'sm' : 'md'}
                className={boundaryLine ? 'text-typography-500 text-center' : 'text-gray-400 text-center'}
            >
                {messages[currentIndex]}
            </Text>

            {/* Explore CTA — in ALL variants, deliberately. Gating it to `end` was
                considered and rejected: the footer only renders when NOTHING below the
                pin boundary has been seen (`caughtUpIsFooter: !seenDivider`) and the
                empty states only when the feed is empty, so on a normal populated feed
                — the common case, where divider #1 is spliced in-list — a gated CTA
                would leave the screen with no Explore affordance at all. It is also the
                second thing that would differ per variant, and the user asked for one. */}
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
    //
    // NOTE `all-caught-up-card` is no longer unique within one Feed render — both
    // dividers can be in-list at once, so two nodes carry it. The wrapper testIDs
    // (`feed-divider-caught-up` / `feed-divider-opened` / `feed-caught-up-footer`
    // in FeedScreen) are what disambiguate for the simulator harness.
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
