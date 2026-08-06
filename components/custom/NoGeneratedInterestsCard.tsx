import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { router } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

const NoGeneratedInterestsCard: React.FC = () => {
    const { t } = useTranslation();

    // The card's whole message is "create your user persona", and the persona
    // lives on Profile — so the card itself is the affordance rather than
    // asking the user to work out which tab that means. `navigate`, not `push`:
    // Profile is a TAB, and pushing it would stack a second copy on top of the
    // tab the user can already reach from the bar (the same reason
    // FeedPreparingCard and AllCaughtUpCard navigate to Explore).
    const openProfile = useCallback(() => {
        router.navigate('/logged-in/app_container/profile');
    }, []);

    const innerContent = (
        <Box className="w-full py-20 px-6 items-center justify-center">
            {/* `animated`: MeraLogo's own spotlight sweep, self-gated on focus +
                foreground (useAnimationsActive), matching FreeTierCard and
                MeraChatInvite. This card is a terminal state that can sit on
                screen indefinitely, which is exactly where a still logo reads
                as a dead end. */}
            <Box className="mb-6">
                <MeraLogo size={100} animated />
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

    // Surface copied from ArticleCardBase's FLAT branch — the one the Feed's
    // article cards actually render through — via AllCaughtUpCard, which is the
    // reference implementation for every list-level card. This card used to copy
    // the NON-flat branch, so it read as a different kind of surface: `rounded-md`
    // against its neighbours' `rounded-2xl`, no shadow, and a `Card` wrapper whose
    // own `p-4` stacked on top of the content's `py-20 px-6` — 40px of horizontal
    // padding where 24 was intended.
    //
    // Two nested Boxes, and the nesting is load-bearing: RN drops a view's shadow
    // the moment that same view also sets `overflow: hidden`, so the shadow lives
    // on the outer, non-clipping Box and the rounded/clipped surface is the inner
    // one. The plate must hang off an UNPADDED box, and the opaque background has
    // to GO rather than sit under it — a solid fill painted over glass cancels the
    // effect entirely. Where glass does not paint, the opaque `bg-background-0`
    // comes back (NOT the old `bg-black border-black`, which no other card uses).
    // The outer node is a Pressable rather than a Box so the whole card is the
    // target — but it keeps the SAME testID and className, because
    // status-cards.test.tsx pins this element's surface classes (rounded-2xl,
    // shadow-hard-2, and NOT overflow-hidden) and reads them off the testID.
    return (
        <Pressable
            testID="no-interests-card"
            onPress={openProfile}
            className="mb-4 rounded-2xl shadow-hard-2"
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
        </Pressable>
    );
};

export default NoGeneratedInterestsCard;
