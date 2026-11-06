import { useRestartHold } from '@/lib/app-restart';
import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import PublicationListRow from '@/components/custom/publication-page/PublicationListRow';
import PublicationControlRow, { InheritedStarHelp } from '@/components/custom/publication-preferences/PublicationControlRow';
import { searchSourceCountries } from '@/components/custom/publication-preferences/country-search';
import { usePublicationRowPrefs } from '@/components/custom/publication-preferences/use-publication-row-prefs';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { PublisherSearchHit } from '@/lib/generated/graphql-types';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import SourceService from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import { X } from 'lucide-react-native';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable as RNPressable, ScrollView, StyleSheet, View } from 'react-native';

/** The server rejects a shorter query (BadRequestException). */
const MIN_QUERY_LENGTH = 2;

/**
 * "Find a publication" on the Sources screen and in onboarding. A result is
 * the shared source row (star, Not preferred) and opens the publication page.
 * On Sources a country that matches sits above and opens the country page; in
 * onboarding that would leave the wizard, so it offers none. Every state is named
 * (too short, searching, none, failed): a search box that shows nothing reads
 * as broken. Nothing typed is stored.
 */
const SourceSearch: React.FC<{
    /** True while the box holds a query, so the screen can hide its empty state. */
    readonly onActiveChange?: (active: boolean) => void;
    /** Onboarding: publications only, results float in a panel, and a failed search offers Try again. */
    readonly onboarding?: boolean;
    readonly onFocusChange?: (focused: boolean) => void;
    /** Onboarding: what sits under the field. Results float over it in a panel, so it never moves. */
    readonly children?: React.ReactNode;
}> = ({ onActiveChange, onboarding, onFocusChange, children }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const appLanguage = useAppLanguage();
    const prefs = usePublicationRowPrefs();
    const themeMode = useThemeMode();
    const [query, setQuery] = useState('');
    useRestartHold(query.trim().length > 0, 'draft:source-search', 'hard');
    const debounced = useDebouncedValue(query, 300);
    const [results, setResults] = useState<PublisherSearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    // Onboarding: a tap outside closes the panel and keeps the query; typing or focus opens it again.
    const [dismissed, setDismissed] = useState(false);
    const [fieldHeight, setFieldHeight] = useState(0);
    const [boxHeight, setBoxHeight] = useState(0);

    const trimmed = debounced.trim();
    useEffect(() => {
        if (trimmed.length < MIN_QUERY_LENGTH) {
            setResults([]);
            setSearched(false);
            setFailed(false);
            return undefined;
        }
        let cancelled = false;
        setSearching(true);
        setFailed(false);
        SourceService.searchPublishers({ query: trimmed, first: 20 })
            .then((res) => {
                if (cancelled) return;
                setResults(res.publishers ?? []);
                setSearched(true);
            })
            .catch((error) => {
                if (cancelled) return;
                setFailed(true);
                setResults([]);
                logger.captureException(error, { tags: { component: 'SourceSearch', method: 'searchPublishers' } });
            })
            .finally(() => {
                if (!cancelled) setSearching(false);
            });
        return () => {
            cancelled = true;
        };
    }, [trimmed, attempt]);

    const countryHits = useMemo(
        () => (!onboarding && trimmed.length >= MIN_QUERY_LENGTH ? searchSourceCountries(trimmed, appLanguage) : []),
        [onboarding, trimmed, appLanguage],
    );
    const findLabel = t(onboarding ? 'onboarding.sourcesFind' : 'you.sources.find');
    const typed = query.trim().length > 0;
    const tooShort = typed && trimmed.length < MIN_QUERY_LENGTH;
    useEffect(() => {
        onActiveChange?.(typed);
    }, [typed, onActiveChange]);

    const input = (
        <Input className="rounded-full border-line bg-surface" style={{ height: 42, paddingRight: onboarding && typed ? 40 : 0 }}>
            <InputSlot className="pl-3.5">
                <MaterialIcons name="search" size={18} color={colors.ink2} />
            </InputSlot>
            <InputField
                keyboardAppearance={themeMode}
                testID="sources-search"
                value={query}
                onChangeText={(text) => {
                    setDismissed(false);
                    setQuery(text);
                }}
                placeholder={findLabel}
                accessibilityLabel={findLabel}
                autoCapitalize="none"
                autoCorrect={false}
                onFocus={() => {
                    setDismissed(false);
                    onFocusChange?.(true);
                }}
                onBlur={() => onFocusChange?.(false)}
            />
        </Input>
    );

    const status = (
        <>
            {tooShort ? <Text size="sm" className="text-ink-2">{t('subscriptions.searchTooShort')}</Text> : null}
            {!tooShort && searching ? (
                <HStack space="sm" className="items-center">
                    <Spinner size="small" />
                    <Text size="sm" className="text-ink-2">{t('subscriptions.searchInFlight')}</Text>
                </HStack>
            ) : null}
            {failed && !searching ? (
                onboarding ? (
                    <VStack space="sm" className="items-start">
                        <Text size="sm" className="text-ink-2">{t('onboarding.sourcesLoadError')}</Text>
                        <Button action="secondary" size="sm" onPress={() => setAttempt((n) => n + 1)} testID="sources-search-retry">
                            <ButtonText>{t('auth.tryAgain')}</ButtonText>
                        </Button>
                    </VStack>
                ) : (
                    <Text size="sm" className="text-ink-2">{t('subscriptions.searchError')}</Text>
                )
            ) : null}
            {!failed && !searching && searched && results.length === 0 && countryHits.length === 0 ? (
                <Text size="sm" className="text-ink-2">{t('subscriptions.searchNoResults')}</Text>
            ) : null}
        </>
    );

    const rows = (
        <>
            {!tooShort
                ? countryHits.map((c) => (
                      <PublicationListRow
                          key={c.alpha3}
                          rawName={c.name}
                          flag={flagForAlpha2(c.alpha2) || null}
                          subtitle={t('publicationPrefs.scopeKindCountry')}
                          onPress={() =>
                              router.push({
                                  pathname: '/logged-in/sources-publishers',
                                  params: { countryCode: c.alpha3, countryName: c.name },
                              })
                          }
                          testID={`sources-country-${c.alpha3}`}
                      />
                  ))
                : null}

            {/* The panel keeps its rows through a new search, or one can unmount under a finger. */}
            {!tooShort && (onboarding || !searching)
                ? results.map((hit) => (
                      <PublicationControlRow
                          key={hit._id}
                          {...prefs.publisherRow({ publisherId: hit._id, rawName: hit.name, countryCode: hit.country_code })}
                          rawName={hit.name}
                          flag={flagForAlpha2(alpha3ToAlpha2(hit.country_code)) || null}
                          subtitle={hit.country_name ?? null}
                          onPress={() => openPublicationPage({ publisherId: hit._id, rawName: hit.name, countryCode: hit.country_code })}
                          testID={`sources-hit-${hit._id}`}
                      />
                  ))
                : null}
        </>
    );

    const help = <InheritedStarHelp country={prefs.helpCountry} onClose={prefs.closeHelp} />;

    if (!onboarding) {
        return (
            <VStack className="pb-2">
                <VStack space="sm" className="px-4 pb-3">
                    {input}
                    {status}
                </VStack>
                {rows}
                {help}
            </VStack>
        );
    }

    // The panel is a sibling of the picks inside one flex:1 box, not an overflow of a short parent:
    // Android delivers no touch outside a parent's bounds. Its top is the field's measured height,
    // so the title collapsing moves field and panel together. The backdrop starts there too: a tap
    // on the field is not a tap outside.
    const panelOpen = typed && !dismissed;
    return (
        <View style={styles.flex} onLayout={(e) => setBoxHeight(e.nativeEvent.layout.height)}>
            <View style={styles.field} onLayout={(e) => setFieldHeight(e.nativeEvent.layout.height)}>
                {input}
                {typed ? (
                    <RNPressable
                        testID="sources-search-clear"
                        accessibilityRole="button"
                        accessibilityLabel={t('onboarding.close')}
                        onPress={() => setQuery('')}
                        style={styles.clear}
                    >
                        <X size={18} color={colors.ink2} />
                    </RNPressable>
                ) : null}
            </View>
            {/* A screen reader must not reach a row drawn under the panel. */}
            <View
                style={styles.flex}
                accessibilityElementsHidden={panelOpen}
                importantForAccessibility={panelOpen ? 'no-hide-descendants' : 'auto'}
            >
                {children}
            </View>
            {panelOpen ? (
                <>
                    <RNPressable
                        testID="sources-search-backdrop"
                        accessible={false}
                        importantForAccessibility="no"
                        onPress={() => {
                            Keyboard.dismiss();
                            setDismissed(true);
                        }}
                        style={[StyleSheet.absoluteFill, styles.backdrop, { top: fieldHeight }]}
                    />
                    <View
                        testID="sources-search-panel"
                        style={[styles.panel, { top: fieldHeight, maxHeight: Math.max(0, boxHeight - fieldHeight - 8), backgroundColor: colors.panel, borderColor: colors.line }]}
                    >
                        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.panelContent}>
                            <VStack space="sm" className="px-4">{status}</VStack>
                            {rows}
                        </ScrollView>
                    </View>
                </>
            ) : null}
            {help}
        </View>
    );
};

const styles = StyleSheet.create({
    flex: { flex: 1 },
    field: { paddingHorizontal: 16, paddingBottom: 12 },
    // A 44pt frame over the 42pt field's end, outside the Input, whose overflow would clip it.
    clear: { position: 'absolute', top: -1, right: 16, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    backdrop: { zIndex: 1 },
    panel: {
        position: 'absolute',
        left: 12,
        right: 12,
        zIndex: 2,
        elevation: 8,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    panelContent: { paddingTop: 12, paddingBottom: 4 },
});

export default SourceSearch;
