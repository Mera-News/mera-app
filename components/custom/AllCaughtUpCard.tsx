import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import type { ImportanceThreshold } from '@/lib/feed-ordering/importance-filter';
import { router } from 'expo-router';
import LottieView from 'lottie-react-native';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'react-native-reanimated';
import { gameAnimationFor } from '@/components/custom/game-ui/animation-registry';
import { PROCESSING_SCENE_SIZE } from '@/components/custom/processing/types';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import MeraLogo from './MeraLogo';

/**
 * The end-of-list "you're all caught up" card. Used at SIX call sites: the
 * Feed's end-of-list footer, and the empty state of the Feed, FactFeedScreen,
 * and ForYouScreen.
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
     * `compact`, and the three terminal EMPTY STATES — the Feed's own
     * `renderEmpty`, `for-you/FactFeedScreen`, and `for-you/ForYouScreen` —
     * are roomy, where the card is the entire screen and its presence is the
     * point. Shrinking those would leave a small card marooned in a blank
     * screen.
     */
    compact?: boolean;
    /**
     * The Feed's current minimum-importance threshold. Passed ONLY by
     * FeedScreen — the other three call sites (FactFeedScreen and
     * ForYouScreen's empty states, and the Feed's own loading state) pass
     * neither this nor `onLowerPriority`, and keep the Explore CTA unchanged.
     * Deliberately not read from the store directly: FactFeedScreen and
     * ForYouScreen filter by `dashboardThreshold`, have no collapsible header,
     * and have no `reveal()` to call, so a store-driven CTA here would render
     * a dead button on screens this card doesn't own.
     */
    feedThreshold?: ImportanceThreshold;
    /**
     * Present together with `feedThreshold`. Called when the user taps the
     * "lower the feed priority" CTA — the caller is expected to reveal the
     * (possibly collapsed) header and draw attention to the priority filter
     * chip, e.g. with a brief pulse; this component only renders the button.
     */
    onLowerPriority?: () => void;
}

const AllCaughtUpCard: React.FC<AllCaughtUpCardProps> = ({
    compact = false,
    feedThreshold,
    onLowerPriority,
}) => {
    const { t } = useTranslation();

    // Two different questions, both asked, the same pair `use-processing-
    // snapshot.ts` already resolves for the processing card.
    //
    //  - `isStatic` is the reader's standing PREFERENCE: OS Reduce Motion, or
    //    the app's own "Static background", which already defaults ON below
    //    6 GB of RAM. Answered with a held frame 0, never an empty box, because
    //    on a large share of the fleet that frozen frame is the NORMAL
    //    rendering rather than a rare degradation. `game-hud-idle` is authored
    //    for it: both its layers are lit at frame 0 and its dim outer ring is
    //    constant across all 96 frames, so the held frame is the complete
    //    composition at its resting brightness.
    //  - `animationsActive` is whether anyone is LOOKING. Tabs stay mounted, so
    //    an ungated loop runs forever behind whatever the reader walked off to.
    //    `use-is-focused-safe.ts`'s header warns against gating something that
    //    conveys liveness of an in-flight operation on a NARROWER predicate;
    //    this one is false only when the screen is blurred or the app is
    //    backgrounded, and this card means the exact opposite of in-flight.
    const reduceMotion = useReducedMotion();
    const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
    const animationsActive = useAnimationsActive();
    const idlePlaying = animationsActive && !(reduceMotion || staticGradient);

    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every second
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length]);

    // There's nothing to lower once the threshold is already at its floor —
    // in that case the CTA falls back to Explore, same as every call site that
    // passes neither prop at all.
    const showLowerPriorityCta =
        !!onLowerPriority && feedThreshold != null && feedThreshold !== 'low';

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
            {/* The idle scene, on the ROOMY branch only.

                It is drawn at PROCESSING_SCENE_SIZE because FeedProcessingCard
                draws its stage scene at that size and at the same offset from
                the card top. The two cards never render at once: they swap the
                moment a sync starts. Matching the number means the swap does
                not make the scene jump, and a jump there would read as the card
                breaking rather than as work beginning. Imported from
                processing/types.ts rather than from the hook file, which drags
                FeedSyncIndicator and the WatermelonDB singleton in with it;
                that is why the constants live in types.ts at all.

                The COMPACT branch keeps the Mera mark and is deliberately
                untouched. That branch is the Feed's end-of-list footer, so an
                idle loop there runs at the bottom of every feed forever, next
                to a logo whose own file already calls its sweep the expensive
                permanent one. A cost with no reader. */}
            <Box className={compact ? 'mb-3' : 'mb-6'}>
                {compact ? (
                    <MeraLogo size={64} animated />
                ) : (
                    <Box
                        testID="all-caught-up-idle-scene"
                        style={{
                            width: PROCESSING_SCENE_SIZE,
                            height: PROCESSING_SCENE_SIZE,
                        }}
                    >
                        <LottieView
                            source={gameAnimationFor('game-hud-idle') as never}
                            autoPlay={idlePlaying}
                            progress={idlePlaying ? undefined : 0}
                            loop
                            renderMode="AUTOMATIC"
                            resizeMode="contain"
                            style={{ flex: 1 }}
                        />
                    </Box>
                )}
            </Box>

            <Text
                testID="all-caught-up-headline"
                size={compact ? 'lg' : 'xl'}
                className={`text-white text-center font-semibold ${compact ? 'mb-2' : 'mb-4'}`}
            >
                {t('feed.allCaughtUp')}
            </Text>

            {/* Cycling mindfulness message — the "put the phone down" nudge. */}
            <Text
                size={compact ? 'sm' : 'md'}
                className="text-gray-400 text-center"
            >
                {messages[currentIndex]}
            </Text>

            {/* CTA — Explore by default. When the Feed's importance threshold is
                above its floor, this becomes a nudge to lower it instead: there is
                more to read, it's just filtered out, and Explore isn't the answer
                to that. `onLowerPriority` owns revealing the header and drawing
                attention to the priority chip; this button only decides WHICH
                action to offer. */}
            {showLowerPriorityCta ? (
                <Button
                    testID="all-caught-up-lower-priority-cta"
                    variant="outline"
                    action="secondary"
                    size="sm"
                    className={compact ? 'mt-4' : 'mt-6'}
                    onPress={onLowerPriority}
                >
                    <ButtonText>{t('feed.lowerPriorityCta')}</ButtonText>
                </Button>
            ) : (
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
            )}
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
