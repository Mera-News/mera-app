import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import { FormattedDate } from '@/components/custom/FormattedDate';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import SmoothScrollView, { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import type { NewsArticle, NewsCluster } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { getArticleTranslatableStatus, getLanguageName } from '@/lib/translation-service';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface NewsClusterScreenProps {
    clusterId: string;
    onBack: () => void;
}

const SCROLL_THRESHOLD = 300;

const NewsClusterScreen: React.FC<NewsClusterScreenProps> = ({ clusterId, onBack }) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const [clusterData, setClusterData] = useState<NewsCluster | null>(null);
    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const insets = useSafeAreaInsets();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);

    const handleScrollPositionChange = useCallback((y: number) => {
        setShowScrollToTop(y > SCROLL_THRESHOLD);
    }, []);

    const scrollToTop = useCallback(() => {
        scrollViewRef.current?.scrollToTop(true);
    }, []);

    // Phase 1: Fetch cluster data immediately
    useEffect(() => {
        const loadCluster = async () => {
            try {
                setIsLoading(true);
                const data = await ArticleService.getNewsClusterForUser(clusterId, { first: 10 });
                setClusterData(data);
                const initial = (data.articles?.articles ?? []).filter((a) => a.article_url);
                setArticles(initial);
                setEndCursor(data.articles?.pageInfo.endCursor ?? null);
                setHasNextPage(data.articles?.pageInfo.hasNextPage ?? false);
                setError(null);
            } catch (err) {
                logger.captureException(err, {
                    tags: { screen: 'NewsClusterScreen', method: 'loadCluster' },
                    extra: { clusterId },
                });
                setError(t('newsCluster.failedToLoad'));
            } finally {
                setIsLoading(false);
            }
        };

        loadCluster();
    }, [clusterId]);

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;
        setIsLoadingMore(true);
        try {
            const next = await ArticleService.getNewsClusterForUser(clusterId, {
                first: 10,
                after: endCursor,
            });
            const newArticles = (next.articles?.articles ?? []).filter((a) => a.article_url);
            setArticles((prev) => [...prev, ...newArticles]);
            setEndCursor(next.articles?.pageInfo.endCursor ?? null);
            setHasNextPage(next.articles?.pageInfo.hasNextPage ?? false);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'NewsClusterScreen', method: 'loadMore' },
                extra: { clusterId },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [clusterId, endCursor, hasNextPage, isLoadingMore]);

    const handleArticlePress = async (article: NewsArticle) => {
        if (!article.article_url) return;

        try {
            await openInAppBrowser(article.article_url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'NewsClusterScreen', method: 'handleArticlePress' },
            });
        }
    };

    if (isLoading) {
        return (
            <Box className="flex-1 bg-black items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (error || !clusterData) {
        return (
            <Box className="flex-1 bg-black items-center justify-center p-5">
                <MaterialIcons name="error-outline" size={48} color="#EF4444" />
                <Text size="lg" className="text-white mt-4 text-center">
                    {error || t('newsCluster.clusterNotFound')}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-gray-800 rounded-lg px-6 py-3">
                    <Text size="md" className="text-white">{t('common.goBack')}</Text>
                </Pressable>
            </Box>
        );
    }

    // Headline article: first article in the cluster's natural order (matches
    // what the list card shows). Don't gate on article_url here — that filter
    // exists for the Coverage list and would otherwise flip the title between
    // list and detail when articles[0] has no URL.
    const headlineArticle = clusterData.articles?.articles?.[0];
    const firstArticle = articles[0];
    const clusterImageUrl = headlineArticle?.image_url ?? null;
    const displayTitle =
        headlineArticle?.title_en_internal_only
        ?? headlineArticle?.title
        ?? '';
    const sourceLanguage = headlineArticle?.original_language_code ?? null;
    const publicationName = firstArticle?.publicationSource?.publication_name ?? null;
    const countryCode = firstArticle?.publicationSource?.country_code ?? null;

    return (
        <Box className="flex-1 bg-black">
            {/* Floating Back Button */}
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>
            </Box>

            {/* Content */}
            <SmoothScrollView
                ref={scrollViewRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingTop: insets.top }}
                headerHeight={240}
                onScrollPositionChange={handleScrollPositionChange}
                onEndReached={loadMore}
                parallaxHeader={
                    clusterImageUrl ? (
                        <Box className="w-full h-full">
                            <Image
                                source={{ uri: clusterImageUrl }}
                                alt={displayTitle || 'Cluster'}
                                className="w-full h-full"
                                resizeMode="cover"
                            />
                        </Box>
                    ) : undefined
                }
            >
                <VStack className="p-5" space="lg">
                    {/* First Seen Date + Publication */}
                    <HStack className="items-center justify-between mt-10">
                        <FormattedDate
                            dateString={clusterData.createdAt}
                            size="sm"
                            className="text-gray-400"
                        />
                        {publicationName ? (
                            <Text size="sm" className="text-gray-400">
                                {publicationName}{countryCode ? ` · ${countryCode.toUpperCase()}` : ''}
                            </Text>
                        ) : null}
                    </HStack>

                    {/* Headline */}
                    <TranslatableDynamic
                        as="heading"
                        text={displayTitle || t('feed.newsCluster')}
                        originalText={headlineArticle?.title ?? undefined}
                        originalLanguage={sourceLanguage ?? undefined}
                        size="xl"
                        className="text-white"
                        style={{ paddingTop: 8 }}
                    />

                    {/* Translation status */}
                    {(() => {
                        const status = getArticleTranslatableStatus(sourceLanguage, appLanguage);
                        if (status === 'same-language') return null;
                        const translatable = status === 'translatable';
                        const languageName =
                            getLanguageName(sourceLanguage)
                            ?? t('clusterDetail.unknownLanguage');
                        return (
                            <HStack className="items-center justify-center px-2" space="xs">
                                <MaterialIcons
                                    name="translate"
                                    size={14}
                                    color={translatable ? '#86EFAC' : '#FCA5A5'}
                                />
                                <Text
                                    size="xs"
                                    italic
                                    className={`flex-1 ${translatable ? 'text-green-300' : 'text-red-300'}`}
                                >
                                    {t(
                                        translatable
                                            ? 'clusterDetail.translatable'
                                            : 'clusterDetail.notTranslatable',
                                        { language: languageName },
                                    )}
                                </Text>
                            </HStack>
                        );
                    })()}

                    {/* Articles */}
                    <VStack space="md">
                        <Heading size="md" className="text-gray-300">
                            {t('newsCluster.coverage')}
                        </Heading>
                        {articles.length > 0 ? (
                            articles.map((article, index) => (
                                <CompactPublisherNewsCard
                                    key={article._id || `article-${index}`}
                                    article={article}
                                    onPress={() => handleArticlePress(article)}
                                />
                            ))
                        ) : (
                            <Box className="bg-gray-800 rounded-lg p-4">
                                <Text size="sm" className="text-gray-400 text-center">
                                    {t('newsCluster.noArticles')}
                                </Text>
                            </Box>
                        )}
                        {isLoadingMore ? (
                            <Box className="items-center py-4">
                                <Spinner size="small" />
                            </Box>
                        ) : null}
                    </VStack>

                    {/* Bottom padding for safe area */}
                    <Box style={{ height: insets.bottom + 20 }} />
                </VStack>
            </SmoothScrollView>
            <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />
        </Box>
    );
};

export default NewsClusterScreen;
