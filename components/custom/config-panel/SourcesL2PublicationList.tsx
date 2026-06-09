import {
    Accordion,
    AccordionContent,
    AccordionHeader,
    AccordionIcon,
    AccordionItem,
    AccordionTitleText,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import type { NewsPublisher, PublicationSource } from '@/lib/source-service';
import { SourceService } from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ChevronDownIcon } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

const formatCategory = (category: string): string =>
    category === 'general_news' ? 'All' : category;

interface SourcesL2PublisherListProps {
    readonly countryCode: string;
    readonly countryName: string;
    readonly onBack: () => void;
}

const SourcesL2PublisherList: React.FC<SourcesL2PublisherListProps> = ({ countryCode, countryName, onBack }) => {
    const { t } = useTranslation();
    const [publishers, setPublishers] = useState<NewsPublisher[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    useEffect(() => {
        if (countryCode && !hasFetched.current) {
            hasFetched.current = true;
            loadPublishers();
        }
        // Fetch once per countryCode (guarded by hasFetched ref); loadPublishers
        // is defined below and intentionally excluded to avoid re-fetch loops.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [countryCode]);

    const loadPublishers = async () => {
        try {
            setIsLoading(true);
            const response = await SourceService.getNewsPublishers({
                countryCode,
                first: 5,
            });
            setPublishers(response.newsPublishers);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL2PublisherList', method: 'loadPublishers' },
                extra: { countryCode },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;

        try {
            setIsLoadingMore(true);
            const response = await SourceService.getNewsPublishers({
                countryCode,
                first: 5,
                after: endCursor,
            });
            setPublishers((prev) => [...prev, ...response.newsPublishers]);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL2PublisherList', method: 'loadMore' },
                extra: { countryCode },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, countryCode]);

    const handleFeedPress = useCallback(
        (feed: PublicationSource, publisherName: string) => {
            router.push({
                pathname: '/logged-in/sources-articles',
                params: { title: formatCategory(feed.category), countryCode, publisherName, publicationSourceId: feed._id },
            });
        },
        [countryCode]
    );

    const renderPublisher: ListRenderItem<NewsPublisher> = useCallback(
        ({ item }) => (
            <Box className="mx-4 mb-3">
                <Accordion type="single" isCollapsible variant="unfilled" className="border border-gray-700 rounded-lg">
                    <AccordionItem value={item._id}>
                        <AccordionHeader>
                            <AccordionTrigger className="px-4 py-3">
                                <VStack className="flex-1 mr-3" space="xs">
                                    <AccordionTitleText className="text-white text-base">
                                        {item.name}
                                    </AccordionTitleText>
                                    {item.website_url && (
                                        <Text size="xs" className="text-gray-500">
                                            {item.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                        </Text>
                                    )}
                                </VStack>
                                <AccordionIcon
                                    as={ChevronDownIcon}
                                    className="text-gray-400"
                                />
                            </AccordionTrigger>
                        </AccordionHeader>
                        <AccordionContent className="px-0 pb-2 pt-0">
                            {item.publicationSources.length === 0 ? (
                                <Text size="sm" className="text-gray-500 px-4 py-2">
                                    {t('sources.noFeedsAvailable')}
                                </Text>
                            ) : (
                                item.publicationSources.map((feed) => (
                                    <Pressable
                                        key={feed._id}
                                        onPress={() => handleFeedPress(feed, item.name)}
                                        className="px-4 py-2.5 border-t border-gray-800"
                                    >
                                        <HStack className="items-center justify-between">
                                            <Text className="text-white text-sm flex-1 mr-3 capitalize">
                                                {formatCategory(feed.category)}
                                            </Text>
                                            <MaterialIcons name="chevron-right" size={18} color="#999999" />
                                        </HStack>
                                    </Pressable>
                                ))
                            )}
                        </AccordionContent>
                    </AccordionItem>
                </Accordion>
            </Box>
        ),
        [handleFeedPress]
    );

    const keyExtractor = useCallback(
        (item: NewsPublisher, index: number) => item._id || `pub-${index}`,
        []
    );

    const ListFooterComponent = useCallback(() => {
        if (isLoadingMore) {
            return (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            );
        }
        return null;
    }, [isLoadingMore]);

    return (
        <Box className="flex-1">
            <DrillDownHeader title={countryName ?? t('sources.publishers')} onBack={onBack} />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : publishers.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="newspaper" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('sources.noPublishers')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={publishers}
                    renderItem={renderPublisher}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.5}
                    ListFooterComponent={ListFooterComponent}
                />
            )}
        </Box>
    );
};

export default SourcesL2PublisherList;
