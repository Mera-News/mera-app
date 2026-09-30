import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import PublicationListRow from '@/components/custom/publication-page/PublicationListRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { hostOf } from '@/components/custom/publication-page/publication-format';
import { usePublicationPrefLevels } from '@/components/custom/publication-page/use-publication-pref-levels';
import logger from '@/lib/logger';
import type { NewsPublisher } from '@/lib/source-service';
import { SourceService } from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

/**
 * Sources > one country: its publications, one plain row each (name, website
 * host, the current more/fewer state as a glyph, a chevron). A tap opens the
 * publication page, which holds more/fewer, Top headlines and Subscribe.
 *
 * There are NO feeds on this screen, by design: the app shows publications
 * and news, never the RSS feeds behind them. The page is PUSHED over this
 * list, so Back returns to the same country and scroll position.
 */
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
    const prefLevelFor = usePublicationPrefLevels();
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

    const renderPublisher: ListRenderItem<NewsPublisher> = useCallback(
        ({ item }) => {
            const host = hostOf(item.website_url);
            return (
                <PublicationListRow
                    rawName={item.name}
                    subtitle={host}
                    prefLevel={prefLevelFor(item.name)}
                    onPress={() =>
                        openPublicationPage({ publisherId: item._id, rawName: item.name, countryCode: item.country_code })
                    }
                    testID={`sources-publisher-${item._id}`}
                />
            );
        },
        [prefLevelFor],
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
