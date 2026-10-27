import { allCountryOptions, searchCountryOptions } from '@/components/custom/world/world-arrange';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useRestartHold } from '@/lib/app-restart';
import { useColors } from '@/lib/theme/tokens';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';

interface Props {
    visible: boolean;
    title?: string;
    onPick: (alpha2: string) => void;
    onClose: () => void;
}

/** A search-first country list in a sheet. Picking calls `onPick`; the host closes it. */
export function CountryPickerSheet({ visible, title, onPick, onClose }: Props) {
    const { t } = useTranslation();
    const colors = useColors();
    const { height: windowHeight } = useWindowDimensions();
    const [query, setQuery] = useState('');
    // A typed, unpicked search is lost to a reload.
    useRestartHold(visible && query.length > 0, 'draft:fact-place', 'hard');
    const hits = useMemo(() => searchCountryOptions(allCountryOptions(), query), [query]);
    const close = () => {
        setQuery('');
        onClose();
    };
    return (
        <BottomSheet open={visible} onClose={close} testID="country-picker-sheet">
            {/* Typing a search raises the keyboard over a bottom sheet, so the content rises above it
                (as in the Report a bug sheet); the list is sized so sheet plus keyboard fit. */}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
                    <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '700' }} accessibilityRole="header">
                        {title ?? t('you.fact.places.addCountry')}
                    </Text>
                    <TextInput
                        testID="country-picker-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('you.fact.places.search')}
                        placeholderTextColor={colors.ink2}
                        accessibilityLabel={t('you.fact.places.search')}
                        autoCorrect={false}
                        style={{ color: colors.ink, fontSize: 16, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.trackBorder, paddingHorizontal: 12 }}
                    />
                    {query.trim() && hits.length === 0 ? (
                        <Text style={{ color: colors.ink2, fontSize: 14 }}>{t('you.fact.places.noCountry')}</Text>
                    ) : (
                        <ScrollView style={{ maxHeight: windowHeight * 0.3 }} keyboardShouldPersistTaps="handled">
                            {hits.map((o) => (
                                <Pressable
                                    key={o.alpha2}
                                    testID={`country-pick-${o.alpha2}`}
                                    accessibilityRole="button"
                                    onPress={() => {
                                        setQuery('');
                                        onPick(o.alpha2);
                                    }}
                                    style={{ minHeight: 44, justifyContent: 'center' }}
                                >
                                    <Text style={{ color: colors.ink, fontSize: 16 }}>{o.name}</Text>
                                </Pressable>
                            ))}
                        </ScrollView>
                    )}
                </View>
            </KeyboardAvoidingView>
        </BottomSheet>
    );
}
