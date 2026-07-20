import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import ArticleService from '@/lib/article-service';
import { blendTopStories, getPersonaStableIds, type BlendedHeadline, type BlendInput } from '@/lib/explore/top-stories';
import type { NewsArticle, TopHeadline } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PAGE_SIZE = 25;

interface TopStoriesListProps {
    /** Home country's alpha-3 fetch code, or null when no home resolves
     *  (device country unmappable and no locations) — the blend then runs on
     *  the GLOBAL edition alone. */
    readonly homeCountryAlpha3: string | null;
}

function dedupeKey(h: Pick<BlendedHeadline, 'stableClusterId' | 'article'>): string {
    return h.stableClusterId ? `cluster:${h.stableClusterId}` : `article:${h.article._id}`;
}

function toBlendInputs(
    headlines: readonly TopHeadline[],
    source: 'global' | 'home',
    rankOffset: number,
): BlendInput[] {
    return headlines.map((h, i) => ({
        article: h.article,
        stableClusterId: h.stableClusterId ?? null,
        clusterSize: h.clusterSize,
        editionRank: rankOffset + i,
        source,
    }));
}

/**
 * The Explore tab's 'top' scope — a blended GLOBAL + home-country feed (see
 * lib/explore/top-stories.ts for the pure blend + persona-signal helper).
 * Sibling of ScopeArticleList (same row rendering/paddings/scroll-tick), but
 * fetches two editions in parallel per page instead of one.
 *
 * Mounted with a `key={scope.id}` by the parent (ExploreScreen), so switching
 * away from and back to the 'top' scope resets all state via remount.
 */
const TopStoriesList: React.FC<TopStoriesListProps> = ({ homeCountryAlpha3 }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [items, setItems] = useState<BlendedHeadline[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const hasFetched = useRef(false);
    const shownKeys = useRef<Set<string>>(new Set());
    const personaIds = useRef<Set<string>>(new Set());

    const globalCursor = useRef<string | null>(null);
    const globalHasMore = useRef(false);
    const globalRank = useRef(0);
    const homeCursor = useRef<string | null>(null);
    const homeHasMore = useRef(false);
    const homeRank = useRef(0);

    const fetchEdition = useCallback(
        async (
            countryArg: string,
            after?: string,
        ): Promise<{ headlines: TopHeadline[]; cursor: string | null; hasMore: boolean }> => {
            const page = await ArticleService.getTopHeadlinesForCountry(countryArg, { first: PAGE_SIZE, after });
            return {
                headlines: page.headlines,
                cursor: page.pageInfo.endCursor ?? null,
                hasMore: page.pageInfo.hasNextPage,
            };
        },
        [],
    );

    useEffect(() => {
        if (hasFetched.current) return;
        hasFetched.current = true;
        (async () => {
            try {
                setIsLoading(true);
                const [persona, globalPage, homePage] = await Promise.all([
                    getPersonaStableIds().catch(() => new Set<string>()),
                    ArticleService.getTopHeadlinesForCountry('GLOBAL', { first: PAGE_SIZE }),
                    homeCountryAlpha3
                        ? ArticleService.getTopHeadlinesForCountry(homeCountryAlpha3, { first: PAGE_SIZE })
                        : null,
                ]);
                personaIds.current = persona;

                globalCursor.current = globalPage.pageInfo.endCursor ?? null;
                globalHasMore.current = globalPage.pageInfo.hasNextPage;
                const globalInputs = toBlendInputs(globalPage.headlines, 'global', globalRank.current);
                globalRank.current += globalPage.headlines.length;

                let homeInputs: BlendInput[] = [];
                if (homePage) {
                    homeCursor.current = homePage.pageInfo.endCursor ?? null;
                    homeHasMore.current = homePage.pageInfo.hasNextPage;
                    homeInputs = toBlendInputs(homePage.headlines, 'home', homeRank.current);
                    homeRank.current += homePage.headlines.length;
                }

                const blended = blendTopStories(globalInputs, homeInputs, personaIds.current);
                shownKeys.current = new Set(blended.map(dedupeKey));
                setItems(blended);
            } catch (error) {
                logger.captureException(error, {
                    tags: { screen: 'TopStoriesList', method: 'load' },
                });
            } finally {
                setIsLoading(false);
            }
        })();
    }, [homeCountryAlpha3]);

    const loadMore = useCallback(async () => {
        if (isLoadingMore) return;
        if (!globalHasMore.current && !homeHasMore.current) return;
        try {
            setIsLoadingMore(true);
            const [globalPage, homePage] = await Promise.all([
                globalHasMore.current && globalCursor.current
                    ? fetchEdition('GLOBAL', globalCursor.current)
                    : Promise.resolve(null),
                homeHasMore.current && homeCursor.current && homeCountryAlpha3
                    ? fetchEdition(homeCountryAlpha3, homeCursor.current)
                    : Promise.resolve(null),
            ]);

            let globalInputs: BlendInput[] = [];
            if (globalPage) {
                globalCursor.current = globalPage.cursor;
                globalHasMore.current = globalPage.hasMore;
                globalInputs = toBlendInputs(globalPage.headlines, 'global', globalRank.current);
                globalRank.current += globalPage.headlines.length;
            }
            let homeInputs: BlendInput[] = [];
            if (homePage) {
                homeCursor.current = homePage.cursor;
                homeHasMore.current = homePage.hasMore;
                homeInputs = toBlendInputs(homePage.headlines, 'home', homeRank.current);
                homeRank.current += homePage.headlines.length;
            }

            const blendedTail = blendTopStories(globalInputs, homeInputs, personaIds.current);
            const fresh = blendedTail.filter((h) => !shownKeys.current.has(dedupeKey(h)));
            for (const h of fresh) shownKeys.current.add(dedupeKey(h));

            if (fresh.length > 0) {
                setItems((prev) => [...prev, ...fresh]);
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'TopStoriesList', method: 'loadMore' },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [fetchEdition, homeCountryAlpha3, isLoadingMore]);

    const handlePress = useCallback((article: NewsArticle) => {
        router.push({ pathname: '/logged-in/article-detail', params: { articleId: article._id } });
    }, []);

    const renderItem: ListRenderItem<BlendedHeadline> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item.article}
                onPress={() => handlePress(item.article)}
                showActions
                subjectExtras={{
                    origin: 'article',
                    surface: 'explore',
                    scopeKey: 'top-stories',
                    stableClusterId: item.stableClusterId ?? undefined,
                }}
            />
        ),
        [handlePress],
    );

    const keyExtractor = useCallback((item: BlendedHeadline, index: number) => item.article._id || `top-${index}`, []);

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

    if (items.length === 0) {
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
            data={items}
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

export default TopStoriesList;
