// The read hold's ONE upgrade button, the same on every surface that shows it
// (the Feed counts card's level 1, the not-read tail's block, the Settings
// usage card): "Try Individual free for 7 days" when the store says this
// reader can have the trial, else "See plans". Either opens the store paywall
// (`presentFreeTierPaywall`, which takes the purchase hold and refreshes
// billing, so a plan rise lifts the hold).
//
// It renders only while the hold is on and the reader is not on Professional
// (`useUpgradeFrom`). On this phone is never held, so it never shows there.
// Nothing shows before the hold (owner): no near-limit nudge.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { useTrialOffer } from '@/lib/subscription/trial-offer';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useReadHeld } from '@/components/custom/cards/use-read-held';

/** Required at call time: the paywall path reaches Apollo and the billing
 *  service, which must not load with the Feed list (the card-graph rule). */
function openPaywall(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { presentFreeTierPaywall } = require('@/lib/subscription/present-free-tier-paywall') as typeof import('@/lib/subscription/present-free-tier-paywall');
    void presentFreeTierPaywall('feed-read-hold');
}

/** The plan the held reader would move up from, or null when no upgrade is
 *  offered (not held, or already on Professional). The server's tier wins
 *  over RevenueCat's (the server meters the reading). */
export function useUpgradeFrom(): 'starter' | 'individual' | null {
    const { held } = useReadHeld();
    const tier = useSubscriptionStore((s) => s.serverTier ?? s.tier);
    if (!held || tier === 'professional') return null;
    return tier === 'individual' ? 'individual' : 'starter';
}

interface Props {
    readonly testID: string;
    readonly align?: 'start' | 'center';
}

/** Gated here, so the store is asked about the trial only once a hold is on. */
const ReadHoldUpgradeButton: React.FC<Props> = (props) => {
    const from = useUpgradeFrom();
    return from ? <UpgradeButton {...props} from={from} /> : null;
};

const UpgradeButton: React.FC<Props & { from: 'starter' | 'individual' }> = ({ testID, align = 'start', from }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const trial = useTrialOffer();
    // A reader already on Individual is past its trial, whatever the store cache says.
    const label =
        trial && from === 'starter'
            ? t('feed.readHold.tryIndividual', { count: trial.trialDays })
            : t('feedStatus.seePlans');
    return (
        <Pressable
            onPress={openPaywall}
            accessibilityRole="button"
            accessibilityLabel={label}
            testID={testID}
            style={{ alignSelf: align === 'center' ? 'center' : 'flex-start' }}
        >
            {/* Static style on an inner View: a function style on a Pressable is dropped on device. */}
            <View
                style={{
                    minHeight: 44,
                    justifyContent: 'center',
                    paddingHorizontal: 18,
                    borderRadius: 999,
                    backgroundColor: colors.accent,
                }}
            >
                <Text style={{ color: colors.onAccent, fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{label}</Text>
            </View>
        </Pressable>
    );
};

export default ReadHoldUpgradeButton;
