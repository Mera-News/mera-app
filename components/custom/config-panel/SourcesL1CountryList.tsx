import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
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
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';

interface CountryItem {
    code: string;
    name: string;
    flag: string;
}

const GLOBAL_COUNTRY: CountryItem = {
    code: 'GLOBAL',
    name: 'Global',
    flag: '🌍',
};

const SourcesL1CountryList: React.FC = () => {
    const [countryCodes, setCountryCodes] = useState<string[]>([]);
    const [topPublications, setTopPublications] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const hasFetched = useRef(false);

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
        const allItems: CountryItem[] = countryCodes
            .filter((code) => code !== 'GLOBAL')
            .map((code) => ({
                code,
                name: getCountryName(code),
                flag: getFlagEmoji(code),
            }))
            .filter((item) => !query || item.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));

        const globalMatchesSearch = !query || GLOBAL_COUNTRY.name.toLowerCase().includes(query);

        return [
            ...(globalMatchesSearch ? [GLOBAL_COUNTRY] : []),
            ...allItems,
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

    const renderItem: ListRenderItem<CountryItem> = useCallback(
        ({ item }) => (
            <HStack className="mx-4 mb-3 items-center" space="sm">
                <Button
                    variant="outline"
                    size="lg"
                    action="default"
                    onPress={() => handleCountryPress(item)}
                    className="flex-1 h-auto px-4 py-3 justify-start"
                >
                    <HStack className="items-center justify-between w-full">
                        <HStack className="items-center flex-1 mr-3" space="md">
                            <Text className="text-2xl">{item.flag}</Text>
                            <ButtonText className="text-base text-white">
                                {item.name}
                            </ButtonText>
                        </HStack>
                        <MaterialIcons
                            name="chevron-right"
                            size={20}
                            color="#999999"
                        />
                    </HStack>
                </Button>
            </HStack>
        ),
        [handleCountryPress]
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
                        placeholder="Search countries..."
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
                        {searchQuery ? 'No countries match your search' : 'No sources available'}
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
