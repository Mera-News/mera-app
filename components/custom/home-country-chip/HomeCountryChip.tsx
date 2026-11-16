import React from 'react';
import { Pressable, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { getFlagEmoji } from '@/lib/algorithms/country-utils';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors } from '@/lib/theme/tokens';
import countries from 'i18n-iso-countries';
import { homeChipLabel, useHomeCountryChip } from './useHomeCountryChip';

/** One tap saves "Lives in {country}" as the reader's home fact. Renders nothing when there is no country to offer;
 *  the caller decides where the chip belongs. The text wraps at large Dynamic Type, never truncates. */
export function HomeCountryChip({ testID = 'home-country-chip', onSaved }: { testID?: string; onSaved?: (factId: string) => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    const appLanguage = useAppLanguage();
    const { country, status, save } = useHomeCountryChip(onSaved);
    if (!country) return null;
    const text = homeChipLabel(t as never, country.alpha2, country.label, appLanguage);
    const flag = getFlagEmoji(countries.alpha2ToAlpha3(country.alpha2));
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={text}
            accessibilityState={{ busy: status === 'saving' }}
            onPress={() => void save()}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'center',
                gap: 8,
                minHeight: 44,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: colors.line,
                backgroundColor: colors.surface,
                opacity: status === 'saving' ? 0.7 : 1,
            }}
        >
            {flag ? <Text accessible={false}>{flag}</Text> : null}
            <Text style={{ color: colors.ink, flexShrink: 1, fontSize: 16 }}>{text}</Text>
        </Pressable>
    );
}
