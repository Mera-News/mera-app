import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import ReadTranslateActions from '@/components/custom/news-detail/ReadTranslateActions';
import PublicationVisitBadge from '@/components/custom/PublicationVisitBadge';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import {
    deleteSavedSuggestion,
    getSavedSuggestionByServerId,
    isSuggestionSaved,
    saveStandaloneArticle,
} from '@/lib/database/services/saved-article-suggestion-service';
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { isOpenedId } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useIsConnected, useNetworkStore } from '@/lib/stores/network-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { sortRelatedArticles } from '@/lib/feed-grouping/related-articles-sort';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleDetailScreenProps {
    articleId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
    /** Stable story id from nav params, when the caller already knows it. When
     *  absent, the track flow resolves it lazily via getNewsClusterForArticle. */
    stableClusterId?: string;
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

// Map a saved-suggestion snapshot (ForYouSuggestion) to the NewsArticle shape
// this screen renders. Used for the offline fallback: a standalone article's
// saved row is keyed by the article's own `_id` (see
// saved-article-suggestion-service.ts), so a prior "save for later" doubles
// as an offline cache for this screen's card fields (title/description/image).
const savedSuggestionToNewsArticle = (s: ForYouSuggestion): NewsArticle => ({
    _id: s.articleId,
    title: s.title_en ?? s.title_original ?? '',
    title_en_internal_only: s.title_en ?? undefined,
    description: s.description_en ?? undefined,
    description_en_internal_only: s.description_en ?? undefined,
    pubDate: s.firstPubDate ?? s.createdAt,
    article_url: s.article_url ?? undefined,
    image_url: s.image_url ?? undefined,
    original_language_code: s.language_code ?? undefined,
    publicationSource: s.publication_name || s.country_code
        ? ({
            _id: s.articleId,
            publication_name: s.publication_name,
            country_code: s.country_code,
        } as NewsArticle['publicationSource'])
        : undefined,
} as NewsArticle);

