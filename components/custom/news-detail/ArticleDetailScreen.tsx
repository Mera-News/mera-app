import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import PublicationVisitBadge from '@/components/custom/PublicationVisitBadge';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import { Box } from '@/components/ui/box';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { getArticleTranslatableStatus, getLanguageName } from '@/lib/translation-service';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleDetailScreenProps {
    articleId: string;
    onBack: () => void;
}

const SCROLL_THRESHOLD = 300;

// Map a sibling ArticleSummary to the NewsArticle shape CompactPublisherNewsCard
// expects (same mapping the suggestion-detail screen uses).
const summaryToNewsArticle = (a: ArticleSummary): NewsArticle => ({
    _id: a._id,
    title: a.title_en,
    title_en_internal_only: a.title_en,
    description: a.description_en ?? undefined,
    description_en_internal_only: a.description_en ?? undefined,
    pubDate: a.pubDate,
    article_url: a.article_url ?? undefined,
    image_url: a.image_url ?? undefined,
    original_language_code: a.language_code ?? undefined,
    publicationSource: a.publication_name || a.country_code
        ? ({
            _id: a._id,
            publication_name: a.publication_name,
            country_code: a.country_code,
        } as NewsArticle['publicationSource'])
        : undefined,
} as NewsArticle);

const ArticleDetailScreen: React.FC<ArticleDetailScreenProps> = ({ articleId, onBack }) => {
    const { t } = useTranslation();
    const [article, setArticle] = useState<NewsArticle | null>(null);
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const insets = useSafeAreaInsets();
    const appLanguage = useAppLanguage();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);

    const handleScrollPositionChange = useCallback((y: number) => {
        setShowScrollToTop(y > SCROLL_THRESHOLD);
    }, []);

    const scrollToTop = useCallback(() => {
        scrollViewRef.current?.scrollToTop(true);
    }, []);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        ArticleService.getArticleById(articleId)
            .then((row) => {
                if (cancelled) return;
                if (!row) {
                    setError('This article is no longer available');
                } else {
                    setArticle(row);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                logger.captureException(err, {
                    tags: { screen: 'ArticleDetailScreen', method: 'getArticleById' },
                    extra: { articleId },
                });
                setError('Failed to load article');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    useEffect(() => {
        if (!article?._id) return;
        let cancelled = false;
        setIsLoadingRelated(true);
        ArticleService.getRelatedArticles(article._id)
            .then((rows) => {
                if (!cancelled) setRelated(rows);
            })
            .catch((err) => {
                logger.captureException(err, {
                    tags: { screen: 'ArticleDetailScreen', method: 'getRelatedArticles' },
                    extra: { articleId: article._id },
                });
            })
            .finally(() => {
                if (!cancelled) setIsLoadingRelated(false);
            });
        return () => {
            cancelled = true;
        };
    }, [article?._id]);

    const handleArticleUrlPress = async (url: string | null | undefined) => {
        if (!url) return;
        if (article) {
            recordPublicationVisit({
                publicationName: article.publicationSource?.publication_name ?? null,
                countryCode: article.publicationSource?.country_code ?? null,
                articleId: article._id,
                articleUrl: url,
                titleEn: article.title_en_internal_only ?? article.title ?? null,
                titleOriginal: article.title ?? null,
                languageCode: article.original_language_code ?? null,
                imageUrl: article.image_url ?? null,
                pubDate: article.pubDate ?? null,
            }).catch(() => {});
        }
        try {
            await openInAppBrowser(url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleDetailScreen', method: 'openUrl' },
            });
        }
    };

    const handleRelatedPress = useCallback((relatedArticleId: string) => {
        router.push({
            pathname: '/logged-in/article-detail',
            params: { articleId: relatedArticleId },
        });
    }, []);

    if (isLoading) {
        return (
            <Box className="flex-1 bg-black items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (error || !article) {
        return (
            <Box className="flex-1 bg-black items-center justify-center p-5">
                <MaterialIcons name="error-outline" size={48} color="#EF4444" />
                <Text size="lg" className="text-white mt-4 text-center">
                    {error || 'Article not found'}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-gray-800 rounded-lg px-6 py-3">
                    <Text size="md" className="text-white">Go Back</Text>
                </Pressable>
            </Box>
        );
    }

    const sourceLanguage = article.original_language_code ?? null;
    const articleUrl = article.article_url ?? null;

    return (
        <Box className="flex-1 bg-black">
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>
            </Box>

            <ArticleSuggestionContainer
                article={article}
                variant="screen"
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                contentTopInset={insets.top}
                contentBottomInset={insets.bottom + 20}
                aboveReason={
                    <PublicationVisitBadge
                        publicationName={article.publicationSource?.publication_name}
                        countryCode={article.publicationSource?.country_code}
                    />
                }
                footer={
                    <>
                        {articleUrl ? (
                            <VStack space="xs">
                                <Button
                                    variant="outline"
                                    action="primary"
                                    onPress={() => handleArticleUrlPress(articleUrl)}
                                >
                                    <ButtonIcon as={() => <MaterialIcons name="open-in-new" size={18} color="#ffffff" />} />
                                    <ButtonText className="text-white ml-2">Read Article</ButtonText>
                                </Button>
                                {(() => {
                                    const status = getArticleTranslatableStatus(
                                        sourceLanguage,
                                        appLanguage,
                                    );
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
                            </VStack>
                        ) : null}

                        {(isLoadingRelated || related.length > 0) && (
                            <VStack space="md">
                                <Heading size="md" className="text-gray-300">
                                    Related Articles
                                </Heading>
                                {isLoadingRelated ? (
                                    <Box className="items-center justify-center py-4">
                                        <Spinner size="small" />
                                    </Box>
                                ) : (
                                    related.map((a, index) => (
                                        <CompactPublisherNewsCard
                                            key={a._id || `related-${index}`}
                                            article={summaryToNewsArticle(a)}
                                            onPress={() => handleRelatedPress(a._id)}
                                        />
                                    ))
                                )}
                            </VStack>
                        )}
                    </>
                }
            />
            <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />
        </Box>
    );
};

export default ArticleDetailScreen;
