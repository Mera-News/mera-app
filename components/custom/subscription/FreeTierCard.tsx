import GlassPanel from '@/components/custom/cards/GlassPanel';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Which list this card is pinned to. Diagnostics + testID only — copy is shared. */
export type FreeTierSurface = 'dashboard' | 'feed' | 'stories' | 'facts';

export interface FreeTierCardProps {
    readonly surface: FreeTierSurface;
    /** Tighter padding for a list that is already dense. */
    readonly compact?: boolean;
    /** Defaults to presenting the RevenueCat paywall. */
    readonly onSeePlans?: () => void;
}

/**
 * The one big card that explains Mera News Free, pinned to the TOP of the
 * Dashboard/Feed list.
 *
 * It is a HEADER, never an empty state. Everything already on the device keeps
 * rendering underneath it, scrollable and tappable — that is the whole promise
 * of this mode, and replacing the list would break it. The existing
 * `renderEmpty()` chains are untouched: once the cached rows genuinely age out
 * via the normal TTL sweep, this card sitting above an ordinary empty list is
 * the correct end state, needing no new branch.
 *
 * Reads `useAiAccess()` itself and renders `null` unless locked, so callers can
 * mount it unconditionally and cannot forget the check. `'unknown'` renders
 * nothing — flashing this at a paying subscriber during the first second of a
 * cold start would be worse than showing it a second late.
 *
 * The chrome (two-Box shadow/clip trick, translucent fill) is `GlassPanel` —
 * see that file for why it's built the way it is. This component owns only
 * the copy and the actions.
 *
 * That copy is the same "Free isn't free" argument `NotSubscribedScreen`
 * makes, not the old one-line pitch: `subscription.title` + `para1` + `para2`
 * + `para3NoTrial` (never `para3Trial` — this card never imports
 * `getTrialAvailability`, so it cannot disagree with `NotSubscribedScreen`
 * about whether a trial is on offer, and lands with zero order dependency on
 * whichever surface removes trial copy). It reads longer as a result —
 * MEASURED on an iPhone 17 Pro: the single-paragraph version was 306.67pt →
 * 401.33pt (+30.9%) for adding just ONE more paragraph, and this adds two
 * more plus a heading and a second button on top of that. The mitigation for
 * that height, if the list needs it, is the existing `compact` prop — not
 * trimming this copy back down.
 */
const FreeTierCard: React.FC<FreeTierCardProps> = ({
    surface,
    compact = false,
    onSeePlans,
}) => {
    const { t } = useTranslation();
    const router = useRouter();
    const aiAccess = useAiAccess();

    const handleSeePlans = useCallback(async () => {
        if (onSeePlans) {
            onSeePlans();
            return;
        }
        await presentFreeTierPaywall('FreeTierCard');
    }, [onSeePlans]);

    const handleLearnMore = useCallback(() => {
        router.push('/tutorials' as any);
    }, [router]);

    if (aiAccess !== 'locked') return null;

    return (
        <GlassPanel
            testID={`free-tier-card-${surface}`}
            radius="2xl"
            logoSize={compact ? 56 : 84}
            className="mb-4"
            contentClassName={compact ? 'py-6 px-5' : 'py-10 px-6'}
        >
            <Heading size="2xl" className="text-white text-center">
                {t('subscription.title')}
            </Heading>

            <Text
                testID={`free-tier-card-body-${surface}`}
                size="md"
                className="text-gray-400 text-center leading-relaxed mt-3"
            >
                {t('subscription.para1')}
            </Text>
            <Text size="md" className="text-gray-400 text-center leading-relaxed mt-3">
                {t('subscription.para2')}
            </Text>
            <Text size="md" className="text-gray-400 text-center leading-relaxed mt-3">
                {t('subscription.para3NoTrial')}
            </Text>

            <Button
                testID="free-tier-card-cta"
                onPress={handleSeePlans}
                className="bg-primary-500 mt-6 rounded-full w-full"
                size="md"
            >
                <ButtonText className="text-white">
                    {t('freeTier.seePlans')}
                </ButtonText>
            </Button>

            <Button
                testID="free-tier-card-learn"
                onPress={handleLearnMore}
                variant="outline"
                className="w-full rounded-full border-white/30 mt-3"
                size="md"
            >
                <ButtonText className="text-white">
                    {t('tutorials.learnAboutMera')}
                </ButtonText>
            </Button>
        </GlassPanel>
    );
};

export default FreeTierCard;