const ArticleDetailScreen: React.FC<ArticleDetailScreenProps> = ({
    articleId,
    onBack,
    backIcon = 'back',
    stableClusterId,
}) => {
    const { t } = useTranslation();
    const toast = useToast();
    const [article, setArticle] = useState<NewsArticle | null>(null);
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isSaved, setIsSaved] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Offline, and no local snapshot exists — a dedicated empty state instead
    // of the generic error card. Auto-retries when connectivity returns (see
    // the retryNonce effect below).
    const [offlineUnavailable, setOfflineUnavailable] = useState(false);
    // Article is rendered from a saved-suggestion snapshot (offline fallback)
    // rather than the live query.
    const [isOfflineSnapshot, setIsOfflineSnapshot] = useState(false);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    // Mirror the title variant the reader currently sees (original vs
    // translated) so sharing carries that exact text.
    const [displayedTitle, setDisplayedTitle] = useState<string | null>(null);
    const handleTitleDisplayChange = useCallback(
        (s: { showingOriginal: boolean; displayedText: string }) => setDisplayedTitle(s.displayedText),
        [],
    );
    const insets = useSafeAreaInsets();
    const userCtx = useUserGeoLanguageContext();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);
    const openedIds = useOpenedStoriesStore((s) => s.ids);
    const isConnected = useIsConnected();
    // Bumped to re-run the fetch effect when connectivity returns while the
    // offline-unavailable empty state is showing (see the retry effect below).
    const [retryNonce, setRetryNonce] = useState(0);
    const hadOfflineFailureRef = useRef(false);

    // Server related rows, ordered by the user's language/country signals first
    // (then publication → date → id). Non-mutating; `userCtx === null` (still
    // loading) degrades to the legacy publication/date/id order.
    const sortedRelated = useMemo(() => {
        const entries = related.map((a) => ({
            id: a._id,
            languageCode: a.language_code ?? null,
            countryCodeAlpha3: a.country_code ?? null,
            publicationName: a.publication_name ?? null,
            pubDateMs: (() => {
                const ms = Date.parse(a.pubDate);
                return Number.isNaN(ms) ? null : ms;
            })(),
            summary: a,
        }));
        return sortRelatedArticles(entries, userCtx);
    }, [related, userCtx]);

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
        setOfflineUnavailable(false);
        setIsOfflineSnapshot(false);

        // Offline fallback: `getArticleById` is a live no-cache query, so it
        // fails deterministically with no network. Try a saved snapshot
        // instead of surfacing that as a generic failure — a standalone
        // article's saved row is keyed by the article's own id (see
        // saved-article-suggestion-service.ts).
        const attemptOfflineFallback = () => {
            getSavedSuggestionByServerId(articleId)
                .then((saved) => {
                    if (cancelled) return;
                    if (saved) {
                        setArticle(savedSuggestionToNewsArticle(saved));
                        setIsOfflineSnapshot(true);
                    } else {
                        setArticle(null);
                        hadOfflineFailureRef.current = true;
                        setOfflineUnavailable(true);
                    }
                })
                .catch((err) => {
                    if (cancelled) return;
                    logger.captureException(err, {
                        tags: { screen: 'ArticleDetailScreen', method: 'offlineSnapshotFallback' },
                        extra: { articleId },
                    });
                    setArticle(null);
                    hadOfflineFailureRef.current = true;
                    setOfflineUnavailable(true);
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
        };

        if (!isConnected) {
            attemptOfflineFallback();
            return () => {
                cancelled = true;
            };
        }

        ArticleService.getArticleById(articleId)
            .then((row) => {
                if (cancelled) return;
                if (!row) {
                    setError(t('articleDetail.articleUnavailable'));
                    setIsLoading(false);
                } else {
                    setArticle(row);
                    setIsLoading(false);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                logger.captureException(err, {
                    tags: { screen: 'ArticleDetailScreen', method: 'getArticleById' },
                    extra: { articleId },
                });
                // Connectivity may have dropped mid-request — fall back to a
                // local snapshot instead of a generic failure in that case.
                if (!useNetworkStore.getState().isConnected) {
                    attemptOfflineFallback();
                    return;
                }
                setError(t('articleDetail.failedToLoad'));
                setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // isConnected is intentionally read (not a dep) so this only re-runs
        // via articleId/retryNonce — a transient online↔offline flip while an
        // article is already loaded shouldn't wipe it. Reconnecting after the
        // offlineUnavailable empty state DOES retry, via the effect below
        // bumping retryNonce.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [articleId, t, retryNonce]);

    // Auto-retry: once connectivity returns after the offlineUnavailable
    // empty state was shown, re-run the fetch effect above.
    useEffect(() => {
        if (isConnected && hadOfflineFailureRef.current) {
            hadOfflineFailureRef.current = false;
            setRetryNonce((n) => n + 1);
        }
    }, [isConnected]);

    useEffect(() => {
        // No point round-tripping a live query with no network — leave the
        // related-articles section empty rather than logging a guaranteed
        // failure on every offline article view.
        if (!article?._id || !isConnected) return;
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
    }, [article?._id, isConnected]);

    // Reflect whether this standalone article is already saved for later. The
    // saved row id for a standalone article is the article's own `_id`.
    useEffect(() => {
        const id = article?._id;
        if (!id) return;
        let cancelled = false;
        isSuggestionSaved(id)
            .then((saved) => {
                if (!cancelled) setIsSaved(saved);
            })
            .catch(() => {
                /* non-fatal — default to unsaved */
            });
        return () => {
            cancelled = true;
        };
    }, [article?._id]);

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
        if (!article) return;
        try {
            if (isSaved) {
                await deleteSavedSuggestion(article._id);
                setIsSaved(false);
                showSavedToast(t('savedSuggestions.removedToastMessage'));
            } else {
                await saveStandaloneArticle(article, { surface: 'detail' });
                setIsSaved(true);
                showSavedToast(t('savedSuggestions.savedToastMessage'));
            }
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleDetailScreen', method: 'toggleSave' },
                extra: { articleId: article._id ?? articleId },
            });
        }
    }, [article, isSaved, showSavedToast, t, articleId]);

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
            await openArticleInAppBrowser(url);
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleDetailScreen', method: 'openUrl' },
            });
        }
    };

    const handleRelatedPress = useCallback((relatedArticleId: string) => {
        router.replace({
            pathname: '/logged-in/article-detail',
            params: { articleId: relatedArticleId },
        });
    }, []);

    if (isLoading) {
        return (
            <Box className="flex-1 bg-background-50 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    if (offlineUnavailable) {
        // Offline, and no local snapshot to fall back to — a friendlier,
        // non-alarming empty state (not the red "error" card) since this is
        // an expected condition, not a failure. Auto-retries when
        // connectivity returns (see the retryNonce effect above).
        return (
            <Box className="flex-1 bg-background-50 items-center justify-center p-5">
                <MaterialIcons name="wifi-off" size={48} color="#9CA3AF" />
                <Text size="lg" className="text-white mt-4 text-center">
                    {t('articleDetail.offlineUnavailable')}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-gray-800 rounded-lg px-6 py-3">
                    <Text size="md" className="text-white">{t('common.goBack')}</Text>
                </Pressable>
            </Box>
        );
    }

    if (error || !article) {
        return (
            <Box className="flex-1 bg-background-50 items-center justify-center p-5">
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

    const sourceLanguage = article.original_language_code ?? null;
    const articleUrl = article.article_url ?? null;
    const read = isOpenedId(article._id, stableClusterId, openedIds);

    return (
        <Box className="flex-1 bg-background-50">
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons
                        name={backIcon === 'home' ? 'home' : 'arrow-back'}
                        size={24}
                        color="#ffffff"
                    />
                </Pressable>
            </Box>

            <ArticleSuggestionContainer
                article={article}
                variant="screen"
                read={read}
                onTitleDisplayChange={handleTitleDisplayChange}
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                contentTopInset={insets.top}
                contentBottomInset={insets.bottom + 20}
                aboveReason={
                    <>
                        {isOfflineSnapshot && (
                            <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mb-2" space="sm">
                                <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                                <Text size="sm" className="text-warning-400">{t('feed.offlineCached')}</Text>
                            </HStack>
                        )}
                        <PublicationVisitBadge
                            publicationName={article.publicationSource?.publication_name}
                            countryCode={article.publicationSource?.country_code}
                        />
                    </>
                }
                footer={
                    <>
                        {articleUrl ? (
                            <VStack space="xs">
                                <ArticleFeedbackPrompt
                                    articleId={article._id ?? articleId}
                                    title={article.title_en_internal_only ?? article.title ?? ''}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'article',
                                        surface: 'detail',
                                        articleId: article._id ?? articleId,
                                        title: article.title_en_internal_only ?? article.title ?? '',
                                        publicationName: article.publicationSource?.publication_name,
                                        countryCode: article.publicationSource?.country_code,
                                        stableClusterId,
                                    }}
                                    share={{
                                        url: articleUrl,
                                        titleEnglish: article.title_en_internal_only ?? article.title,
                                        titleOriginal: article.title,
                                        sourceLanguage: article.original_language_code,
                                        displayedTitle,
                                    }}
                                />
                                <ReadTranslateActions
                                    articleUrl={articleUrl}
                                    publicationName={article.publicationSource?.publication_name}
                                    sourceLanguage={sourceLanguage}
                                    onOpenUrl={handleArticleUrlPress}
                                />
                            </VStack>
                        ) : null}

                        {(isLoadingRelated || related.length > 0) && (
                            <VStack space="md">
                                <Heading size="md" className="text-gray-300">
                                    {t('articleDetail.relatedArticles')}
                                </Heading>
                                {isLoadingRelated ? (
                                    <Box className="items-center justify-center py-4">
                                        <Spinner size="small" />
                                    </Box>
                                ) : (
                                    sortedRelated.map((entry, index) => (
                                        <ArticleStandaloneCompactCard
                                            key={entry.id || `related-${index}`}
                                            article={summaryToNewsArticle(entry.summary)}
                                            onPress={() => handleRelatedPress(entry.id)}
                                            subjectExtras={{ surface: 'detail' }}
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
