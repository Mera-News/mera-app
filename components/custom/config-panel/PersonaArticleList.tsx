import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import type { NewsArticle, NewsCluster } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

interface PersonaArticleListProps {
    readonly interestId: string;
    readonly interestText: string;
    readonly onBack: () => void;
}

// Project a cluster down to its lead article (the first one returned by the
// embedded articles connection). Clusters with an empty article list are
// dropped — there's nothing to render for them.
const clustersToLeadArticles = (clusters: NewsCluster[]): NewsArticle[] => {
    const out: NewsArticle[] = [];
    for (const c of clusters) {
        const lead = c.articles?.articles?.[0];
        if (lead) out.push(lead as NewsArticle);
    }
    return out;
};

const PersonaArticleList: React.FC<PersonaArticleListProps> = ({ interestId, interestText, onBack }) => {
    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    useEffect(() => {
        if (interestId && !hasFetched.current) {
            hasFetched.current = true;
            loadArticles();
        }
        // Fetch once per interestId (guarded by hasFetched ref); loadArticles is
        // defined below and intentionally excluded to avoid re-fetch loops.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interestId]);

    const loadArticles = async () => {
        try {
            setIsLoading(true);
            const response = await ArticleService.getNewsClusters({
                userTopicId: interestId,
                first: 10,
            });
            setArticles(clustersToLeadArticles(response.newsClusters));
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'PersonaArticleList', method: 'loadArticles' },
                extra: { interestId },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;

        try {
            setIsLoadingMore(true);
            const response = await ArticleService.getNewsClusters({
                userTopicId: interestId,
                first: 10,
                after: endCursor,
            });
            setArticles((prev) => [...prev, ...clustersToLeadArticles(response.newsClusters)]);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'PersonaArticleList', method: 'loadMore' },
                extra: { interestId },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, interestId]);

    const handleArticlePress = useCallback(
        (article: NewsArticle) => {
            router.push({
                pathname: '/logged-in/article-detail',
                params: {
                    articleId: article._id,
                },
            });
        },
        []
    );

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
                title={interestText ?? 'Articles'}
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
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.5}
                    ListFooterComponent={ListFooterComponent}
                />
            )}
        </Box>
    );
};

export default PersonaArticleList;
