import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TopVisitedPublicationsCard from '@/components/custom/config-panel/TopVisitedPublicationsCard';
import { AccountService } from '@/lib/account-service';
import { getCountryName, getFlagEmoji } from '@/lib/country-utils';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import { usePinnedCountriesStore } from '@/lib/stores/pinned-countries-store';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';

interface CountryItem {
    code: string;
    name: string;
    flag: string;
    isPinned: boolean;
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
    const hasFetched = useRef(false);
    const pinnedCodes = usePinnedCountriesStore((s) => s.pinnedCodes);
    const togglePin = usePinnedCountriesStore((s) => s.togglePin);
    const hydratePinned = usePinnedCountriesStore((s) => s.hydrate);

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
            hydratePinned();
            Promise.all([loadCountries(), loadTopPublications()]).finally(() =>
                setIsLoading(false),
            );
        }
    }, [loadCountries, loadTopPublications, hydratePinned]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([loadCountries(), loadTopPublications()]);
        setRefreshing(false);
    }, [loadCountries, loadTopPublications]);

    const countryList: CountryItem[] = useMemo(() => {
        const query = searchQuery.toLowerCase().trim();
        const pinnedSet = new Set(pinnedCodes);

        const countryItems: CountryItem[] = countryCodes
            .filter((code) => code !== 'GLOBAL')
            .map((code) => ({
                code,
                name: getCountryName(code),
                flag: getFlagEmoji(code),
                isPinned: pinnedSet.has(code),
            }))
            .filter((item) => !query || item.name.toLowerCase().includes(query));

        // Order: pinned countries first, then the fixed Global item, then the
        // rest. Each country group is alphabetical by name; Global is not pinnable.
        const pinned = countryItems
            .filter((item) => item.isPinned)
            .sort((a, b) => a.name.localeCompare(b.name));
        const rest = countryItems
            .filter((item) => !item.isPinned)
            .sort((a, b) => a.name.localeCompare(b.name));

        const globalMatchesSearch = !query || GLOBAL_COUNTRY.name.toLowerCase().includes(query);

        return [
            ...pinned,
            ...(globalMatchesSearch ? [{ ...GLOBAL_COUNTRY, isPinned: false }] : []),
            ...rest,
        ];
    }, [countryCodes, searchQuery, pinnedCodes]);

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
        ({ item }) => (
            // Outer Pressable opens the country's publishers; the inner "top
            // headlines" Button is a separate touchable that fetches on tap.
            <Pressable
                onPress={() => handleCountryPress(item)}
                className="mx-4 mb-3 h-auto px-4 py-3 justify-start rounded-lg border border-gray-700"
            >
                <HStack className="items-center justify-between w-full" space="sm">
                    <HStack className="items-center flex-1 mr-3" space="md">
                        {item.code === 'GLOBAL' ? (
                            // Global is not pinnable — keep an equal-width spacer so
                            // the flags/names stay aligned with the pinnable rows.
                            <Box className="w-[30px]" />
                        ) : (
                            <Pressable
                                onPress={() => togglePin(item.code)}
                                className="p-1"
                                accessibilityRole="button"
                                accessibilityLabel={t('sources.togglePin')}
                            >
                                <MaterialCommunityIcons
                                    name={item.isPinned ? 'pin' : 'pin-outline'}
                                    size={22}
                                    color={item.isPinned ? '#3b82f6' : '#666666'}
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
        ),
        [handleCountryPress, handleTopHeadlinesPress, togglePin, t]
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
