import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import FactCheckPanel from '@/components/custom/news-detail/FactCheckPanel';
import { startFactCheckChat } from '@/lib/fact-check/start-fact-check-chat';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import ReadTranslateActions from '@/components/custom/news-detail/ReadTranslateActions';
import RelatedSortDropdown from '@/components/custom/news-detail/RelatedSortDropdown';
import PublicationVisitBadge from '@/components/custom/PublicationVisitBadge';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import StatusBarScrim from '@/components/custom/StatusBarScrim';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { AlertCircleIcon, Icon } from '@/components/ui/icon';
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
import { useSavedOverride } from '@/lib/saved-state';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import {
    buildStoryGroups,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
    ENTITY_JACCARD_DISPLAY_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import {
    orderRelatedArticles,
    type RelatedSortable,
} from '@/lib/feed-grouping/related-articles-sort';
import { useIsConnected } from '@/lib/stores/network-store';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { secureUrlOrNull } from '@/lib/secure-url';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InteractionManager } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleSuggestionScreenProps {
    articleSuggestionId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
}

const SCROLL_THRESHOLD = 300;
// The related-articles footer list renders unvirtualized (`.map`), so on
// mount it's capped to a small initial window and grows as the user scrolls
// near the bottom — keeps first-render cost bounded on stories with a large
// related set.
const INITIAL_RELATED_COUNT = 6;
const RELATED_COUNT_INCREMENT = 10;

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
 * article-detail route). Ordered via {@link orderRelatedArticles}.
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
 * Both origins are merged and ordered into contiguous per-country blocks (via
 * `orderRelatedArticles`): this suggestion's country first, then the remaining
 * countries biggest-block first, countryless rows last; within a block,
 * language → publication → date → id.
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

    // Mirror the title variant the reader currently sees (original vs
    // translated) so sharing carries that exact text — and the language it's
    // in, so the share footer can match it. Kept in ONE state object: text and
    // language must never disagree.
    const [titleDisplay, setTitleDisplay] = useState<
        { text: string; language: string | null } | null
    >(null);
    const handleTitleDisplayChange = useCallback(
        (s: TranslatableDisplayState) =>
            setTitleDisplay({ text: s.displayedText, language: s.displayedLanguage }),
        [],
    );

    // Defer the (potentially large) `buildStoryGroups` union-find over the
    // entire suggestion pool until after the screen's mount interactions
    // (navigation transition, first paint) have settled, so the header
    // content renders immediately and the sibling-grouping work doesn't
    // compete with the transition for the JS thread.
    const [afterInteractions, setAfterInteractions] = useState(false);
    useEffect(() => {
        const handle = InteractionManager.runAfterInteractions(() => {
            setAfterInteractions(true);
        });
        return () => handle.cancel();
    }, []);

    // Locally-derived "More coverage" siblings: the user's other personalized
    // cards for the same story that the feed collapsed away. We deliberately
    // group over the ENTIRE store pool (not just feed-visible rows) so that
    // low-relevance or still-unscored coverage of the same story surfaces here.
    // Withheld until `afterInteractions` (see effect above) — see downstream
    // memos (`relatedEntries`) for the knock-on effect.
    const localSiblings = useMemo<ForYouSuggestion[]>(() => {
        if (!afterInteractions || !suggestion) return [];
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
                entities: s.entities,
                eventType: s.eventType,
                s,
            })),
            // Must stay in lock-step with the two feed selectors' DISPLAY option
            // set — including `entityJaccardThreshold`. If the feed collapses
            // A+B+C behind "+2 sources" via an edge this screen does not have,
            // B and C are reachable from nowhere in the app.
            {
                titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
                clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
                weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
                entityJaccardThreshold: ENTITY_JACCARD_DISPLAY_THRESHOLD,
                ungateStableClusterEdge: true,
            },
        );
        const mine = groups.find((g) => g.some((m) => m.id === suggestion._id));
        return (mine ?? [])
            .filter((m) => m.id !== suggestion._id)
            .map((m) => m.s);
    }, [afterInteractions, suggestions, suggestion]);
    const [savedFromDb, setSavedFromDb] = useState(false);
    // See lib/saved-state — a save/delete on any other surface (notably the
    // Dashboard's Saved list) corrects this screen's bookmark without a remount.
    const savedOverride = useSavedOverride(articleSuggestionId);
    const isSaved = savedOverride ?? savedFromDb;
    const [related, setRelated] = useState<ArticleSummary[]>([]);
    const [isLoading, setIsLoading] = useState(!storeSuggestion);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const insets = useSafeAreaInsets();
    // The tick's icon state — a pure observer of the stored rows, same hook
    // `FactCheckPanel` uses below. See ArticleDetailScreen for why two
    // independent subscriptions to the same query is fine now that there is no
    // imperative action state to keep in sync.
    const factCheckPhase = useFactCheck(suggestion?.articleId).phase;
    const aiAccess = useAiAccess();
    const userCtx = useUserGeoLanguageContext();
    const isConnected = useIsConnected();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);

    // Merged, flat "Related Articles" list: local cluster siblings + the server
    // `relatedArticles` join, deduped by article id (drop rows whose id equals
    // the opened article or any local sibling), then ordered into contiguous
    // per-country blocks via `orderRelatedArticles` — this suggestion's country
    // first, then the remaining countries biggest-block first. Ordering runs over
    // the FULL list here, before the render-time `visibleRelatedCount` window, so
    // block sizes never become window-relative. Local siblings navigate to the
    // richer suggestion-detail route; server rows to the article-detail route
    // (encoded by whether `suggestionId` is set).
    // How the reader wants the related list ordered. ONE persisted setting
    // shared with the article-detail route — see related-sort-store.
    const relatedSortMode = useRelatedSortStore((s) => s.mode);
    const setRelatedSortMode = useRelatedSortStore((s) => s.setMode);

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
        return orderRelatedArticles(
            [...siblingEntries, ...serverEntries],
            suggestion.country_code ?? null,
            userCtx,
            relatedSortMode,
        );
    }, [localSiblings, related, suggestion, userCtx, relatedSortMode]);

    const handleScrollPositionChange = useCallback((y: number) => {
        setShowScrollToTop(y > SCROLL_THRESHOLD);
    }, []);

    const scrollToTop = useCallback(() => {
        scrollViewRef.current?.scrollToTop(true);
    }, []);

    // The feedback tree's "Show related coverage" nudge. The related articles
    // are this page's footer, so the answer is to scroll there, not to navigate.
    // Landing at the bottom trips `onEndReached` → `handleRelatedEndReached`, so
    // the list grows underneath: the user arrives at what WAS the bottom with
    // more related rows appearing below. That is the intended reading of the
    // nudge, not a mis-scroll.
    const scrollToRelated = useCallback(() => {
        scrollViewRef.current?.scrollToEnd(true);
    }, []);

    // Related-list lazy growth: start small, grow when the user scrolls near
    // the bottom (SmoothScrollView's `onEndReached`, FlatList-like — fires
    // once per approach, re-arms after scrolling back up).
    const [visibleRelatedCount, setVisibleRelatedCount] = useState(INITIAL_RELATED_COUNT);
    const handleRelatedEndReached = useCallback(() => {
        setVisibleRelatedCount((prev) => prev + RELATED_COUNT_INCREMENT);
    }, []);
    // Reset the visible window when the underlying list identity changes
    // (navigating to a different suggestion re-mounts nothing here since this
    // screen instance is keyed per-route, but guard anyway for safety).
    // Also reset on a sort change: the reader re-sorted to see a DIFFERENT set
    // of rows at the top, and keeping a grown window would silently change how
    // much of the list is on screen at the same time as its order.
    useEffect(() => {
        setVisibleRelatedCount(INITIAL_RELATED_COUNT);
    }, [suggestion?._id, relatedSortMode]);

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
        // Parity with ArticleDetailScreen: no point round-tripping a live query
        // with no network — leave the section to its LOCAL siblings rather than
        // logging a guaranteed failure on every offline view. (The local-sibling
        // half of this screen's two-source merge still works offline, which is
        // why this screen degrades better than the article one.)
        if (!articleId || !isConnected) return;
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
        // `isConnected` is a dep so the fetch RE-runs when connectivity returns —
        // without it, a screen opened offline would never populate the server
        // half of the related list even after the network came back.
    }, [suggestion?.articleId, isConnected]);

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
                if (!cancelled) setSavedFromDb(saved);
            })
            .catch(() => {
                /* non-fatal — default to unsaved */
            });
        return () => {
            cancelled = true;
        };
    }, [articleSuggestionId]);

    // Title tracks the DIRECTION of the toggle. It was hardcoded to "Saved", so
    // un-saving produced the self-contradicting toast "Saved / Removed from
    // saved". Success styling is unchanged either way — removing a saved article
    // is a successful action, not an error.
    const showSavedToast = useCallback(
        (message: string, removed: boolean = false) => {
            toast.show({
                placement: 'top',
                duration: 3000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="success" variant="solid">
                        <ToastTitle>
                            {t(removed
                                ? 'savedSuggestions.removedToastTitle'
                                : 'savedSuggestions.savedToastTitle')}
                        </ToastTitle>
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
                // The boolean matters: if the row was already gone (deleted
                // from the Saved list while this screen sat mounted) nothing was
                // removed, so a "Removed" toast would be a lie. The saved-state
                // publish still corrects the bookmark either way.
                const removed = await deleteSavedSuggestion(suggestion._id);
                if (removed) {
                    showSavedToast(t('savedSuggestions.removedToastMessage'), true);
                }
            } else {
                await saveSuggestion(suggestion);
                showSavedToast(t('savedSuggestions.savedToastMessage'));
            }
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleSuggestionScreen', method: 'toggleSave' },
                extra: { articleSuggestionId },
            });
        }
    }, [suggestion, isSaved, showSavedToast, t, articleSuggestionId]);

    const handleArticleUrlPress = async (rawUrl: string | null | undefined) => {
        // Second gate for item 16 — see ArticleDetailScreen for the reasoning.
        const url = secureUrlOrNull(rawUrl);
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
            <Box className="flex-1 items-center justify-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

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
            <Box className="flex-1 items-center justify-center p-5">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <MaterialIcons
                    name="error-outline"
                    size={48}
                    color="#EF4444"
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                />
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
    // Item 16 (defence in depth): a locally-stored suggestion row can predate
    // the server's insecure-article filter. An `http://` URL reads as
    // UNAVAILABLE — an explicit notice in place of the read/translate/share
    // block — never as a button that quietly does nothing.
    const articleUrl = secureUrlOrNull(suggestion.article_url);
    const insecureLink = !!suggestion.article_url && !articleUrl;
    const read = isSuggestionOpened(suggestion, openedIds);

    return (
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* Status bar scrim — this screen's hero image is a full-bleed
                parallax header (ArticleSuggestionContainer's SmoothScrollView),
                so without this a light photo makes the system clock/battery
                glyphs illegible. StatusBarScrim's own zIndex (5) sits above the
                container's default (0) but below the floating back button
                below (zIndex 20), so the scrim darkens the image behind the
                status bar without ever covering the tappable back button. */}
            <StatusBarScrim />

            {/* Floating Back Button */}
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    accessibilityRole="button"
                    accessibilityLabel={t(backIcon === 'home' ? 'common.home' : 'common.back')}
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
                onTitleDisplayChange={handleTitleDisplayChange}
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                onEndReached={handleRelatedEndReached}
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
                        {articleUrl ? (
                            <VStack space="md">
                                <ArticleFeedbackPrompt
                                    // See ArticleDetailScreen — hidden entirely
                                    // on a locked free-tier plan rather than
                                    // left as a dead tap.
                                    factCheck={aiAccess !== 'locked' ? {
                                        onStart: () => startFactCheckChat({
                                            articleId: suggestion.articleId,
                                            title: suggestion.title_en ?? suggestion.title_original ?? '',
                                            description: suggestion.description_en ?? null,
                                            url: articleUrl ?? null,
                                            publicationName: suggestion.publication_name ?? null,
                                        }),
                                        state: factCheckPhase === 'terminal'
                                            ? 'done'
                                            : factCheckPhase === 'processing'
                                                ? 'pending'
                                                : 'none',
                                    } : undefined}
                                    articleId={suggestion.articleId}
                                    suggestionId={suggestion._id}
                                    title={suggestion.title_en ?? ''}
                                    // No feedback context is passed any more:
                                    // the prompt resolves the LOCAL
                                    // article_suggestions row itself (by
                                    // articleId), which carries strictly more
                                    // than this screen could hand it — category,
                                    // event type, cluster size and place.
                                    onBrowseRelated={scrollToRelated}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'suggestion',
                                        surface: 'detail',
                                        articleId: suggestion.articleId,
                                        suggestionId: suggestion._id,
                                        title: suggestion.title_en ?? '',
                                        // REQUIRED: without it the tracked-story
                                        // seed snapshot falls back to "now", so
                                        // the timeline's first row showed the
                                        // TRACK moment ("4m ago") under the same
                                        // clock chip every other row uses for
                                        // publication age — and pinned a 13h-old
                                        // article above a 1h-old one.
                                        pubDate: suggestion.firstPubDate ?? suggestion.createdAt,
                                        publicationName: suggestion.publication_name,
                                        countryCode: suggestion.country_code,
                                        stableClusterId: suggestion.clusters?.find(
                                            (c) => c.stableClusterId,
                                        )?.stableClusterId ?? undefined,
                                        matchedTopics: suggestion.matchedTopics,
                                    }}
                                    share={{
                                        url: articleUrl,
                                        titleEnglish: suggestion.title_en,
                                        titleOriginal: suggestion.title_original,
                                        sourceLanguage: suggestion.language_code,
                                        displayedTitle: titleDisplay?.text ?? null,
                                        displayedLanguage: titleDisplay?.language ?? null,
                                    }}
                                />
                                <ReadTranslateActions
                                    articleUrl={articleUrl}
                                    sourceLanguage={sourceLanguage}
                                    publicationName={suggestion.publication_name}
                                    onOpenUrl={handleArticleUrlPress}
                                />
                            </VStack>
                        ) : insecureLink ? (
                            <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2" space="sm">
                                <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                                <Text size="sm" className="text-warning-400 flex-1">
                                    {t('articleDetail.linkUnavailable')}
                                </Text>
                            </HStack>
                        ) : null}

                        {/* Fact check sits OUTSIDE the URL branch: it is keyed
                            on the ARTICLE id (not the suggestion id), not the
                            (possibly refused) local link, so it still renders
                            for a row whose URL we won't open. Always mounted —
                            a pure observer, it renders nothing itself when
                            nobody has asked about this article. */}
                        <FactCheckPanel articleId={suggestion.articleId} />

                        {/* Related Articles — ONE flat, sorted list merging the
                            local cluster siblings (the user's own personalized
                            cards the feed collapsed, tapping into the richer
                            suggestion-detail route) and the server's current-
                            generation cluster join (tapping into article-detail),
                            deduped by article id and ordered by the user's
                            language/country signals first. Local rows render
                            immediately; the spinner row is appended while the
                            server join is still loading. Renders unvirtualized
                            (`.map`), so only a `visibleRelatedCount` window is
                            shown initially and grows as the user scrolls near
                            the bottom (see `handleRelatedEndReached`). */}
                        {(relatedEntries.length > 0 || isLoadingRelated) && (
                            <VStack space="md">
                                <HStack className="items-center justify-between" space="sm">
                                    <Heading size="lg" className="text-gray-300 flex-1">
                                        {t('articleDetail.relatedArticles')}
                                    </Heading>
                                    <RelatedSortDropdown
                                        value={relatedSortMode}
                                        onChange={setRelatedSortMode}
                                        testIDPrefix="related-sort"
                                    />
                                </HStack>
                                {relatedEntries.slice(0, visibleRelatedCount).map((entry, index) => (
                                    <ArticleStandaloneCompactCard
                                        key={entry.id || `related-${index}`}
                                        article={entry.article}
                                        // `push`, not `replace`: chaining into a
                                        // related story adds a stack entry so
                                        // back returns here, not to the feed.
                                        onPress={() => router.push(
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
        </Box>
    );
};

export default ArticleSuggestionScreen;
