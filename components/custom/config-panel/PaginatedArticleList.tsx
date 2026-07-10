import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { ArticlesForPublicationSourceResponse, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useThemeColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

type ArticlePage = Pick<ArticlesForPublicationSourceResponse, 'articles' | 'pageInfo'>;

interface PaginatedArticleListProps {
    readonly title: string;
    readonly subtitle?: string;
    /**
     * Fetch one page of articles. `after` is the opaque cursor from the
     * previous page (undefined for the first page). The component owns the
     * loading/cursor/infinite-scroll state; callers just supply the page
     * fetcher (per-feed, per-publisher, or per-country).
     */
    readonly loadPage: (after?: string) => Promise<ArticlePage>;
    readonly onBack: () => void;
    /** Tag used for error logging (e.g. the screen name). */
    readonly logScope?: string;
}

const PaginatedArticleList: React.FC<PaginatedArticleListProps> = ({
    title,
    subtitle,
    loadPage,
    onBack,
    logScope = 'PaginatedArticleList',
}) => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    // Keep the latest loadPage without making it a fetch trigger — callers
    // build it inline each render, so depending on it would re-fetch in a loop.
    const loadPageRef = useRef(loadPage);
    loadPageRef.current = loadPage;

    useEffect(() => {
        if (hasFetched.current) return;
        hasFetched.current = true;
        (async () => {
            try {
                setIsLoading(true);
                const response = await loadPageRef.current();
                setArticles(response.articles);
                setEndCursor(response.pageInfo.endCursor ?? null);
                setHasNextPage(response.pageInfo.hasNextPage);
            } catch (error) {
                logger.captureException(error, {
                    tags: { screen: logScope, method: 'loadArticles' },
                });
            } finally {
                setIsLoading(false);
            }
        })();
    }, [logScope]);

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;

        try {
            setIsLoadingMore(true);
            const response = await loadPageRef.current(endCursor);
            setArticles((prev) => [...prev, ...response.articles]);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: logScope, method: 'loadMore' },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, logScope]);

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
            <DrillDownHeader title={title} subtitle={subtitle} onBack={onBack} />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : articles.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="article" size={48} color={colors.iconMuted} />
                    <Text size="md" className="text-typography-500 text-center">
                        {t('sources.noArticlesFound')}
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

export default PaginatedArticleList;
