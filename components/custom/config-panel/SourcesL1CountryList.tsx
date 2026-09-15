import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TopVisitedPublicationsCard from '@/components/custom/config-panel/TopVisitedPublicationsCard';
import { alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { AccountService } from '@/lib/account-service';
import { getCountryName, getFlagEmoji } from '@/lib/country-utils';
import {
    addBrowseCountry,
    getBrowseCountries,
    removeBrowseCountry,
} from '@/lib/explore/browse-countries';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import SourceService, { type PublisherSearchHit } from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';

interface CountryItem {
    code: string;
    name: string;
    flag: string;
}

const GLOBAL_COUNTRY = {
    code: 'GLOBAL',
    name: 'Global',
    flag: '🌍',
};

// Debounce + minimum query length for the publisher search (Item 8) — the
// server rejects queries under 2 chars, so there is no point firing sooner.
const PUBLISHER_SEARCH_DEBOUNCE_MS = 300;
const PUBLISHER_SEARCH_MIN_LENGTH = 2;

type L1Row =
    | { readonly kind: 'country'; readonly item: CountryItem }
    | { readonly kind: 'publisher'; readonly item: PublisherSearchHit };

/** One publisher search hit — name, the country it belongs to, and its matching feeds. */
const PublisherSearchRow: React.FC<{ hit: PublisherSearchHit }> = ({ hit }) => {
    const { t } = useTranslation();

    const handlePublisherPress = useCallback(() => {
        router.push({
            pathname: '/logged-in/publisher-articles',
            params: { publisherId: hit._id, publisherName: hit.name },
        });
    }, [hit._id, hit.name]);

    const handleFeedPress = useCallback(
        (feedId: string, category: string) => {
            router.push({
                pathname: '/logged-in/sources-articles',
                params: {
                    title: category,
                    countryCode: hit.country_code,
                    publisherName: hit.name,
                    publicationSourceId: feedId,
                },
            });
        },
        [hit.country_code, hit.name],
    );

    return (
        <Box className="mx-4 mb-3 rounded-lg border border-gray-700 overflow-hidden">
            <Pressable onPress={handlePublisherPress} className="px-4 py-3">
                <HStack className="items-center justify-between w-full" space="sm">
                    <HStack className="items-center flex-1 mr-3" space="md">
                        <Text className="text-2xl">{getFlagEmoji(hit.country_code)}</Text>
                        <VStack className="flex-1" space="xs">
                            <Text className="text-base text-white">{hit.name}</Text>
                            <Text size="xs" className="text-gray-500" numberOfLines={1}>
                                {hit.country_name ?? getCountryName(hit.country_code)}
                                {hit.website_url
                                    ? ` · ${hit.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
                                    : ''}
                            </Text>
                        </VStack>
                    </HStack>
                    <Button
                        variant="outline"
                        size="xs"
                        onPress={handlePublisherPress}
                        className="rounded-full"
                    >
                        <ButtonText>{t('sources.viewTopHeadlines')}</ButtonText>
                    </Button>
                </HStack>
            </Pressable>
            {hit.matchingSources.length > 0 && (
                <VStack className="border-t border-gray-800">
                    {hit.matchingSources.map((feed) => (
                        <Pressable
                            key={feed._id}
                            onPress={() => handleFeedPress(feed._id, feed.category)}
                            className="px-4 py-2 border-t border-gray-800"
                        >
                            <HStack className="items-center justify-between">
                                <Text className="text-gray-300 text-sm capitalize">
                                    {feed.category === 'general_news' ? 'All' : feed.category}
                                </Text>
                                <MaterialIcons name="chevron-right" size={16} color="#999999" />
                            </HStack>
                        </Pressable>
                    ))}
                </VStack>
            )}
        </Box>
    );
};

const SourcesL1CountryList: React.FC = () => {
    const { t } = useTranslation();
    const [countryCodes, setCountryCodes] = useState<string[]>([]);
    const [topPublications, setTopPublications] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    // Set of alpha-2 country codes the user is currently browsing (Item 7 —
    // `explore_browse_countries` KV row, NOT a persona Location — adding a
    // country here means "show me this country's news" and nothing more).
    // No observable on the KV store, so this is re-read on focus instead of
    // subscribed.
    const [browseAlpha2, setBrowseAlpha2] = useState<Set<string>>(new Set());
    const [publisherHits, setPublisherHits] = useState<PublisherSearchHit[]>([]);
    const [isSearchingPublishers, setIsSearchingPublishers] = useState(false);
    const hasFetched = useRef(false);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Guards against a slow, now-stale search response clobbering a faster
    // later one (classic out-of-order-resolution race on debounced typing).
    const searchRequestIdRef = useRef(0);

    const loadBrowseCountries = useCallback(async () => {
        try {
            const codes = await getBrowseCountries();
            setBrowseAlpha2(new Set(codes));
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL1CountryList', method: 'loadBrowseCountries' },
            });
        }
    }, []);

    // Re-read on every focus — a country added/removed elsewhere (or in a
    // previous visit to this same screen) must reflect here.
    useFocusEffect(
        useCallback(() => {
            void loadBrowseCountries();
        }, [loadBrowseCountries]),
    );

    const handleToggleCountry = useCallback(
        (item: CountryItem) => {
            const alpha2 = alpha3ToAlpha2(item.code);
            if (!alpha2) return;
            const code = alpha2.toUpperCase();
            const isAdded = browseAlpha2.has(code);
            void hapticLight();
            // Optimistic flip; the next focus re-read reconciles the true state.
            setBrowseAlpha2((prev) => {
                const next = new Set(prev);
                if (isAdded) next.delete(code);
                else next.add(code);
                return next;
            });
            const action = isAdded ? removeBrowseCountry(code) : addBrowseCountry(code);
            action.catch((error) => {
                logger.captureException(error, {
                    tags: { screen: 'SourcesL1CountryList', method: 'handleToggleCountry' },
                });
            });
        },
        [browseAlpha2],
    );

    const loadCountries = useCallback(async () => {
        try {
            const codes = await AccountService.getAllCountries();
            setCountryCodes(codes);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL1CountryList', method: 'loadCountries' },
            });
        }
    }, []);

    const loadTopPublications = useCallback(async () => {
        const rows = await getTopVisitedPublications({ limit: 3 });
        setTopPublications(rows);
    }, []);

    useEffect(() => {
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            Promise.all([loadCountries(), loadTopPublications()]).finally(() =>
                setIsLoading(false),
            );
        }
    }, [loadCountries, loadTopPublications]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([loadCountries(), loadTopPublications(), loadBrowseCountries()]);
        setRefreshing(false);
    }, [loadCountries, loadTopPublications, loadBrowseCountries]);

    // Publisher search (Item 8) — debounced, gated at 2 chars (the server's
    // own floor), shares the same search box as the country-name filter.
    const isPublisherSearchActive = searchQuery.trim().length >= PUBLISHER_SEARCH_MIN_LENGTH;
    useEffect(() => {
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

        const trimmed = searchQuery.trim();
        if (trimmed.length < PUBLISHER_SEARCH_MIN_LENGTH) {
            setPublisherHits([]);
            setIsSearchingPublishers(false);
            return;
        }

        setIsSearchingPublishers(true);
        const requestId = ++searchRequestIdRef.current;
        searchDebounceRef.current = setTimeout(() => {
            SourceService.searchPublishers({ query: trimmed, first: 10 })
                .then((response) => {
                    if (searchRequestIdRef.current !== requestId) return; // stale
                    setPublisherHits(response.publishers);
                })
                .catch((error) => {
                    if (searchRequestIdRef.current !== requestId) return;
                    logger.captureException(error, {
                        tags: { screen: 'SourcesL1CountryList', method: 'searchPublishers' },
                    });
                    setPublisherHits([]);
                })
                .finally(() => {
                    if (searchRequestIdRef.current === requestId) setIsSearchingPublishers(false);
                });
        }, PUBLISHER_SEARCH_DEBOUNCE_MS);

        return () => {
            if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        };
    }, [searchQuery]);

    const countryList: CountryItem[] = useMemo(() => {
        const query = searchQuery.toLowerCase().trim();

        const countryItems: CountryItem[] = countryCodes
            .filter((code) => code !== 'GLOBAL')
            .map((code) => ({
                code,
                name: getCountryName(code),
                flag: getFlagEmoji(code),
            }))
            .filter((item) => !query || item.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));

        // Order: the fixed Global item first (when it matches the search), then
        // every country alphabetical by name.
        const globalMatchesSearch = !query || GLOBAL_COUNTRY.name.toLowerCase().includes(query);

        return [
            ...(globalMatchesSearch ? [{ ...GLOBAL_COUNTRY }] : []),
            ...countryItems,
        ];
    }, [countryCodes, searchQuery]);

    // While a publisher search is active, publisher hits lead the list
    // (structurally distinct rows — Item 8), followed by any still-matching
    // country rows; everything else is filtered out. Outside search mode this
    // is just the plain country list, unchanged.
    const listData: L1Row[] = useMemo(() => {
        if (!isPublisherSearchActive) {
            return countryList.map((item) => ({ kind: 'country' as const, item }));
        }
        return [
            ...publisherHits.map((item) => ({ kind: 'publisher' as const, item })),
            ...countryList.map((item) => ({ kind: 'country' as const, item })),
        ];
    }, [isPublisherSearchActive, countryList, publisherHits]);

    const handleCountryPress = useCallback(
        (item: CountryItem) => {
            router.push({
                pathname: '/logged-in/sources-publishers',
                params: { countryCode: item.code, countryName: item.name },
            });
        },
        []
    );

    const handleTopHeadlinesPress = useCallback(
        (item: CountryItem) => {
            router.push({
                pathname: '/logged-in/country-articles',
                params: { countryCode: item.code, countryName: item.name },
            });
        },
        []
    );

    const renderCountryRow = useCallback(
        (item: CountryItem) => {
            const alpha2 = item.code === 'GLOBAL' ? null : alpha3ToAlpha2(item.code);
            const isAdded = !!alpha2 && browseAlpha2.has(alpha2.toUpperCase());
            return (
                // Outer Pressable opens the country's publishers; the inner
                // +/check toggle (left) and "top headlines" Button (right) are
                // separate touchables that act on tap.
                <Pressable
                    onPress={() => handleCountryPress(item)}
                    className="mx-4 mb-3 h-auto px-4 py-3 justify-start"
                >
                    <HStack className="items-center justify-between w-full" space="sm">
                        <HStack className="items-center flex-1 mr-3" space="md">
                            {item.code === 'GLOBAL' ? (
                                // Global can't be browsed as a scope — keep an
                                // equal-width spacer so flags/names stay aligned
                                // with the country rows' toggle control.
                                <Box className="w-[26px]" />
                            ) : (
                                <Pressable
                                    onPress={() => handleToggleCountry(item)}
                                    className="p-1"
                                    accessibilityRole="button"
                                    accessibilityLabel={t(
                                        isAdded ? 'sources.addedToExplore' : 'sources.addToExplore',
                                    )}
                                >
                                    <MaterialIcons
                                        name={isAdded ? 'check-circle' : 'add-circle-outline'}
                                        size={24}
                                        color={isAdded ? '#4ade80' : '#EDA77E'}
                                    />
                                </Pressable>
                            )}
                            <Text className="text-2xl">{item.flag}</Text>
                            {/* `flex-1` so a long name WRAPS inside the row's
                                remaining width instead of overflowing across the
                                "Top headlines" pill — "Antigua and Barbuda" ran
                                straight through it. Two lines for a country name
                                is fine; the row is already `h-auto`. */}
                            <Text className="text-base text-white flex-1">{item.name}</Text>
                        </HStack>
                        {/* Must not shrink: without this the pill would give up
                            width to the wrapping name and its own label would
                            start wrapping instead. */}
                        <HStack className="items-center flex-shrink-0" space="sm">
                            <Button
                                variant="outline"
                                size="xs"
                                onPress={() => handleTopHeadlinesPress(item)}
                                className="rounded-full"
                            >
                                <ButtonText>{t('sources.viewTopHeadlines')}</ButtonText>
                            </Button>
                            <MaterialIcons
                                name="chevron-right"
                                size={20}
                                color="#999999"
                            />
                        </HStack>
                    </HStack>
                </Pressable>
            );
        },
        [handleCountryPress, handleTopHeadlinesPress, handleToggleCountry, browseAlpha2, t]
    );

    const renderItem: ListRenderItem<L1Row> = useCallback(
        ({ item }) =>
            item.kind === 'publisher' ? (
                <PublisherSearchRow hit={item.item} />
            ) : (
                renderCountryRow(item.item)
            ),
        [renderCountryRow]
    );

    const keyExtractor = useCallback(
        (row: L1Row) => (row.kind === 'publisher' ? `publisher-${row.item._id}` : `country-${row.item.code}`),
        []
    );

    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    const emptyMessage = isPublisherSearchActive
        ? t('sources.noResultsMatch')
        : searchQuery
            ? t('sources.noCountriesMatch')
            : t('sources.noSourcesAvailable');

    return (
        <Box className="flex-1">
            <TopVisitedPublicationsCard topPublications={topPublications} />
            <Box className="mx-4 mt-3 mb-2">
                <Input variant="outline" size="md" className="border-gray-700">
                    <InputSlot className="pl-3">
                        {isSearchingPublishers ? (
                            <Spinner size="small" />
                        ) : (
                            <MaterialIcons name="search" size={18} color="#999999" />
                        )}
                    </InputSlot>
                    <InputField
                        placeholder={t('sources.searchCountriesOrPublishers')}
                        placeholderTextColor="#666666"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        className="text-white"
                        autoCorrect={false}
                        autoCapitalize="none"
                    />
                </Input>
            </Box>
            {listData.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="public" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {emptyMessage}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={listData}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor="#ffffff"
                            colors={['#ffffff']}
                        />
                    }
                />
            )}
        </Box>
    );
};

export default SourcesL1CountryList;
