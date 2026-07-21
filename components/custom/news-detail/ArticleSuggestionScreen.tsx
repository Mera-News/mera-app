import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
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
import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import {
    buildStoryGroups,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import {
    sortRelatedArticles,
    type RelatedSortable,
} from '@/lib/feed-grouping/related-articles-sort';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { buildGoogleTranslateUrl, getArticleTranslatableStatus, getLanguageName } from '@/lib/translation-service';
import { TRANSLATION_GUIDE_URL } from '@/lib/config/branding';
import { openArticleInAppBrowser, openInAppBrowser } from '@/lib/web-browser-utils';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleSuggestionScreenProps {
    articleSuggestionId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
}

const SCROLL_THRESHOLD = 300;

// Map ArticleSummary → NewsArticle-shaped object for ArticleStandaloneCompactCard
// (the existing card type works against NewsArticle fields). Hoisted to module
// scope so the merged-entries `useMemo` (which runs before the early returns)
// can call it without violating hook ordering.
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

// Map a local ForYouSuggestion → NewsArticle-shaped object for
// ArticleStandaloneCompactCard (mirrors toNewsArticle above). `_id` is the
// ARTICLE id so dedupe against server related rows works by article id.
const suggestionToNewsArticle = (s: ForYouSuggestion): NewsArticle => ({
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

/** Parse a date string to epoch ms, or null when absent/unparseable. */
const toPubDateMs = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
};

/**
 * A single row in the merged "Related Articles" list — either a local cluster
 * sibling (`suggestionId` set → taps into the richer suggestion-detail route)
 * or a server `relatedArticles` row (`suggestionId` undefined → taps into the
 * article-detail route). Sorted via {@link sortRelatedArticles}.
 */
interface RelatedEntry extends RelatedSortable {
    article: NewsArticle;
    /** Present only for local sibling entries → suggestion-detail navigation. */
    suggestionId?: string;
}

/**
 * Detail screen for a single ArticleSuggestion. Header shows the primary
 * article from the local DB row. Sibling coverage of the same story is shown
 * in the footer as ONE flat, sorted "Related Articles" list that merges two
 * sources, deduped by article id:
 *   1. Locally-derived siblings, computed in-screen by running
 *      `buildStoryGroups` over ALL store suggestions (not just the
 *      feed-visible ones). These are the user's own personalized cards for the
 *      same story that the feed collapsed away, so they surface even when
 *      low-relevance or unscored, and tap into the richer suggestion-detail
 *      route. Superset signal vs. the server join below.
 *   2. `relatedArticles(articleId)`, fetched lazily on mount via Apollo
 *      (no-cache). Limited to the CURRENT clustering generation on the server,
 *      so it can miss cross-generation siblings that the local title-Jaccard
 *      grouping catches; rows already shown as local siblings (or the opened
 *      article itself) are filtered out, and the survivors tap into the
 *      article-detail route.
 * Both origins are merged and ordered by the user's language/country signals
 * first (via `sortRelatedArticles`), then publication → date → id.
 */
const ArticleSuggestionScreen: React.FC<ArticleSuggestionScreenProps> = ({
    articleSuggestionId,
    onBack,
    backIcon = 'back',
}) => {
    const { t } = useTranslation();
    const toast = useToast();
    const storeSuggestion = useForYouStore((s) =>
        s.suggestions.find((sg) => sg._id === articleSuggestionId),
    );
    const [suggestion, setSuggestion] = useState<ForYouSuggestion | null>(
        storeSuggestion ?? null,
    );
    const suggestions = useForYouStore((s) => s.suggestions);
    const openedIds = useOpenedStoriesStore((s) => s.ids);

    // Locally-derived "More coverage" siblings: the user's other personalized
    // cards for the same story that the feed collapsed away. We deliberately
    // group over the ENTIRE store pool (not just feed-visible rows) so that
    // low-relevance or still-unscored coverage of the same story surfaces here.
    const localSiblings = useMemo<ForYouSuggestion[]>(() => {
        if (!suggestion) return [];
        // The DB-fallback-loaded row (deep link before hydration) may not be in
        // the store yet — include it so its group can form.
        const pool = suggestions.some((x) => x._id === suggestion._id)
            ? suggestions
            : [...suggestions, suggestion];
        const groups = buildStoryGroups(
            pool.map((s) => ({
                id: s._id,
                title: s.title_en ?? s.title_original,
                clusters: s.clusters,
                s,
            })),
            {
                titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
                clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
                weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
            },
        );
        const mine = groups.find((g) => g.some((m) => m.id === suggestion._id));
        return (mine ?? [])
            .filter((m) => m.id !== suggestion._id)
            .map((m) => m.s);
    }, [suggestions, suggestion]);
    const [isSaved, setIsSaved] = useState(false);
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isLoading, setIsLoading] = useState(!storeSuggestion);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const [showGuideVideo, setShowGuideVideo] = useState(false);
    const insets = useSafeAreaInsets();
    const appLanguage = useAppLanguage();
    const userCtx = useUserGeoLanguageContext();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);

    // Merged, flat "Related Articles" list: local cluster siblings + the server
    // `relatedArticles` join, deduped by article id (drop rows whose id equals
    // the opened article or any local sibling), then ordered by the user's
    // language/country signals first via `sortRelatedArticles`. Local siblings
    // navigate to the richer suggestion-detail route; server rows to the
    // article-detail route (encoded by whether `suggestionId` is set).
    const relatedEntries = useMemo<RelatedEntry[]>(() => {
        if (!suggestion) return [];
        const siblingArticleIds = new Set<string>(
            localSiblings.map((s) => s.articleId),
        );
        const siblingEntries: RelatedEntry[] = localSiblings.map((s) => ({
            id: s.articleId,
            languageCode: s.language_code,
            countryCodeAlpha3: s.country_code,
            publicationName: s.publication_name,
            pubDateMs: toPubDateMs(s.firstPubDate ?? s.createdAt),
            article: suggestionToNewsArticle(s),
            suggestionId: s._id,
        }));
        const serverEntries: RelatedEntry[] = related
            .filter(
                (a) =>
                    a._id !== suggestion.articleId &&
                    !siblingArticleIds.has(a._id),
            )
            .map((a) => ({
                id: a._id,
                languageCode: a.language_code ?? null,
                countryCodeAlpha3: a.country_code ?? null,
                publicationName: a.publication_name ?? null,
                pubDateMs: toPubDateMs(a.pubDate),
                article: toNewsArticle(a),
            }));
        return sortRelatedArticles(
            [...siblingEntries, ...serverEntries],
            userCtx,
        );
    }, [localSiblings, related, suggestion, userCtx]);

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

    // Same-story siblings are surfaced two ways: `localSiblings` (above) groups
    // the user's own store rows that the feed collapsed, and
    // `relatedArticles(articleId)` (above) joins the server's current clustering
    // generation. Both are merged, deduped by article id, and sorted into the
    // single flat "Related Articles" footer list by the `relatedEntries` memo.

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
    const read = isSuggestionOpened(suggestion, openedIds);

    return (
        <Box className="flex-1 bg-black">
            {/* Floating Back Button */}
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

            {/* Content */}
            <ArticleSuggestionContainer
                suggestion={suggestion}
                variant="screen"
                read={read}
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
                                <ArticleFeedbackPrompt
                                    articleId={suggestion.articleId}
                                    suggestionId={suggestion._id}
                                    title={suggestion.title_en ?? ''}
                                    feedbackContext={{
                                        publicationName: suggestion.publication_name,
                                        countryCode: suggestion.country_code,
                                        matchedTopics: suggestion.matchedTopics,
                                    }}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'suggestion',
                                        surface: 'detail',
                                        articleId: suggestion.articleId,
                                        suggestionId: suggestion._id,
                                        title: suggestion.title_en ?? '',
                                        publicationName: suggestion.publication_name,
                                        countryCode: suggestion.country_code,
                                        stableClusterId: suggestion.clusters?.find(
                                            (c) => c.stableClusterId,
                                        )?.stableClusterId ?? undefined,
                                        matchedTopics: suggestion.matchedTopics,
                                    }}
                                    share={{
                                        url: suggestion.article_url,
                                        titleEnglish: suggestion.title_en,
                                        titleOriginal: suggestion.title_original,
                                        sourceLanguage: suggestion.language_code,
                                    }}
                                />
                                <Button
                                    variant="outline"
                                    action="primary"
                                    className="rounded-full"
                                    onPress={() => handleArticleUrlPress(suggestion.article_url)}
                                >
                                    <ButtonIcon as={() => <MaterialIcons name="open-in-new" size={18} color="#ffffff" />} />
                                    <ButtonText className="text-white ml-2">
                                        {suggestion.publication_name
                                            ? t('articleDetail.readOn', { publication: suggestion.publication_name })
                                            : t('articleDetail.readArticle')}
                                    </ButtonText>
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
                                                {translatable && (
                                                    <Text
                                                        size="xs"
                                                        italic
                                                        className="text-orange-400 underline"
                                                        onPress={() => setShowGuideVideo(true)}
                                                    >
                                                        {' '}{t('clusterDetail.translationGuideLink')}
                                                    </Text>
                                                )}
                                            </Text>
                                        </HStack>
                                    );
                                })()}
                                {(() => {
                                    const status = getArticleTranslatableStatus(
                                        sourceLanguage,
                                        appLanguage,
                                    );
                                    if (status === 'same-language') return null;
                                    return (
                                        <Button
                                            variant="outline"
                                            action="secondary"
                                            size="sm"
                                            className="rounded-full"
                                            onPress={() =>
                                                openInAppBrowser(
                                                    buildGoogleTranslateUrl(
                                                        suggestion.article_url!,
                                                        appLanguage,
                                                    ),
                                                )
                                            }
                                        >
                                            <ButtonIcon as={() => <MaterialIcons name="translate" size={16} color="#ffffff" />} />
                                            <ButtonText className="text-white ml-2">
                                                {t('clusterDetail.viewInGoogleTranslate')}
                                            </ButtonText>
                                        </Button>
                                    );
                                })()}
                            </VStack>
                        ) : null}

                        {/* Related Articles — ONE flat, sorted list merging the
                            local cluster siblings (the user's own personalized
                            cards the feed collapsed, tapping into the richer
                            suggestion-detail route) and the server's current-
                            generation cluster join (tapping into article-detail),
                            deduped by article id and ordered by the user's
                            language/country signals first. Local rows render
                            immediately; the spinner row is appended while the
                            server join is still loading. */}
                        {(relatedEntries.length > 0 || isLoadingRelated) && (
                            <VStack space="md">
                                <Heading size="md" className="text-gray-300">
                                    {t('articleDetail.relatedArticles')}
                                </Heading>
                                {relatedEntries.map((entry, index) => (
                                    <ArticleStandaloneCompactCard
                                        key={entry.id || `related-${index}`}
                                        article={entry.article}
                                        onPress={() => router.replace(
                                            entry.suggestionId
                                                ? {
                                                    pathname: '/logged-in/suggestion-detail',
                                                    params: { articleSuggestionId: entry.suggestionId },
                                                }
                                                : {
                                                    pathname: '/logged-in/article-detail',
                                                    params: { articleId: entry.id },
                                                },
                                        )}
                                        subjectExtras={{ surface: 'detail' }}
                                    />
                                ))}
                                {isLoadingRelated && (
                                    <Box className="items-center justify-center py-4">
                                        <Spinner size="small" />
                                    </Box>
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
