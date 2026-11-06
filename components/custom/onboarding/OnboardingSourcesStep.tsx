import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import PublicationControlRow, { InheritedStarHelp } from '@/components/custom/publication-preferences/PublicationControlRow';
import SourceSearch from '@/components/custom/publication-preferences/SourceSearch';
import { localizedCountryName } from '@/components/custom/publication-preferences/country-search';
import { useAdjustedSources } from '@/components/custom/publication-preferences/use-adjusted-sources';
import { usePublicationRowPrefs } from '@/components/custom/publication-preferences/use-publication-row-prefs';
import { useRestartHold } from '@/lib/app-restart';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useIsOnline } from '@/lib/stores/network-store';
import { useColors } from '@/lib/theme/tokens';

import { keyboardLift } from './keyboard-lift';

/**
 * Step 1: search, and the picks so far. Picks are the shared source rows' own
 * writes; the wizard only needs to know whether any exist (Skip becomes Next).
 * A name opens the publication page, whose Subscribed button needs nothing here.
 */
const OnboardingSourcesStep: React.FC<{ readonly onHasPicksChange: (has: boolean) => void }> = ({ onHasPicksChange }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const online = useIsOnline();
    const appLanguage = useAppLanguage();
    const prefs = usePublicationRowPrefs();
    const { publications, scopes } = useAdjustedSources();
    const [focused, setFocused] = useState(false);
    // The wizard's route is blocked, but a name pushes the publication page over it,
    // and an update restart there would end the wizard.
    useRestartHold(true, 'onboarding-sources', 'hard');
    const keyboard = useReanimatedKeyboardAnimation();
    const lift = useAnimatedStyle(() => ({ paddingBottom: keyboardLift(keyboard.height.value, insets.bottom) }));

    const hasPicks = publications.length + scopes.length > 0;
    useEffect(() => {
        onHasPicksChange(hasPicks);
    }, [hasPicks, onHasPicksChange]);

    return (
        <Animated.View style={[styles.flex, lift]} testID="onboarding-sources-step">
            {!focused ? (
                <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.remind}>
                    <RNText accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                        {t('onboarding.sourcesTitle')}
                    </RNText>
                    <RNText style={[styles.body, { color: colors.ink2 }]}>{t('onboarding.sourcesBody')}</RNText>
                </Animated.View>
            ) : null}
            <Animated.View layout={LinearTransition} style={styles.flex}>
                <SourceSearch onboarding onFocusChange={setFocused}>
                    <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                        {!online ? <RNText style={[styles.hint, { color: colors.ink2 }]}>{t('onboarding.sourcesOffline')}</RNText> : null}
                        {hasPicks ? (
                            <View testID="onboarding-your-sources">
                                <RNText accessibilityRole="header" style={[styles.section, { color: colors.ink2 }]}>
                                    {t('onboarding.yourSources')}
                                </RNText>
                                {publications.map((pub) => (
                                    <PublicationControlRow
                                        key={pub.key}
                                        {...prefs.publisherRow({
                                            publisherId: pub.publisherId ?? pub.key,
                                            // No known publisher, so nothing to fetch: writes take the stored name.
                                            sourceNames: pub.publisherId ? undefined : [pub.displayName],
                                            rawName: pub.displayName,
                                            countryCode: pub.countryCode,
                                        })}
                                        rawName={pub.displayName}
                                        flag={pub.countryCode ? flagForAlpha2(alpha3ToAlpha2(pub.countryCode)) || null : null}
                                        onPress={() =>
                                            openPublicationPage({ publisherId: pub.publisherId, rawName: pub.displayName, countryCode: pub.countryCode })
                                        }
                                        testID={`onboarding-pick-${pub.key}`}
                                    />
                                ))}
                                {scopes.map(({ pref, group }) => {
                                    const alpha2 = alpha3ToAlpha2(pref.scopeValue);
                                    // An unmappable stored code cannot be written; the row is not drawn.
                                    if (!alpha2 || !pref.scopeValue) return null;
                                    return (
                                        <PublicationControlRow
                                            key={group.key}
                                            {...prefs.storedCountryRow({ alpha2, alpha3: pref.scopeValue, label: pref.publicationName })}
                                            rawName={localizedCountryName(pref.scopeValue, appLanguage)}
                                            flag={flagForAlpha2(alpha2)}
                                            subtitle={`${t('publicationPrefs.scopeKindCountry')} · ${t('publicationPage.preferred')}`}
                                            testID={`onboarding-pick-${group.key}`}
                                        />
                                    );
                                })}
                            </View>
                        ) : null}
                    </ScrollView>
                </SourceSearch>
            </Animated.View>
            <InheritedStarHelp country={prefs.helpCountry} onClose={prefs.closeHelp} />
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingBottom: 24 },
    remind: { paddingHorizontal: 20, paddingTop: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 26, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 22 },
    hint: { fontSize: 14, paddingHorizontal: 20, paddingBottom: 8 },
    section: { fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 },
});

export default OnboardingSourcesStep;
