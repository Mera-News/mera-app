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
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import {
    deleteSuggestionByServerId,
    getSuggestionByServerId,
} from '@/lib/database/services/article-suggestion-service';
import {
    deleteSavedSuggestion,
    getSavedSuggestionByServerId,
    isSuggestionSaved,
    saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { getArticleTranslatableStatus, getLanguageName } from '@/lib/translation-service';
import { useThemeColors } from '@/lib/theme/tokens';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    const colors = useThemeColors();
    const toast = useToast();
    const storeSuggestion = useForYouStore((s) =>
        s.suggestions.find((sg) => sg._id === articleSuggestionId),
    );
    const [suggestion, setSuggestion] = useState<ForYouSuggestion | null>(
        storeSuggestion ?? null,
    );
    const [isSaved, setIsSaved] = useState(false);
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isLoading, setIsLoading] = useState(!storeSuggestion);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const [showGuideVideo, setShowGuideVideo] = useState(false);
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
            // Fall back to the saved table — a saved item's source feed row may
            // have already been pruned by the 48h TTL.
            .then((row) => row ?? getSavedSuggestionByServerId(articleSuggestionId))
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
    }, [articleSuggestionId, storeSuggestion, t]);

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

    // Reflect whether this suggestion is already saved for later.
    useEffect(() => {
        let cancelled = false;
        isSuggestionSaved(articleSuggestionId)
            .then((saved) => {
                if (!cancelled) setIsSaved(saved);
            })
            .catch(() => {
                /* non-fatal — default to unsaved */
            });
        return () => {
            cancelled = true;
        };
    }, [articleSuggestionId]);

    const showSavedToast = useCallback(
        (message: string) => {
            toast.show({
                placement: 'top',
                duration: 3000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="success" variant="solid">
                        <ToastTitle>{t('savedSuggestions.savedToastTitle')}</ToastTitle>
                        <ToastDescription>{message}</ToastDescription>
                    </Toast>
                ),
            });
        },
        [toast, t],
    );

    const handleToggleSave = useCallback(async () => {
        if (!suggestion) return;
        try {
            if (isSaved) {
                await deleteSavedSuggestion(suggestion._id);
                setIsSaved(false);
                showSavedToast(t('savedSuggestions.removedToastMessage'));
            } else {
                await saveSuggestion(suggestion);
                setIsSaved(true);
                showSavedToast(t('savedSuggestions.savedToastMessage'));
            }
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleSuggestionScreen', method: 'toggleSave' },
                extra: { articleSuggestionId },
            });
        }
    }, [suggestion, isSaved, showSavedToast, t, articleSuggestionId]);

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
            await openArticleInAppBrowser(url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleSuggestionScreen', method: 'openUrl' },
            });
        }
    };

    if (isLoading) {
        return (
            <Box className="flex-1 bg-background-0 items-center justify-center">
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
            <Box className="flex-1 bg-background-0 items-center justify-center p-5">
                <MaterialIcons name="error-outline" size={48} color={colors.error} />
                <Text size="lg" className="text-typography-950 mt-4 text-center">
                    {error || t('articleDetail.articleNotFound')}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-background-100 rounded-lg px-6 py-3">
                    <Text size="md" className="text-typography-950">{t('common.goBack')}</Text>
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
        <Box className="flex-1 bg-background-0">
            {/* Floating Back Button */}
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    className="bg-background-50 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons name="arrow-back" size={24} color={colors.icon} />
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
                        {/* Read Article CTA — 80% read button, 20% save toggle */}
                        {suggestion.article_url ? (
                            <VStack space="xs">
                                <HStack space="sm" className="items-center">
                                    <Box className="flex-[4]">
                                        <Button
                                            variant="outline"
                                            action="primary"
                                            onPress={() => handleArticleUrlPress(suggestion.article_url)}
                                        >
                                            <ButtonIcon as={() => <MaterialIcons name="open-in-new" size={18} color={colors.icon} />} />
                                            <ButtonText className="text-typography-950 ml-2">
                                                {suggestion.publication_name
                                                    ? t('articleDetail.readOn', { publication: suggestion.publication_name })
                                                    : t('articleDetail.readArticle')}
                                            </ButtonText>
                                        </Button>
                                    </Box>
                                    <Box className="flex-1 items-center justify-center">
                                        <Pressable
                                            onPress={handleToggleSave}
                                            hitSlop={12}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('savedSuggestions.savedToastTitle')}
                                            className="bg-background-50 rounded-full p-2.5 shadow-hard-2"
                                        >
                                            <MaterialIcons
                                                name={isSaved ? 'bookmark' : 'bookmark-border'}
                                                size={24}
                                                color={colors.icon}
                                            />
                                        </Pressable>
                                    </Box>
                                </HStack>
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
                                                color={translatable ? colors.success : colors.error}
                                            />
                                            <Text
                                                size="xs"
                                                italic
                                                className={`flex-1 ${translatable ? 'text-success-500' : 'text-error-500'}`}
                                            >
                                                {t(
                                                    translatable
                                                        ? 'clusterDetail.translatable'
                                                        : 'clusterDetail.notTranslatable',
                                                    { language: languageName },
                                                )}
                                                {translatable && (
                                                    <Text
                                                        size="xs"
                                                        italic
                                                        className="text-primary-400 underline"
                                                        onPress={() => setShowGuideVideo(true)}
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
                                <Heading size="md" className="text-typography-700">
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

            <VideoPlayerModal
                visible={showGuideVideo}
                uri={TRANSLATION_GUIDE_URL}
                onClose={() => setShowGuideVideo(false)}
            />
        </Box>
    );
};

export default ArticleSuggestionScreen;
