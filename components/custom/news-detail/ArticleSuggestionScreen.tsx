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
import {
    deleteSuggestionByServerId,
    getSuggestionByServerId,
} from '@/lib/database/services/article-suggestion-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { getArticleTranslatableStatus, getLanguageName } from '@/lib/translation-service';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleSuggestionScreenProps {
    articleSuggestionId: string;
    onBack: () => void;
}

const SCROLL_THRESHOLD = 300;

/**
 * Detail screen for a single ArticleSuggestion. Header shows the primary
 * article from the local DB row; "Related articles" calls
 * relatedArticles(articleId) lazily on mount via Apollo (no-cache). Sibling
 * articles in the live cluster appear there — never previewed on the feed
 * card.
 */
const ArticleSuggestionScreen: React.FC<ArticleSuggestionScreenProps> = ({
    articleSuggestionId,
    onBack,
}) => {
    const { t } = useTranslation();
    const storeSuggestion = useForYouStore((s) =>
        s.suggestions.find((sg) => sg._id === articleSuggestionId),
    );
    const [suggestion, setSuggestion] = useState<ForYouSuggestion | null>(
        storeSuggestion ?? null,
    );
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isLoading, setIsLoading] = useState(!storeSuggestion);
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

    // Hydrate the suggestion from local DB if it wasn't already in the store
    // (e.g. deep-link from notification before store hydration completes).
    useEffect(() => {
        if (storeSuggestion) {
            setSuggestion(storeSuggestion);
            setIsLoading(false);
            return;
        }
        let cancelled = false;
        getSuggestionByServerId(articleSuggestionId)
            .then((row) => {
                if (cancelled) return;
                if (!row) {
                    setError(t('articleDetail.storyUnavailable'));
                } else {
                    setSuggestion(row);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                logger.captureException(err, {
                    tags: { screen: 'ArticleSuggestionScreen', method: 'loadLocal' },
                    extra: { articleSuggestionId },
                });
                setError(t('articleDetail.failedToLoad'));
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [articleSuggestionId, storeSuggestion]);

    // Lazy-load related articles once we know the article id.
    useEffect(() => {
        const articleId = suggestion?.articleId;
        if (!articleId) return;
        let cancelled = false;
        setIsLoadingRelated(true);
        ArticleService.getRelatedArticles(articleId)
            .then((rows) => {
                if (!cancelled) setRelated(rows);
            })
            .catch((err) => {
                logger.captureException(err, {
                    tags: { screen: 'ArticleSuggestionScreen', method: 'getRelatedArticles' },
                    extra: { articleId },
                });
                // Non-fatal — related articles are supplementary
            })
            .finally(() => {
                if (!cancelled) setIsLoadingRelated(false);
            });
        return () => {
            cancelled = true;
        };
    }, [suggestion?.articleId]);

    // Sibling articles sharing a cluster with this article (the user's other
    // cards for the same story) are fetched live from the server via
    // `relatedArticles(articleId)` above — the feed's collapse keeps only one
    // representative card per story, so siblings are surfaced here on demand.

    const handleArticleUrlPress = async (url: string | null | undefined) => {
        if (!url) return;
        if (suggestion) {
            recordPublicationVisit({
                publicationName: suggestion.publication_name,
                countryCode: suggestion.country_code,
                articleId: suggestion.articleId,
                articleSuggestionId: suggestion._id,
                articleUrl: url,
                titleEn: suggestion.title_en,
                languageCode: suggestion.language_code,
                imageUrl: suggestion.image_url,
                pubDate: suggestion.firstPubDate ?? suggestion.createdAt,
            }).catch(() => {});
        }
        try {
            await openInAppBrowser(url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleSuggestionScreen', method: 'openUrl' },
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

    if (error || !suggestion) {
        // If the local row vanished, drop the stale card from the feed.
        if (!suggestion) {
            deleteSuggestionByServerId(articleSuggestionId).catch(() => {});
            useForYouStore.getState().removeSuggestion(articleSuggestionId);
        }
        return (
            <Box className="flex-1 bg-black items-center justify-center p-5">
                <MaterialIcons name="error-outline" size={48} color="#EF4444" />
                <Text size="lg" className="text-white mt-4 text-center">
                    {error || t('articleDetail.articleNotFound')}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-gray-800 rounded-lg px-6 py-3">
                    <Text size="md" className="text-white">{t('common.goBack')}</Text>
                </Pressable>
            </Box>
        );
    }

    const sourceLanguage = suggestion.language_code ?? null;

    // Map ArticleSummary → NewsArticle-shaped object for CompactPublisherNewsCard
    // (the existing card type works against NewsArticle fields).
    const toNewsArticle = (a: ArticleSummary): NewsArticle => ({
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
            <ArticleSuggestionContainer
                suggestion={suggestion}
                variant="screen"
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                contentTopInset={insets.top}
                contentBottomInset={insets.bottom + 20}
                aboveReason={
                    <PublicationVisitBadge
                        publicationName={suggestion.publication_name}
                        countryCode={suggestion.country_code}
                    />
                }
                footer={
                    <>
                        {/* Read Article CTA */}
                        {suggestion.article_url ? (
                            <VStack space="xs">
                                <Button
                                    variant="outline"
                                    action="primary"
                                    onPress={() => handleArticleUrlPress(suggestion.article_url)}
                                >
                                    <ButtonIcon as={() => <MaterialIcons name="open-in-new" size={18} color="#ffffff" />} />
                                    <ButtonText className="text-white ml-2">{t('articleDetail.readArticle')}</ButtonText>
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
                                                {translatable && Platform.OS === 'ios' && (
                                                    <Text
                                                        size="xs"
                                                        italic
                                                        className="text-orange-400 underline"
                                                        onPress={() => openInAppBrowser(TRANSLATION_GUIDE_URL).catch(() => {})}
                                                    >
                                                        {' '}{t('clusterDetail.translationGuideLink')}
                                                    </Text>
                                                )}
                                            </Text>
                                        </HStack>
                                    );
                                })()}
                            </VStack>
                        ) : null}

                        {/* Related Articles — sibling ArticleSuggestions
                            (the user's other personalized cards for this
                            story) render first as compact cards, then the
                            live cluster siblings from the server below. */}
                        {(isLoadingRelated || related.length > 0) && (
                            <VStack space="md">
                                <Heading size="md" className="text-gray-300">
                                    {t('articleDetail.relatedArticles')}
                                </Heading>
                                {isLoadingRelated && related.length === 0 ? (
                                    <Box className="items-center justify-center py-4">
                                        <Spinner size="small" />
                                    </Box>
                                ) : (
                                    <>
                                        {related.map((a, index) => (
                                            <CompactPublisherNewsCard
                                                key={a._id || `related-${index}`}
                                                article={toNewsArticle(a)}
                                                onPress={() => router.push({
                                                    pathname: '/logged-in/article-detail',
                                                    params: { articleId: a._id },
                                                })}
                                            />
                                        ))}
                                    </>
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

export default ArticleSuggestionScreen;
