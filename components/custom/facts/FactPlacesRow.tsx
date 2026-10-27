import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { setFactPlaces } from '@/lib/database/services/fact-service';
import { describePlace, factPlaces, parsePlace, placeLabel, PLACE_GLOBAL, type FactPlacesInput } from '@/lib/news-harness/persona-management/fact-places';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { CountryPickerSheet } from './CountryPickerSheet';

/** "About": where this fact's news should come from, one chip per place. */
export function FactPlacesRow({ factId, fact }: { factId: string; fact: FactPlacesInput }) {
    const { t } = useTranslation();
    const colors = useColors();
    const [picking, setPicking] = useState(false);
    const places = factPlaces(fact);
    const isAnywhere = places.includes(PLACE_GLOBAL);
    const write = (next: string[]) => void setFactPlaces(factId, next, 'user');

    const label = (place: string) => {
        const parsed = parsePlace(place);
        if (parsed?.level === 'global') return t('you.fact.places.anywhere');
        if (parsed?.level === 'bloc') return t(`you.fact.places.blocs.${parsed.bloc as NonNullable<typeof parsed.bloc>}` as const);
        return placeLabel(place) ?? place;
    };

    return (
        <View testID="fact-places-row" style={{ gap: 8 }}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('you.fact.places.about')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {places.length === 0 ? (
                    <Text style={{ color: colors.ink2, fontSize: 14 }}>{t('you.fact.places.notSet')}</Text>
                ) : (
                    places.map((place) => (
                        <View
                            key={place}
                            style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 999, borderWidth: 1, borderColor: colors.trackBorder, paddingLeft: 12 }}
                        >
                            <Text accessibilityLabel={describePlace(place) ?? place} style={{ color: colors.ink, fontSize: 14 }}>
                                {label(place)}
                            </Text>
                            <Pressable
                                testID={`fact-place-remove-${place}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('you.fact.places.remove', { place: describePlace(place) ?? place })}
                                onPress={() => write(places.filter((p) => p !== place))}
                                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                            >
                                <MaterialIcons name="close" size={16} color={colors.ink2} />
                            </Pressable>
                        </View>
                    ))
                )}
            </View>
            <View style={{ flexDirection: 'row', gap: 16 }}>
                <Pressable
                    testID="fact-place-add"
                    accessibilityRole="button"
                    onPress={() => setPicking(true)}
                    style={{ minHeight: 44, justifyContent: 'center' }}
                >
                    <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{`+ ${t('you.fact.places.addCountry')}`}</Text>
                </Pressable>
                {isAnywhere ? null : (
                    <Pressable
                        testID="fact-place-anywhere"
                        accessibilityRole="button"
                        onPress={() => write([PLACE_GLOBAL])}
                        style={{ minHeight: 44, justifyContent: 'center' }}
                    >
                        <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{t('you.fact.places.anywhere')}</Text>
                    </Pressable>
                )}
            </View>
            <CountryPickerSheet
                visible={picking}
                onClose={() => setPicking(false)}
                onPick={(alpha2) => {
                    setPicking(false);
                    write([...places.filter((p) => p !== PLACE_GLOBAL), alpha2]);
                }}
            />
        </View>
    );
}
