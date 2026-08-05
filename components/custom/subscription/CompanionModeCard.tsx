import {
    CARDS_USE_GLASS,
    CardGlassPlate,
} from '@/components/custom/cards/CardGlassPlate';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { presentCompanionPaywall } from '@/lib/subscription/present-companion-paywall';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Which list this card is pinned to. Diagnostics + testID only — copy is shared. */
export type CompanionSurface = 'dashboard' | 'feed' | 'stories' | 'facts';

export interface CompanionModeCardProps {
    readonly surface: CompanionSurface;
    /** Tighter padding for a list that is already dense. */
    readonly compact?: boolean;
    /** Defaults to presenting the RevenueCat paywall. */
    readonly onSeePlans?: () => void;
}

/**
 * The one big card that explains companion mode, pinned to the TOP of the
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
 * Surface structure is copied from NoGeneratedInterestsCard: two nested Boxes,
 * and the nesting is load-bearing — RN drops a view's shadow the moment that
 * same view sets `overflow: hidden`, so the shadow lives on the outer,
 * non-clipping Box and the rounded/clipped surface is the inner one. No blur
 * infra is introduced; `CardGlassPlate` is a translucent fill, not a GlassView.
 */
const CompanionModeCard: React.FC<CompanionModeCardProps> = ({
    surface,
    compact = false,
    onSeePlans,
}) => {
    const { t } = useTranslation();
    const aiAccess = useAiAccess();

    const handleSeePlans = useCallback(async () => {
        if (onSeePlans) {
            onSeePlans();
            return;
        }
        await presentCompanionPaywall('CompanionModeCard');
    }, [onSeePlans]);

    if (aiAccess !== 'locked') return null;

    return (
        <Box
            testID={`companion-card-${surface}`}
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
                <Box
                    className={`w-full items-center ${compact ? 'py-6 px-5' : 'py-10 px-6'}`}
                >
                    <Box className={compact ? 'mb-3' : 'mb-5'}>
                        <MeraLogo size={compact ? 56 : 84} />
                    </Box>

                    <Text
                        size={compact ? 'lg' : 'xl'}
                        className="text-white text-center mb-3 font-semibold"
                    >
                        {t('companion.cardTitle')}
                    </Text>

                    <Text size="md" className="text-gray-400 text-center">
                        {t('companion.cardBody')}
                    </Text>

                    <Button
                        testID="companion-card-cta"
                        onPress={handleSeePlans}
                        className="bg-primary-500 mt-6"
                        size="md"
                    >
                        <ButtonText className="text-white">
                            {t('companion.seePlans')}
                        </ButtonText>
                    </Button>
                </Box>
            </Box>
        </Box>
    );
};

export default CompanionModeCard;
