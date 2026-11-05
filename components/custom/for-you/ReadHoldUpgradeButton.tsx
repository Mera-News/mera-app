// The read hold's ONE upgrade button, the same on every surface that shows it
// (the Feed counts card's level 1, the not-read tail's block, the Settings
// usage card): "Try Individual free for 14 days" when the store says this
// reader can have the trial, else "See plans". Either opens Manage plan, the
// only page that presents the paywall (owner): it also holds Redeem a code.
//
// It renders only while the hold is on and the reader is not on Professional
// (`useUpgradeFrom`). On this phone is never held, so it never shows there.
// Nothing shows before the hold (owner): no near-limit nudge.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { router } from 'expo-router';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { tierMultiplier } from '@/lib/subscription/plan-rise';
import { useTrialOffer } from '@/lib/subscription/trial-offer';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useReadHeld } from '@/components/custom/cards/use-read-held';

/** The plan the held reader would move up from, or null when no upgrade is
 *  offered (not held, already on Professional, or the store already sold a
 *  higher plan the server has not confirmed yet, so the upgrade is not offered
 *  a second time while the hold waits to lift). The server's tier wins over
 *  RevenueCat's (the server meters the reading). */
export function useUpgradeFrom(): 'starter' | 'individual' | null {
    const { held } = useReadHeld();
    const tier = useSubscriptionStore((s) => s.serverTier ?? s.tier);
    const awaitingServer = useSubscriptionStore((s) => tierMultiplier(s.tier) > tierMultiplier(s.serverTier));
    if (!held || awaitingServer || tier === 'professional') return null;
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
            onPress={() => router.push('/logged-in/preferences/manage-subscription')}
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
