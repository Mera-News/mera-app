import { useRestartHold } from '@/lib/app-restart';
import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
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
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** The server rejects a shorter query (BadRequestException). */
const MIN_QUERY_LENGTH = 2;

/**
 * "Find a publication" on the Sources screen and in onboarding. A result is
 * the shared source row (star, Not preferred) and opens the publication page;
 * a country that matches sits above and opens the country page. Every state is named
 * (too short, searching, none, failed): a search box that shows nothing reads
 * as broken. Nothing typed is stored.
 */
const SourceSearch: React.FC<{
    /** True while the box holds a query, so the screen can hide its empty state. */
    readonly onActiveChange?: (active: boolean) => void;
    /** Onboarding: rows have no body button, and a failed search offers Try again. */
    readonly onboarding?: boolean;
    /** Under a publication row, such as onboarding's "I subscribe". */
    readonly footerFor?: (hit: PublisherSearchHit) => ReactNode;
    readonly onFocusChange?: (focused: boolean) => void;
}> = ({ onActiveChange, onboarding, footerFor, onFocusChange }) => {
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
        () => (trimmed.length >= MIN_QUERY_LENGTH ? searchSourceCountries(trimmed, appLanguage) : []),
        [trimmed, appLanguage],
    );
    const typed = query.trim().length > 0;
    const tooShort = typed && trimmed.length < MIN_QUERY_LENGTH;
    useEffect(() => {
        onActiveChange?.(typed);
    }, [typed, onActiveChange]);

    return (
        <VStack className="pb-2">
            <VStack space="sm" className="px-4 pb-3">
                <Input className="rounded-full border-line bg-surface" style={{ height: 42 }}>
                    <InputSlot className="pl-3.5">
                        <MaterialIcons name="search" size={18} color={colors.ink2} />
                    </InputSlot>
                    <InputField
                        keyboardAppearance={themeMode}
                        testID="sources-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('you.sources.find')}
                        accessibilityLabel={t('you.sources.find')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onFocus={() => onFocusChange?.(true)}
                        onBlur={() => onFocusChange?.(false)}
                    />
                </Input>

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
            </VStack>

            {!tooShort
                ? countryHits.map((c) => (
                      <PublicationControlRow
                          key={c.alpha3}
                          {...prefs.countryRow(c)}
                          rawName={c.name}
                          flag={flagForAlpha2(c.alpha2) || null}
                          subtitle={t('publicationPrefs.scopeKindCountry')}
                          onPress={
                              onboarding
                                  ? undefined
                                  : () =>
                                        router.push({
                                            pathname: '/logged-in/sources-publishers',
                                            params: { countryCode: c.alpha3, countryName: c.name },
                                        })
                          }
                          testID={`sources-country-${c.alpha3}`}
                      />
                  ))
                : null}

            {!tooShort && !searching
                ? results.map((hit) => (
                      <PublicationControlRow
                          key={hit._id}
                          {...prefs.publisherRow({ publisherId: hit._id, rawName: hit.name, countryCode: hit.country_code })}
                          rawName={hit.name}
                          flag={flagForAlpha2(alpha3ToAlpha2(hit.country_code)) || null}
                          subtitle={hit.country_name ?? null}
                          footer={footerFor?.(hit)}
                          onPress={
                              onboarding
                                  ? undefined
                                  : () => openPublicationPage({ publisherId: hit._id, rawName: hit.name, countryCode: hit.country_code })
                          }
                          testID={`sources-hit-${hit._id}`}
                      />
                  ))
                : null}

            <InheritedStarHelp country={prefs.helpCountry} onClose={prefs.closeHelp} />
        </VStack>
    );
};

export default SourceSearch;
