import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    getVisitsForPublication,
    type VisitedArticle,
} from '@/lib/database/services/publication-visit-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

interface Props {
    readonly publicationName: string;
    readonly countryCode: string | null;
    readonly onBack: () => void;
}

const visitedToNewsArticle = (v: VisitedArticle): NewsArticle =>
    ({
        _id: v.articleId ?? v.articleUrl ?? '',
        title: v.titleOriginal ?? v.titleEn ?? '',
        title_en_internal_only: v.titleEn ?? undefined,
        pubDate: v.pubDate != null ? new Date(v.pubDate).toISOString() : '',
        image_url: v.imageUrl ?? undefined,
        article_url: v.articleUrl ?? undefined,
        original_language_code: v.languageCode ?? undefined,
        publicationSource:
            v.publicationName || v.countryCode
                ? ({
                      _id: v.articleId ?? v.articleUrl ?? '',
                      publication_name: v.publicationName,
                      country_code: v.countryCode,
                  } as NewsArticle['publicationSource'])
                : undefined,
    }) as NewsArticle;

const PublicationArticleHistoryList: React.FC<Props> = ({
    publicationName,
    countryCode,
    onBack,
}) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<VisitedArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const rows = await getVisitsForPublication(publicationName, countryCode);
            setItems(rows);
        } catch (error) {
            logger.captureException(error, {
                tags: {
                    screen: 'PublicationArticleHistoryList',
                    method: 'load',
                },
                extra: { publicationName, countryCode },
            });
        }
    }, [publicationName, countryCode]);

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

    const handleArticlePress = useCallback(async (url: string | null) => {
        if (!url) return;
        try {
            await openInAppBrowser(url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'PublicationArticleHistoryList', method: 'openUrl' },
            });
        }
    }, []);

    const keyExtractor = useCallback(
        (item: VisitedArticle, index: number) =>
            item.articleId ?? item.articleUrl ?? `visit-${index}`,
        [],
    );

    const renderItem: ListRenderItem<VisitedArticle> = useCallback(
        ({ item }) => (
            <Box className="mx-4">
                <CompactPublisherNewsCard
                    article={visitedToNewsArticle(item)}
                    onPress={() => handleArticlePress(item.articleUrl)}
                    hideSource
                />
            </Box>
        ),
        [handleArticlePress],
    );

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={publicationName}
                subtitle={t('publicationVisits.articlesRead')}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="article" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('publicationVisits.noArticlesLast30Days')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
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

export default PublicationArticleHistoryList;
