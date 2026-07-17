import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import ArticleService from '@/lib/article-service';
import { filterArticlesForScope } from '@/lib/explore/geo-scope-filter';
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
/** For a filtered (city/region) scope, keep pulling country pages until we have
 *  at least this many matches — filtering can render a page thin. */
const MIN_MATCHES_PER_LOAD = 6;
/** Bound on country-page fetches per load, so a scarcely-tagged scope can't spin
 *  the network indefinitely. */
const MAX_PAGE_FETCHES = 5;

interface ScopeArticleListProps {
    readonly scope: ExploreScope;
}

/**
 * The Explore tab's article list for one scope. DIRECT server-paginated
 * `articlesForCountry` — no scoring, no suggestions, nothing persisted.
 *
 * • World / country scopes: fetch pages straight through.
 * • City / region scopes: fetch the COUNTRY's pages and filter on-device by the
 *   articles' `geo_tags` (lib/explore/geo-scope-filter). Because filtering
 *   discards rows, each "load" pulls up to {@link MAX_PAGE_FETCHES} country
 *   pages until it has {@link MIN_MATCHES_PER_LOAD} matches, then surfaces a
 *   "add it as a location" nudge once the country is exhausted.
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

    const isFiltered = scope.kind === 'city' || scope.kind === 'region';

    // Fetch one "load": a single country page for World/country scopes, or a
    // bounded run of country pages accumulated + filtered for city/region.
    const loadFrom = useCallback(
        async (after?: string): Promise<{ rows: NewsArticle[]; cursor: string | null; more: boolean }> => {
            const fetchArg = scope.countryCodeAlpha3 ?? 'GLOBAL';
            const collected: NewsArticle[] = [];
            let cursor: string | undefined = after;
            let more = false;

            for (let i = 0; i < (isFiltered ? MAX_PAGE_FETCHES : 1); i += 1) {
                const page = await ArticleService.getArticlesForCountry(fetchArg, {
                    first: PAGE_SIZE,
                    after: cursor,
                });
                collected.push(...filterArticlesForScope(page.articles as NewsArticle[], scope));
                cursor = page.pageInfo.endCursor ?? undefined;
                more = page.pageInfo.hasNextPage;
                if (!isFiltered || !more || collected.length >= MIN_MATCHES_PER_LOAD) break;
            }

            return { rows: collected, cursor: cursor ?? null, more };
        },
        [scope, isFiltered],
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
        ({ item }) => <CompactPublisherNewsCard article={item} onPress={() => handlePress(item)} />,
        [handlePress],
    );

    const keyExtractor = useCallback(
        (item: NewsArticle, index: number) => item._id || `article-${index}`,
        [],
    );

    // "Add it as a location" nudge — shown as the list footer once a filtered
    // scope's country is exhausted (matches can be sparse: geo-tagging is
    // dormant in prod), and as the empty state when there are zero matches.
    const ThinNudge = useCallback(
        () => (
            <VStack className="items-center px-6 py-8" space="md">
                <MaterialIcons name="add-location-alt" size={40} color="#666666" />
                <Text size="md" bold className="text-white text-center">
                    {t('explore.thinContentTitle', { place: scope.label })}
                </Text>
                <Text size="sm" className="text-typography-400 text-center">
                    {t('explore.thinContentBody', { place: scope.label })}
                </Text>
                <Button
                    size="sm"
                    className="bg-primary-400 mt-1"
                    onPress={() => router.push('/logged-in/app_container/profile')}
                >
                    <ButtonText>{t('explore.addLocation')}</ButtonText>
                </Button>
            </VStack>
        ),
        [t, scope.label],
    );

    const ListFooterComponent = useCallback(() => {
        if (isLoadingMore) {
            return (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            );
        }
        if (isFiltered && !hasNextPage && articles.length > 0) return <ThinNudge />;
        return null;
    }, [isLoadingMore, isFiltered, hasNextPage, articles.length, ThinNudge]);

    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (articles.length === 0) {
        if (isFiltered) {
            return (
                <Box className="flex-1 justify-center">
                    <ThinNudge />
                </Box>
            );
        }
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
