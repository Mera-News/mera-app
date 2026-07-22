import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TopVisitedPublicationsCard from '@/components/custom/config-panel/TopVisitedPublicationsCard';
import { alpha3ToAlpha2, weightForBucket } from '@/components/custom/locations/location-display';
import { AccountService } from '@/lib/account-service';
import { getCountryName, getFlagEmoji } from '@/lib/country-utils';
import { addUserLocation } from '@/lib/database/services/location-persona-actions';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
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

const SourcesL1CountryList: React.FC = () => {
    const { t } = useTranslation();
    const [countryCodes, setCountryCodes] = useState<string[]>([]);
    const [topPublications, setTopPublications] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    // Set of alpha-2 country codes the user already keeps as a country-only
    // 'interest' location (city null) — drives the +/check state on each row.
    const [addedAlpha2, setAddedAlpha2] = useState<Set<string>>(new Set());
    const hasFetched = useRef(false);

    // Reactive: which countries are already saved as interest locations.
    useEffect(() => {
        const sub = observeAllLocations().subscribe((rows) => {
            const next = new Set<string>();
            for (const l of rows) {
                if (l.role === 'interest' && !l.city && l.countryCode) {
                    next.add(l.countryCode.toUpperCase());
                }
            }
            setAddedAlpha2(next);
        });
        return () => sub.unsubscribe();
    }, []);

    const handleAddCountry = useCallback((item: CountryItem) => {
        const alpha2 = alpha3ToAlpha2(item.code);
        if (!alpha2) return;
        void hapticLight();
        // Optimistic flip; the observe subscription reconciles the true state.
        setAddedAlpha2((prev) => new Set(prev).add(alpha2.toUpperCase()));
        addUserLocation({
            countryCode: alpha2,
            city: null,
            region: null,
            role: 'interest',
            weight: weightForBucket('medium'),
        }).catch((error) => {
            logger.captureException(error, {
                tags: { screen: 'SourcesL1CountryList', method: 'handleAddCountry' },
            });
        });
    }, []);

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
        await Promise.all([loadCountries(), loadTopPublications()]);
        setRefreshing(false);
    }, [loadCountries, loadTopPublications]);

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

    const renderItem: ListRenderItem<CountryItem> = useCallback(
        ({ item }) => {
            const alpha2 = item.code === 'GLOBAL' ? null : alpha3ToAlpha2(item.code);
            const isAdded = !!alpha2 && addedAlpha2.has(alpha2.toUpperCase());
            return (
            // Outer Pressable opens the country's publishers; the inner "+ add
            // location" button (left) and "top headlines" Button (right) are
            // separate touchables that act on tap.
            <Pressable
                onPress={() => handleCountryPress(item)}
                className="mx-4 mb-3 h-auto px-4 py-3 justify-start"
            >
                <HStack className="items-center justify-between w-full" space="sm">
                    <HStack className="items-center flex-1 mr-3" space="md">
                        {item.code === 'GLOBAL' ? (
                            // Global can't be added as a location — keep an
                            // equal-width spacer so flags/names stay aligned with
                            // the country rows' +/check control.
                            <Box className="w-[26px]" />
                        ) : (
                            <Pressable
                                onPress={() => handleAddCountry(item)}
                                className="p-1"
                                accessibilityRole="button"
                                accessibilityLabel={t(
                                    isAdded ? 'sources.addedToLocations' : 'sources.addToLocations',
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
                        <Text className="text-base text-white">{item.name}</Text>
                    </HStack>
                    <HStack className="items-center" space="sm">
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
        [handleCountryPress, handleTopHeadlinesPress, handleAddCountry, addedAlpha2, t]
    );

    const keyExtractor = useCallback((item: CountryItem) => item.code, []);

    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    return (
        <Box className="flex-1">
            <TopVisitedPublicationsCard topPublications={topPublications} />
            <Box className="mx-4 mt-3 mb-2">
                <Input variant="outline" size="md" className="border-gray-700">
                    <InputSlot className="pl-3">
                        <MaterialIcons name="search" size={18} color="#999999" />
                    </InputSlot>
                    <InputField
                        placeholder={t('sources.searchCountries')}
                        placeholderTextColor="#666666"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        className="text-white"
                        autoCorrect={false}
                        autoCapitalize="none"
                    />
                </Input>
            </Box>
            {countryList.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="public" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {searchQuery ? t('sources.noCountriesMatch') : t('sources.noSourcesAvailable')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={countryList}
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
