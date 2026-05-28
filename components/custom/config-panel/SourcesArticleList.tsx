import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

interface SourcesArticleListProps {
    readonly title: string;
    readonly publisherName?: string;
    readonly publicationSourceId: string;
    readonly onBack: () => void;
}

const SourcesArticleList: React.FC<SourcesArticleListProps> = ({ title, publisherName, publicationSourceId, onBack }) => {
    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    useEffect(() => {
        if (publicationSourceId && !hasFetched.current) {
            hasFetched.current = true;
            loadArticles();
        }
        // Fetch once per publicationSourceId (guarded by hasFetched ref);
        // loadArticles is defined below and excluded to avoid re-fetch loops.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [publicationSourceId]);

    const loadArticles = async () => {
        try {
            setIsLoading(true);
            const response = await ArticleService.getArticlesForPublicationSource(publicationSourceId, {
                first: 10,
            });
            setArticles(response.articles);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesArticleList', method: 'loadArticles' },
                extra: { publicationSourceId },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;

        try {
            setIsLoadingMore(true);
            const response = await ArticleService.getArticlesForPublicationSource(publicationSourceId, {
                first: 10,
                after: endCursor,
            });
            setArticles((prev) => [...prev, ...response.articles]);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesArticleList', method: 'loadMore' },
                extra: { publicationSourceId },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, publicationSourceId]);

    const handleArticlePress = useCallback((article: NewsArticle) => {
        router.push({
            pathname: '/logged-in/article-detail',
            params: { articleId: article._id },
        });
    }, []);

    const renderItem: ListRenderItem<NewsArticle> = useCallback(
        ({ item }) => (
            <CompactPublisherNewsCard
                article={item}
                onPress={() => handleArticlePress(item)}
            />
        ),
        [handleArticlePress]
    );

    const keyExtractor = useCallback(
        (item: NewsArticle, index: number) => item._id || `article-${index}`,
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
            <DrillDownHeader
                title={title}
                subtitle={publisherName}
                onBack={onBack}
            />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : articles.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="article" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        No articles found
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={articles}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.5}
                    ListFooterComponent={ListFooterComponent}
                />
            )}
        </Box>
    );
};

export default SourcesArticleList;
