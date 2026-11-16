// Step 1's way forward when the chip is not enough: the inline "where do you live" picker. It saves a home
// location AND the same kind of fact the chip writes, so the wizard's fact gate opens.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import countries from 'i18n-iso-countries';

import AddLocationView from '@/components/custom/locations/AddLocationView';
import type { ChosenPlace } from '@/components/custom/locations/useAddLocation';
import { Text } from '@/components/ui/text';
import { getCountryName } from '@/lib/algorithms/country-utils';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';

/** A turn with no answer for this long is "taking a while". */
export const SLOW_TURN_MS = 8_000;

/**
 * True when step 1 should offer the picker: at once when chat cannot run (on this phone, blocked), on a
 * failed turn, or after a turn has been active for SLOW_TURN_MS. A slow turn that settles gives the thread
 * back (the wizard keeps the chat mounted underneath), so a fact card it offers stays reachable. Never while a fact or topic card waits to be answered.
 */
export function useHomePickerOffer({ chatUnavailable, unresolved }: { chatUnavailable: boolean; unresolved: boolean }): boolean {
    const failed = useCloudChatStore((s) => !!s.error);
    const active = useCloudChatStore((s) => s.status === 'streaming' || s.agentTurnState?.turnActive === true);
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        if (!active) {
            setSlow(false);
            return;
        }
        const id = setTimeout(() => setSlow(true), SLOW_TURN_MS);
        return () => clearTimeout(id);
    }, [active]);
    if (chatUnavailable) return true;
    return !unresolved && (failed || slow);
}

/** 'slow' = a turn is slow or failed; 'unavailable' = chat cannot answer at all (on this phone, blocked). */
export function HomePickerFallback({ onClose, reason = 'slow' }: { onClose?: () => void; reason?: 'slow' | 'unavailable' }) {
    const { t } = useTranslation();
    const onSaved = async (place: ChosenPlace) => {
        const a3 = countries.alpha2ToAlpha3(place.countryCode);
        const country = a3 ? getCountryName(a3) : place.countryCode;
        await commitFactChoices([
            {
                statement: place.city ? `Lives in ${place.city}, ${country}` : `Lives in ${country}`,
                questionnaire: { attribute: CANONICAL_LOCATION_KEY },
                skillId: 'topics/residence',
            },
        ]);
    };
    return (
        <View style={{ flex: 1 }} testID="onboarding-home-picker">
            {/* Chat that cannot answer is not "taking a while": the zero block's hint above already says what to do. */}
            {reason === 'slow' ? (
                <Text size="sm" className="text-ink-2 text-center px-5 pt-2">
                    {t('onboarding.fallbackPick')}
                </Text>
            ) : null}
            <AddLocationView fixedRole="home" onClose={onClose ?? (() => undefined)} onSaved={onSaved} renderIdle={() => null} />
        </View>
    );
}
