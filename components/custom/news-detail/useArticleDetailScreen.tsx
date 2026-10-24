import { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import { requestArticleFactCheck } from '@/lib/fact-check/request-article-fact-check';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import { useReportArticleSurface } from '@/components/custom/nav/current-surface';
import { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { ArticleService } from '@/lib/article-service';
import {
    findLocalArticleSnapshot,
    type SnapshotSource,
} from '@/components/custom/news-detail/local-article-snapshot';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import {
    deleteSavedSuggestion,
    isSuggestionSaved,
    saveStandaloneArticle,
} from '@/lib/database/services/saved-article-suggestion-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useSavedOverride } from '@/lib/saved-state';
import { useIsConnected, useNetworkStore } from '@/lib/stores/network-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useRelatedPagination } from './use-related-pagination';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { secureUrlOrNull } from '@/lib/algorithms/secure-url';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStoredFactCheck } from '@/lib/fact-check/use-stored-fact-check';

// Related rows map through the suggestion route's one mapper (original title as `title`).
import { toNewsArticle } from './useArticleSuggestionScreen';

const SCROLL_THRESHOLD = 300;


export function useArticleDetailScreen({
    articleId,
    stableClusterId,
}: {
    readonly articleId: string;
    readonly stableClusterId?: string;
}) {
    const { t } = useTranslation();
    const toast = useToast();
    const [article, setArticle] = useState<NewsArticle | null>(null);
    const [savedFromDb, setSavedFromDb] = useState(false);
    // See lib/saved-state — a save/delete on any other surface (notably the
    // Dashboard's Saved list) corrects this screen's bookmark without a remount.
    const savedOverride = useSavedOverride(article?._id ?? articleId);
    const isSaved = savedOverride ?? savedFromDb;
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // The server has no such article AND this device holds no snapshot: a definite 404, never a network failure.
    const [notFound, setNotFound] = useState(false);
    // The tick's icon state — a pure observer of the stored rows, same hook
    // `FactCheckPanel` uses below. Two independent subscriptions to the same
    // WatermelonDB query, not a shared instance: unlike the old request-driving
    // hook there is no imperative action state to keep in sync, only a live
    // read, so there is nothing wrong with two components each watching it.
    const factCheckPhase = useFactCheck(article?._id ?? articleId).phase;
    const aiAccess = useAiAccess();
    // Only read once the article is KNOWN to be unavailable — a normal open
    // costs no extra query (FactCheckPanel runs its own observer on the happy
    // path).
    const orphanFactChecks = useStoredFactCheck(
        articleId,
        !isLoading && (!!error || !article),
    );
    // Offline, and no local snapshot exists — a dedicated empty state instead
    // of the generic error card. Auto-retries when connectivity returns (see
    // the retryNonce effect below).
    const [offlineUnavailable, setOfflineUnavailable] = useState(false);
    // The article is rendered from a LOCAL snapshot rather than the live query,
    // and which snapshot it came from — the two mean different things to the
    // reader, so they must not share one banner:
    //   'saved' — offline, restored from a "save for later" row. Gets the
    //              "showing cached content" banner.
    //   'retained' — the app kept this article on the reader's behalf (a fact
    //              check, or a followed story's member). Reached ONLINE, past
    //              the server's 48h TTL. Gets NO banner — see the render.
    //   'visit'  — the server no longer has this article (48h TTL) but the
    //              reader has opened it before, so the visit log still holds a
    //              snapshot. Happens ONLINE, most often from the per-publication
    //              history (30-day window). Gets NO banner — see the render.
    const [snapshotSource, setSnapshotSource] = useState<SnapshotSource | null>(null);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
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
    const userCtx = useUserGeoLanguageContext();
    // One sort for both detail routes (related-sort-store), applied to the
    // server request.
    const relatedSortMode = useRelatedSortStore((s) => s.mode);
    const setRelatedSortMode = useRelatedSortStore((s) => s.setMode);
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);
    const openedIds = useOpenedStoriesStore((s) => s.ids);
    const isConnected = useIsConnected();
    // Bumped to re-run the fetch effect when connectivity returns while the
    // offline-unavailable empty state is showing (see the retry effect below).
    const [retryNonce, setRetryNonce] = useState(0);
    const hadOfflineFailureRef = useRef(false);

    // Related coverage, ordered and paged BY THE SERVER, 10 rows at a time.
    // The ordering cannot live here any more: country blocks are ranked by their
    // size across the whole candidate set, so a page's order depends on rows
    // that are not in it. `userCtx` ships as anonymous args purely to order the
    // response — see use-related-pagination.
    const {
        entries: related,
        isLoadingInitial: isLoadingRelated,
        isLoadingMore: isLoadingMoreRelated,
        loadMore: loadMoreRelated,
        error: relatedError,
        retry: retryRelated,
    } = useRelatedPagination({
        articleId: article?._id ?? null,
        stableClusterId,
        sortMode: relatedSortMode,
        ctx: userCtx,
        isConnected,
    });
    // Server order is final, no client re-sort; the hook dedupes by `_id` on
    // every page, so the id alone is a unique key.
    const relatedRows = useMemo(
        () => related.map((entry) => ({ id: entry._id, article: toNewsArticle(entry) })),
        [related],
    );

    // What the Mera button asks about. Stable per article, so the button's
    // chat context is not rebuilt on every render.
    const meraTitle = article?.title_en_internal_only ?? article?.title ?? undefined;
    const meraSubject = useMemo(() => ({ articleId, title: meraTitle }), [articleId, meraTitle]);
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
    // Landing at the bottom trips `onEndReached` -> `loadMoreRelated`, so the
    // list grows underneath: the reader arrives at what WAS the bottom with more
    // coverage appearing below. That is the intended reading of the nudge, not a
    // mis-scroll — same behaviour the suggestion route has always had.
    const scrollToRelated = useCallback(() => {
        scrollViewRef.current?.scrollToEnd(true);
    }, []);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        setNotFound(false);
        setOfflineUnavailable(false);
        setSnapshotSource(null);

        // Offline fallback: `getArticleById` is a live no-cache query, so it
        // fails deterministically with no network. Fall back to a local snapshot
        // instead of surfacing that as a generic failure.
        const attemptOfflineFallback = () => {
            findLocalArticleSnapshot(articleId)
                .then((snapshot) => {
                    if (cancelled) return;
                    if (snapshot) {
                        setArticle(snapshot.article);
                        setSnapshotSource(snapshot.source);
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

        // Online, but the server has no such article. Server articles are
        // dropped after 48h (`v3_ingestedAt_ttl`) while local history keeps 30
        // days — so every surface that routes an OLD article here (notably the
        // per-publication read history) would otherwise dead-end on "article
        // unavailable". Since this screen is now the ONLY way to reach a
        // publisher URL, that dead end would cost the reader the article AND the
        // translate options. A local snapshot still carries both.
        const attemptTtlFallback = () => {
            findLocalArticleSnapshot(articleId)
                .then((snapshot) => {
                    if (cancelled) return;
                    if (snapshot) {
                        setArticle(snapshot.article);
                        setSnapshotSource(snapshot.source);
                    } else {
                        setNotFound(true);
                        setError(t('articleDetail.articleUnavailable'));
                    }
                })
                .catch((err) => {
                    if (cancelled) return;
                    logger.captureException(err, {
                        tags: { screen: 'ArticleDetailScreen', method: 'ttlSnapshotFallback' },
                        extra: { articleId },
                    });
                    setError(t('articleDetail.articleUnavailable'));
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
                    attemptTtlFallback();
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

    // Reflect whether this standalone article is already saved for later. The
    // saved row id for a standalone article is the article's own `_id`.
    useEffect(() => {
        const id = article?._id;
        if (!id) return;
        let cancelled = false;
        isSuggestionSaved(id)
            .then((saved) => {
                if (!cancelled) setSavedFromDb(saved);
            })
            .catch(() => {
                /* non-fatal — default to unsaved */
            });
        return () => {
            cancelled = true;
        };
    }, [article?._id]);

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
     * The action-row tick. It USED to seed Mera AI with an opening turn, which
     * answered "the article metadata gives me only a headline… there's nothing
     * specific to fact-check from this alone" — a chat that could not do the
     * job it was opened for. It now asks the SERVER for a check on this
     * article; the panel below goes to `processing` and then to a result in
     * place, with no chat involved.
     *
     * The toast is the immediate acknowledgement: the panel's own spinner is
     * deliberately delayed (`PROGRESS_DELAY_MS`, so a fast answer never
     * flashes one), which would otherwise leave the tap looking ignored. It is
     * shown only when the request was actually issued — `requestArticleFactCheck`
     * returns false for a gated no-op, and a toast about work nobody started
     * would be a lie.
     */
    const [factCheckAsked, setFactCheckAsked] = useState(false);
    const handleStartFactCheck = useCallback(() => {
        if (!article) return;
        const asked = requestArticleFactCheck({
            articleId: article._id ?? articleId,
            title: article.title_en_internal_only ?? article.title ?? '',
            article,
        });
        if (!asked) return;
        setFactCheckAsked(true);
    }, [article, articleId]);

    const handleToggleSave = useCallback(async () => {
        if (!article) return;
        try {
            if (isSaved) {
                // The boolean matters: if the row was already gone (deleted
                // from the Saved list while this screen sat mounted) nothing was
                // removed, so a "Removed" toast would be a lie. The saved-state
                // publish still corrects the bookmark either way.
                const removed = await deleteSavedSuggestion(article._id);
                if (removed) {
                    showSavedToast(t('savedSuggestions.removedToastMessage'), true);
                }
            } else {
                await saveStandaloneArticle(article, { surface: 'detail' });
                showSavedToast(t('savedSuggestions.savedToastMessage'));
            }
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'ArticleDetailScreen', method: 'toggleSave' },
                extra: { articleId: article._id ?? articleId },
            });
        }
    }, [article, isSaved, showSavedToast, t, articleId]);

    const handleArticleUrlPress = async (rawUrl: string | null | undefined) => {
        // Second gate for item 16 — the render already refuses to show a CTA
        // for an insecure URL, but this handler is also reachable via the
        // translate affordance, so it re-checks rather than trusting its caller.
        const url = secureUrlOrNull(rawUrl);
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

    return {
        article,
        isSaved,
        isLoading,
        error,
        notFound,
        factCheckPhase,
        aiAccess,
        orphanFactChecks,
        offlineUnavailable,
        snapshotSource,
        showScrollToTop,
        titleDisplay,
        handleTitleDisplayChange,
        relatedRows,
        isLoadingRelated,
        isLoadingMoreRelated,
        loadMoreRelated,
        relatedError,
        retryRelated,
        relatedSortMode,
        setRelatedSortMode,
        scrollViewRef,
        openedIds,
        handleScrollPositionChange,
        scrollToTop,
        scrollToRelated,
        factCheckAsked,
        handleStartFactCheck,
        handleToggleSave,
        handleArticleUrlPress,
    };
}
