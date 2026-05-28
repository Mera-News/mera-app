import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getFlagEmoji } from '@/lib/country-utils';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from './DrillDownHeader';

interface Props {
    readonly onBack: () => void;
}

const formatRelativeAgo = (timestamp: number): string => {
    const diffMs = Date.now() - timestamp;
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
};

const VisitedPublicationsList: React.FC<Props> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const rows = await getTopVisitedPublications();
            setItems(rows);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'VisitedPublicationsList', method: 'load' },
            });
        }
    }, []);

    useEffect(() => {
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
        }
    }, [load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const keyExtractor = useCallback(
        (item: VisitedPublication) => `${item.publicationName}::${item.countryCode ?? ''}`,
        [],
    );

    const handlePublicationPress = useCallback((item: VisitedPublication) => {
        router.push({
            pathname: '/logged-in/publication-history',
            params: {
                publicationName: item.publicationName,
                ...(item.countryCode ? { countryCode: item.countryCode } : {}),
            },
        });
    }, []);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item }) => (
            <Pressable onPress={() => handlePublicationPress(item)}>
                <HStack
                    className="mx-4 mb-2 p-3 items-center"
                    space="md"
                >
                    {item.countryCode ? (
                        <Text className="text-xl">{getFlagEmoji(item.countryCode)}</Text>
                    ) : null}
                    <VStack className="flex-1" space="xs">
                        <Text size="md" className="text-white" numberOfLines={1}>
                            {item.publicationName}
                        </Text>
                        <Text size="xs" className="text-gray-400">
                            Last read {formatRelativeAgo(item.lastVisitedAt)}
                        </Text>
                    </VStack>
                    <Box className="px-2.5 py-1 rounded-full border border-white">
                        <Text size="xs" bold className="text-white">
                            {item.visitCount}
                        </Text>
                    </Box>
                    <MaterialIcons name="chevron-right" size={20} color="#999999" />
                </HStack>
            </Pressable>
        ),
        [handlePublicationPress],
    );

    const ListHeader = (
        <Box className="mx-4 mt-3 mb-2 p-3 rounded-lg border border-white">
            <Text size="xs" italic className="text-white">
                {t('publicationVisits.screenIntro')}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title="Publications you've visited"
                subtitle="Last 30 days"
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="visibility-off" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        You haven&apos;t read any articles yet.
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    ListHeaderComponent={ListHeader}
                    contentContainerStyle={{ paddingBottom: 20 }}
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

export default VisitedPublicationsList;
