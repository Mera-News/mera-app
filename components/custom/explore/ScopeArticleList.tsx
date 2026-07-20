import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import ArticleService from '@/lib/article-service';
import type { ExploreScope } from '@/lib/explore/scopes';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PAGE_SIZE = 10;

interface ScopeArticleListProps {
    readonly scope: ExploreScope;
}

/**
 * The Explore tab's article list for one scope. DIRECT server-paginated
 * `articlesForCountry` — no scoring, no suggestions, nothing persisted.
 * Every scope (World or country) fetches a single `articlesForCountry` page
 * per load, straight through — no client-side geo filtering (see
 * lib/explore/geo-scope-filter.ts, deprecated).
 *
 * Mounted with a `key={scope.id}` by the parent, so switching scope resets all
 * state via remount.
 */
const ScopeArticleList: React.FC<ScopeArticleListProps> = ({ scope }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);

    // Fetch one page for this scope's country (or GLOBAL for World).
    const loadFrom = useCallback(
        async (after?: string): Promise<{ rows: NewsArticle[]; cursor: string | null; more: boolean }> => {
            const fetchArg = scope.countryCodeAlpha3 ?? 'GLOBAL';
            const page = await ArticleService.getArticlesForCountry(fetchArg, {
                first: PAGE_SIZE,
                after,
            });
            return {
                rows: page.articles as NewsArticle[],
                cursor: page.pageInfo.endCursor ?? null,
                more: page.pageInfo.hasNextPage,
            };
        },
        [scope],
    );

    useEffect(() => {
        if (hasFetched.current) return;
        hasFetched.current = true;
        (async () => {
            try {
                setIsLoading(true);
                const { rows, cursor, more } = await loadFrom();
                setArticles(rows);
                setEndCursor(cursor);
                setHasNextPage(more);
            } catch (error) {
                logger.captureException(error, {
                    tags: { screen: 'ScopeArticleList', method: 'load', scope: scope.kind },
                });
            } finally {
                setIsLoading(false);
            }
        })();
    }, [loadFrom, scope.kind]);

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;
        try {
            setIsLoadingMore(true);
            const { rows, cursor, more } = await loadFrom(endCursor);
            setArticles((prev) => [...prev, ...rows]);
            setEndCursor(cursor);
            setHasNextPage(more);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'ScopeArticleList', method: 'loadMore', scope: scope.kind },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, loadFrom, scope.kind]);

    const handlePress = useCallback((article: NewsArticle) => {
        router.push({ pathname: '/logged-in/article-detail', params: { articleId: article._id } });
    }, []);

    const renderItem: ListRenderItem<NewsArticle> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item}
                onPress={() => handlePress(item)}
                showActions
                subjectExtras={{ origin: 'article', surface: 'explore', scopeKey: scope.id }}
            />
        ),
        [handlePress, scope.id],
    );

    const keyExtractor = useCallback(
        (item: NewsArticle, index: number) => item._id || `article-${index}`,
        [],
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

    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (articles.length === 0) {
        return (
            <VStack className="flex-1 items-center justify-center p-6" space="md">
                <MaterialIcons name="article" size={48} color="#666666" />
                <Text size="md" className="text-gray-400 text-center">
                    {t('explore.noArticles')}
                </Text>
            </VStack>
        );
    }

    return (
        <FlatList
            data={articles}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={{ padding: 16, paddingBottom: TAB_BAR_HEIGHT + insets.bottom + 20 }}
            showsVerticalScrollIndicator={false}
            onScroll={notifyScrollTick}
            scrollEventThrottle={16}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            ListFooterComponent={ListFooterComponent}
        />
    );
};

export default ScopeArticleList;
