import { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import { requestArticleFactCheck } from '@/lib/fact-check/request-article-fact-check';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import { useReportArticleSurface } from '@/components/custom/nav/current-surface';
import { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { deleteSuggestionByServerId } from '@/lib/database/services/article-suggestion-lifecycle';
import { findSuggestionByServerId } from '@/lib/database/services/article-suggestion-reads';
import {
    deleteSavedSuggestion,
    findSavedSuggestionByServerId,
    isSuggestionSaved,
    saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useSavedOverride } from '@/lib/saved-state';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import {
    buildStoryGroups,
    DISPLAY_GROUPING_OPTIONS,
    groupableOf,
} from '@/lib/algorithms/story-grouping';
import {
    orderRelatedArticles,
    type RelatedSortable,
} from '@/lib/algorithms/related-articles-sort';
import { relatedExcludeKey, useRelatedPagination } from './use-related-pagination';
import { relatedHeadingCount } from './related-count';
import { useTrackedStoryCopies } from './use-tracked-story-copies';
import { timelineCardToArticle } from '@/components/custom/tracked-stories/merge-timeline';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { mergeRelatedEntries } from './merge-related-entries';
import { useIsConnected } from '@/lib/stores/network-store';
import { secureUrlOrNull } from '@/lib/algorithms/secure-url';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InteractionManager } from 'react-native';

const SCROLL_THRESHOLD = 300;

// Map ArticleSummary → NewsArticle-shaped object for ArticleStandaloneCompactCard
// (the existing card type works against NewsArticle fields). Hoisted to module
// scope so the merged-entries `useMemo` (which runs before the early returns)
// can call it without violating hook ordering.
export const toNewsArticle = (a: ArticleSummary): NewsArticle => ({
    _id: a._id,
    title: a.title_original ?? a.title_en,
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
export const suggestionToNewsArticle = (s: ForYouSuggestion): NewsArticle => ({
    _id: s.articleId,
    title: s.title_original ?? s.title_en ?? '',
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

export function useArticleSuggestionScreen({
    articleSuggestionId,
    trackedStoryId,
}: {
    readonly articleSuggestionId: string;
    /** Set when opened from a followed story's timeline: the story's other
     *  copies lead Related coverage with the local siblings. */
    readonly trackedStoryId?: string;
}) {
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
        const groups = buildStoryGroups(pool.map(groupableOf), DISPLAY_GROUPING_OPTIONS);
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
    const [isLoading, setIsLoading] = useState(!storeSuggestion);
    const [error, setError] = useState<string | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    // The tick's icon state — a pure observer of the stored rows, same hook
    // `FactCheckPanel` uses below. See ArticleDetailScreen for why two
    // independent subscriptions to the same query is fine now that there is no
    // imperative action state to keep in sync.
    const factCheckPhase = useFactCheck(suggestion?.articleId).phase;
    const aiAccess = useAiAccess();
    // See ArticleDetailScreen — the Mera Protocol switch (`mera_fact_check`,
    // default on) now actually gates the tick and the panel.
    const userCtx = useUserGeoLanguageContext();
    // One sort for both detail routes (related-sort-store), applied to the
    // server request.
    const relatedSortMode = useRelatedSortStore((s) => s.mode);
    const setRelatedSortMode = useRelatedSortStore((s) => s.setMode);
    const isConnected = useIsConnected();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);

    // The related list is now TWO blocks, not one merged ordering.
    //
    // Local siblings lead, ordered here over just that set. They are the
    // reader's own personalized cards for this story, they exist offline, and
    // they tap into the richer suggestion-detail route — so they cannot be part
    // of a server page.
    //
    // Server coverage follows, ordered and paged BY THE SERVER 10 rows at a
    // time. The two cannot be interleaved any more: the country-block order
    // ranks each block by its size across the whole candidate set, so a page's
    // order depends on rows that are not in it, and the server can only size
    // blocks over what it serves. A country holding both local and server rows
    // therefore appears in two places — the same shape the tier-P head block has
    // always had (see related-articles-sort.ts), not a new anomaly.
    // The followed story's copies live on the phone but may have left the store
    // pool (the 48h sweep) or sit outside the display grouping; they join the
    // local block, deduped against the live siblings.
    const storyCopies = useTrackedStoryCopies(trackedStoryId, suggestion?.articleId ?? null, userCtx);
    const localEntries = useMemo<RelatedEntry[]>(() => {
        if (!suggestion) return [];
        const liveIds = new Set(localSiblings.map((s) => s.articleId));
        const copyEntries: RelatedEntry[] = storyCopies
            .filter((c) => !liveIds.has(c.articleId))
            .map((c) => ({
                id: c.articleId,
                languageCode: c.languageCode ?? null,
                countryCodeAlpha3: c.countryCode ?? null,
                publicationName: c.publicationName ?? null,
                pubDateMs: c.pubDateMs,
                article: timelineCardToArticle(c),
            }));
        const entries: RelatedEntry[] = [...copyEntries, ...localSiblings.map((s) => ({
            id: s.articleId,
            languageCode: s.language_code,
            countryCodeAlpha3: s.country_code,
            publicationName: s.publication_name,
            pubDateMs: toPubDateMs(s.firstPubDate ?? s.createdAt),
            article: suggestionToNewsArticle(s),
            suggestionId: s._id,
        }))];
        return orderRelatedArticles(
            entries,
            userCtx,
            relatedSortMode,
        );
    }, [localSiblings, storyCopies, suggestion, userCtx, relatedSortMode]);

    // Excluded SERVER-side, before ordering. Filtering the dedupe client-side
    // after the server counted these toward `first: 10` would short-change every
    // page (10 fetched, 2 rendered, hasNextPage still true) AND size the tier-B
    // blocks over a set the reader never sees.
    const excludeIds = useMemo(
        () => localEntries.map((e) => e.id),
        [localEntries],
    );

    const {
        entries: serverRows,
        isLoadingInitial: isLoadingRelated,
        isLoadingMore: isLoadingMoreRelated,
        loadMore: loadMoreRelated,
        error: relatedError,
        retry: retryRelated,
        hasNextPage: relatedHasNext,
        facets: relatedFacets,
        facetsExcludeKey,
    } = useRelatedPagination({
        articleId: suggestion?.articleId ?? null,
        sortMode: relatedSortMode,
        ctx: userCtx,
        excludeIds,
        isConnected,
    });

    const serverEntries = useMemo<RelatedEntry[]>(
        () =>
            serverRows.map((a) => ({
                id: a._id,
                languageCode: a.language_code ?? null,
                countryCodeAlpha3: a.country_code ?? null,
                publicationName: a.publication_name ?? null,
                pubDateMs: toPubDateMs(a.pubDate),
                article: toNewsArticle(a),
            })),
        [serverRows],
    );

    const relatedEntries = useMemo<RelatedEntry[]>(
        () => mergeRelatedEntries(localEntries, serverEntries, suggestion?.articleId),
        [localEntries, serverEntries, suggestion?.articleId],
    );
    // Locals are excluded server-side, so the sum never counts a row twice.
    const relatedCount = relatedHeadingCount({
        local: localEntries.length,
        served: serverEntries.length,
        hasNextPage: relatedHasNext,
        error: relatedError,
        loading: isLoadingRelated,
        facets: relatedFacets,
        facetsExcludeKey,
        excludeKey: relatedExcludeKey(excludeIds),
    });

    // What the Mera button asks about. Stable per article, so the button's
    // chat context is not rebuilt on every render.
    const meraArticleId = suggestion?.articleId;
    const meraTitle = suggestion?.title_en ?? suggestion?.title_original ?? undefined;
    const meraSubject = useMemo(
        () => (meraArticleId ? { articleId: meraArticleId, suggestionId: articleSuggestionId, title: meraTitle } : undefined),
        [meraArticleId, articleSuggestionId, meraTitle],
    );
    // The app-wide Mera button opens Mera on this article while it shows.
    useReportArticleSurface(meraSubject);

    const handleScrollPositionChange = useCallback((y: number) => {
        setShowScrollToTop(y > SCROLL_THRESHOLD);
    }, []);

    const scrollToTop = useCallback(() => {
        scrollViewRef.current?.scrollToTop(true);
    }, []);

    // The feedback tree's "Show related coverage" nudge. The related articles
    // are this page's footer, so the answer is to scroll there, not to navigate.
    // Landing at the bottom trips `onEndReached` → `loadMoreRelated`, so the
    // list grows underneath: the user arrives at what WAS the bottom with more
    // coverage appearing below. That is the intended reading of the nudge, not a
    // mis-scroll.
    const scrollToRelated = useCallback(() => {
        scrollViewRef.current?.scrollToEnd(true);
    }, []);

    // The id this screen already purged, so a re-run of the load effect (it
    // also depends on `storeSuggestion` and `t`) cannot delete twice.
    const purgedIdRef = useRef<string | null>(null);

    // Hydrate the suggestion from local DB if it wasn't already in the store
    // (e.g. deep-link from notification before store hydration completes).
    useEffect(() => {
        if (storeSuggestion) {
            setSuggestion(storeSuggestion);
            setIsLoading(false);
            return;
        }
        let cancelled = false;
        findSuggestionByServerId(articleSuggestionId)
            // Fall back to the saved table — a saved item's source feed row may
            // have already been pruned by the 48h TTL.
            .then((row) => row ?? findSavedSuggestionByServerId(articleSuggestionId))
            .then((row) => {
                if (cancelled) return;
                if (!row) {
                    setError(t('articleDetail.storyUnavailable'));
                    // CONFIRMED gone: neither the feed table nor the saved
                    // table holds it, so drop the stale card from the feed.
                    // This is the ONLY place that deletes. A read that THREW
                    // (the `.catch` below) proves nothing about the row, and
                    // deleting there turned one transient DB error into a card
                    // lost for good. It used to run in the render branch, on
                    // every re-render while the error showed; here it runs once
                    // per load. Idempotent either way.
                    if (purgedIdRef.current !== articleSuggestionId) {
                        purgedIdRef.current = articleSuggestionId;
                        deleteSuggestionByServerId(articleSuggestionId).catch(() => {});
                        useForYouStore.getState().removeSuggestion(articleSuggestionId);
                    }
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

    // Same-story siblings are surfaced two ways: `localEntries` groups the
    // user's own store rows that the feed collapsed and renders them as the head
    // block, and `relatedArticlesPage` pages the server's current clustering
    // generation beneath it, ordered server-side and excluding the head block.

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

    /**
     * The action-row tick — see ArticleDetailScreen's copy of this for the full
     * reasoning. It asks the SERVER for a check on this article instead of
     * seeding a chat that could only answer "there's nothing specific to
     * fact-check from this alone"; the panel below then goes to `processing`
     * and to a result in place.
     */
    const [factCheckAsked, setFactCheckAsked] = useState(false);
    const handleStartFactCheck = useCallback(() => {
        if (!suggestion) return;
        const asked = requestArticleFactCheck({
            articleId: suggestion.articleId,
            title: suggestion.title_en ?? suggestion.title_original ?? '',
            suggestion,
        });
        if (!asked) return;
        setFactCheckAsked(true);
    }, [suggestion]);

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
                titleOriginal: suggestion.title_original,
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

    return {
        suggestion,
        isSaved,
        isLoading,
        error,
        openedIds,
        factCheckPhase,
        aiAccess,
        showScrollToTop,
        titleDisplay,
        handleTitleDisplayChange,
        relatedEntries,
        relatedCount,
        isLoadingRelated,
        isLoadingMoreRelated,
        loadMoreRelated,
        relatedError,
        retryRelated,
        relatedSortMode,
        setRelatedSortMode,
        scrollViewRef,
        handleScrollPositionChange,
        scrollToTop,
        scrollToRelated,
        factCheckAsked,
        handleStartFactCheck,
        handleToggleSave,
        handleArticleUrlPress,
    };
}
