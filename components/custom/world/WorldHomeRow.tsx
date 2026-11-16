// World's leading row: "Want news from where you live?" with the one-tap home chip. Only for a reader with no
// facts, no place and no home (D21); the chip itself hides on a home fact or home location, so a tap removes the row.
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useHasFactsOrPlaces } from '@/components/custom/for-you/use-has-facts-or-places';
import { HomeCountryChip } from '@/components/custom/home-country-chip/HomeCountryChip';
import { useHasHomeFact } from '@/components/custom/home-country-chip/home-fact';
import { useHomeCountryChip } from '@/components/custom/home-country-chip/useHomeCountryChip';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';

const WorldHomeRow: React.FC = () => {
    const { t } = useTranslation();
    const c = useColors();
    const hasFactsOrPlaces = useHasFactsOrPlaces();
    const hasHome = useHasHomeFact();
    const { country } = useHomeCountryChip();
    if (hasFactsOrPlaces !== false || hasHome !== false || !country) return null;
    return (
        <View testID="world-home-row" style={{ gap: 8, alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ color: c.ink2, fontSize: 14, lineHeight: 19 }} className="text-center">
                {t('world.homeRow')}
            </Text>
            <HomeCountryChip testID="world-home-chip" />
        </View>
    );
};

export default WorldHomeRow;
