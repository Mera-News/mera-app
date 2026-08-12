import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import FactCheckPanel from '@/components/custom/news-detail/FactCheckPanel';
import { requestArticleFactCheck } from '@/lib/fact-check/request-article-fact-check';
import { mirrorArticleFactCheck } from '@/lib/fact-check/fact-check-graphql-client';
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
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
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
import type { ArticleSummary, NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useSavedOverride } from '@/lib/saved-state';
import { isOpenedId } from '@/lib/stores/fact-rows-selector';
import { useIsConnected, useNetworkStore } from '@/lib/stores/network-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { orderRelatedArticles } from '@/lib/feed-grouping/related-articles-sort';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { secureUrlOrNull } from '@/lib/secure-url';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useAutoCommunityFactCheck } from '@/lib/stores/mera-protocol-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { useStoredFactCheck } from '@/lib/fact-check/use-stored-fact-check';

interface ArticleDetailScreenProps {
    articleId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
    /** Stable story id from nav params, when the caller already knows it. When
     *  absent, the track flow resolves it lazily via getNewsClusterForArticle. */
    stableClusterId?: string;
}

const SCROLL_THRESHOLD = 300;

// Map a sibling ArticleSummary to the NewsArticle shape ArticleStandaloneCompactCard
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
    const [savedFromDb, setSavedFromDb] = useState(false);
    // See lib/saved-state — a save/delete on any other surface (notably the
    // Dashboard's Saved list) corrects this screen's bookmark without a remount.
    const savedOverride = useSavedOverride(article?._id ?? articleId);
    const isSaved = savedOverride ?? savedFromDb;
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingRelated, setIsLoadingRelated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The tick's icon state — a pure observer of the stored rows, same hook
    // `FactCheckPanel` uses below. Two independent subscriptions to the same
    // WatermelonDB query, not a shared instance: unlike the old request-driving
    // hook there is no imperative action state to keep in sync, only a live
    // read, so there is nothing wrong with two components each watching it.
    const factCheckPhase = useFactCheck(article?._id ?? articleId).phase;
    const aiAccess = useAiAccess();
    // The only fact-check switch left. Fact checking itself is part of the
    // product; this is consent to LOOK ONE UP on every article opened, rather
    // than only when the reader asks. Off by default.
    const withFactCheck = useAutoCommunityFactCheck();
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
    const insets = useSafeAreaInsets();
    const userCtx = useUserGeoLanguageContext();
    const scrollViewRef = useRef<SmoothScrollViewRef>(null);
    const openedIds = useOpenedStoriesStore((s) => s.ids);
    const isConnected = useIsConnected();
    // Bumped to re-run the fetch effect when connectivity returns while the
    // offline-unavailable empty state is showing (see the retry effect below).
    const [retryNonce, setRetryNonce] = useState(0);
    const hadOfflineFailureRef = useRef(false);

    // Country of the article being viewed — anchors the related list's first
    // block (see `orderRelatedArticles`). Null until the article resolves, which
    // costs at most one reorder of the memo below.
    const currentCountryAlpha3 = article?.publicationSource?.country_code ?? null;

    // How the reader wants the related list ordered. ONE persisted setting
    // shared with the suggestion-detail route — see related-sort-store.
    const relatedSortMode = useRelatedSortStore((s) => s.mode);
    const setRelatedSortMode = useRelatedSortStore((s) => s.setMode);

    // Server related rows, ordered into contiguous per-country blocks: this
    // article's country first, then the remaining countries biggest-block first,
    // countryless rows last; within a block, language → publication → date → id.
    // Non-mutating; `userCtx === null` (still loading) only relaxes the
    // language/rank preferences, the blocks still form. In 'oldest'/'newest'
    // mode the country blocking is bypassed entirely (see orderRelatedArticles).
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
        return orderRelatedArticles(entries, currentCountryAlpha3, userCtx, relatedSortMode);
    }, [related, currentCountryAlpha3, userCtx, relatedSortMode]);

    const handleScrollPositionChange = useCallback((y: number) => {
        setShowScrollToTop(y > SCROLL_THRESHOLD);
    }, []);

    const scrollToTop = useCallback(() => {
        scrollViewRef.current?.scrollToTop(true);
    }, []);

    // The feedback tree's "Show related coverage" nudge. The related articles
    // are this page's footer, so the answer is to scroll there, not to navigate.
    const scrollToRelated = useCallback(() => {
        scrollViewRef.current?.scrollToEnd(true);
    }, []);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);
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

        ArticleService.getArticleById(articleId, withFactCheck)
            .then((row) => {
                if (cancelled) return;
                if (!row) {
                    attemptTtlFallback();
                } else {
                    setArticle(row);
                    setIsLoading(false);
                    // A fact check somebody ELSE already paid for arrives
                    // attached to the article. Land it in the local table so
                    // the panel below renders it — without this the check is
                    // invisible to everyone except the device that asked, even
                    // though the server-side cache is cross-user. No request of
                    // its own: the row is already in this response. `void` and
                    // not awaited, and it never throws — a missing panel must
                    // never cost the reader the article.
                    void mirrorArticleFactCheck(
                        row._id ?? articleId,
                        row.factCheck,
                        row.title_en_internal_only ?? row.title,
                    );
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
        //
        // `withFactCheck` is deliberately NOT a dep either. The effect closes
        // over the value from the render in which it last ran, and since this
        // screen mounts fresh per article, that is the setting as it stood when
        // the reader opened THIS article. Toggling the switch while an article
        // is already open therefore does not re-fetch it underneath them; the
        // new value applies to the next article. That is a deliberately stale
        // closure, not an oversight.
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
        // Pass stableClusterId through so the server can prefer the stable
        // cross-run cluster over the (possibly already-wiped) live cluster id.
        ArticleService.getRelatedArticles(article._id, stableClusterId)
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
    }, [article?._id, isConnected, stableClusterId]);

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
    const handleStartFactCheck = useCallback(() => {
        if (!article) return;
        const asked = requestArticleFactCheck({
            articleId: article._id ?? articleId,
            title: article.title_en_internal_only ?? article.title ?? '',
        });
        if (!asked) return;
        toast.show({
            placement: 'top',
            duration: 3000,
            render: ({ id }: { id: string }) => (
                <Toast nativeID={id} action="info" variant="solid">
                    <ToastTitle>{t('factCheck.title')}</ToastTitle>
                    <ToastDescription>{t('factCheck.checking')}</ToastDescription>
                </Toast>
            ),
        });
    }, [article, articleId, toast, t]);

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

    // `push`, not `replace`: chaining from one article into a related one must
    // add a stack entry so back returns to the article the user came from
    // rather than jumping straight out to the feed.
    //
    // `stableClusterId` is deliberately NOT forwarded. The next hop is a member
    // of the same cluster, so passing it would look right — but it's also the
    // read-dimming key (`isOpenedId` matches article id OR cluster id, and
    // `markOpened` puts the opened article's cluster id in the set), so the
    // chained article would render as already-read the moment it opens.
    const handleRelatedPress = useCallback((relatedArticleId: string) => {
        router.push({
            pathname: '/logged-in/article-detail',
            params: { articleId: relatedArticleId },
        });
    }, []);

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

    if (offlineUnavailable) {
        // Offline, and no local snapshot to fall back to — a friendlier,
        // non-alarming empty state (not the red "error" card) since this is
        // an expected condition, not a failure. Auto-retries when
        // connectivity returns (see the retryNonce effect above).
        return (
            <Box className="flex-1 items-center justify-center p-5">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <MaterialIcons
                    name="wifi-off"
                    size={48}
                    color="#9CA3AF"
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                />
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
            // ScrollView, not a centred Box: this state can now carry a fact
            // check, which is taller than the screen once it lists several
            // organisations.
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <ScrollView
                    contentContainerStyle={{
                        flexGrow: 1,
                        justifyContent: orphanFactChecks.length > 0 ? 'flex-start' : 'center',
                        alignItems: 'center',
                        padding: 20,
                        paddingTop: orphanFactChecks.length > 0 ? insets.top + 24 : 20,
                        paddingBottom: insets.bottom + 40,
                    }}
                >
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

                    {/* THE 48h CASE. `NewsArticle` rows are swept at 48h while
                        `fact_checks` rows deliberately outlive them, so every
                        fact check older than ~2 days lands here — that is the
                        normal state of an older row, not an edge case. The
                        reader tapped a fact check; losing it to a bare "Article
                        not found" would throw away everything the device still
                        holds for it — post-v52 that can be SEVERAL rows, one
                        per claim the reader asked about. No `onPress`: there is
                        nowhere further to go. Gated with the panel below: a
                        reader who turned fact checking off must not meet it
                        here either, on rows mirrored before they did. */}
                    {orphanFactChecks.length > 0 && (
                        <Box className="w-full mt-6" testID="article-detail-orphan-fact-check">
                            <Text size="sm" className="text-typography-400 text-center mb-3">
                                {t('factCheck.dashboard.articleGone')}
                            </Text>
                            <VStack space="sm">
                                {orphanFactChecks.map((item) => (
                                    <FactCheckCard
                                        key={item.id}
                                        item={item}
                                        testIDPrefix="article-detail-fact-check"
                                    />
                                ))}
                            </VStack>
                        </Box>
                    )}

                    <Pressable onPress={onBack} className="mt-6 bg-gray-800 rounded-lg px-6 py-3">
                        <Text size="md" className="text-white">{t('common.goBack')}</Text>
                    </Pressable>
                </ScrollView>
            </Box>
        );
    }

    const sourceLanguage = article.original_language_code ?? null;
    // Item 16 (defence in depth): the server already drops insecure articles
    // from every serving path, but a row restored from a local snapshot (saved
    // article, 30-day publication-visit history) can predate that filter. An
    // `http://` URL is treated as UNAVAILABLE — an explicit notice replaces the
    // read/translate/share block — never as a button that quietly does nothing.
    const rawArticleUrl = article.article_url ?? null;
    const articleUrl = secureUrlOrNull(rawArticleUrl);
    const insecureLink = !!rawArticleUrl && !articleUrl;
    const read = isOpenedId(article._id, stableClusterId, openedIds);

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
                        {/* Only the 'saved' snapshot gets a banner. That one is
                            the offline path, where "showing cached content" is
                            true and the read button may not even work.
                            'visit' is deliberately silent: it happens ONLINE,
                            and the only thing missing is Mera's server copy —
                            the publisher's page is right there and the
                            read/translate block below opens it. Every warning
                            string this app owns ("no longer available",
                            "offline: showing cached") would contradict the
                            working Read button a few lines further down. An
                            honest 'visit' string — "Mera no longer has this
                            story, you can still open it at the publisher" — is
                            new copy, and new copy means the 20-locale wave. */}
                        {snapshotSource === 'saved' && (
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
                            <VStack space="md">
                                <ArticleFeedbackPrompt
                                    // Hidden entirely on a locked free-tier plan
                                    // (the server resolvers are behind
                                    // SubscriptionGuard) or when the reader has
                                    // turned fact checking off.
                                    // `requestArticleFactCheck` no-ops in both
                                    // cases too (belt-and-suspenders, see that
                                    // file), but a tick that visibly does
                                    // nothing is worse than no tick at all.
                                    //
                                    // NO LONGER hidden on on-device processing:
                                    // that gate existed because the CHAT's
                                    // claim picker is cloud-only, and the tick
                                    // no longer opens a chat — it asks the
                                    // server, which needs no cloud chat.
                                    factCheck={aiAccess !== 'locked' ? {
                                        onStart: () => handleStartFactCheck(),
                                        // 'stalled' reads as 'pending' here too —
                                        // the tick only has a single/double
                                        // vocabulary (asked-or-unasked vs
                                        // answered), and a poll that gave up is
                                        // still "asked, no answer yet" from the
                                        // tick's point of view. The PANEL is
                                        // where 'stalled' gets its own honest copy.
                                        state: factCheckPhase === 'terminal'
                                            ? 'done'
                                            : factCheckPhase === 'processing' || factCheckPhase === 'stalled'
                                                ? 'pending'
                                                : 'none',
                                    } : undefined}
                                    articleId={article._id ?? articleId}
                                    title={article.title_en_internal_only ?? article.title ?? ''}
                                    // REQUIRED: this screen also serves articles
                                    // with NO local article_suggestions row
                                    // (Explore, a tracked story, a shared link).
                                    // Without it those verdicts persist an empty
                                    // context and the feedback tree has no
                                    // publication / category / event / place to
                                    // act on — the gap this wave closed.
                                    article={article}
                                    onBrowseRelated={scrollToRelated}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'article',
                                        surface: 'detail',
                                        articleId: article._id ?? articleId,
                                        title: article.title_en_internal_only ?? article.title ?? '',
                                        // See ArticleSuggestionScreen — omitting
                                        // this makes the timeline's seed row show
                                        // the track moment instead of the
                                        // article's publication age.
                                        pubDate: article.pubDate ?? null,
                                        publicationName: article.publicationSource?.publication_name,
                                        countryCode: article.publicationSource?.country_code,
                                        stableClusterId,
                                    }}
                                    share={{
                                        url: articleUrl,
                                        titleEnglish: article.title_en_internal_only ?? article.title,
                                        titleOriginal: article.title,
                                        sourceLanguage: article.original_language_code,
                                        displayedTitle: titleDisplay?.text ?? null,
                                        displayedLanguage: titleDisplay?.language ?? null,
                                    }}
                                />
                                <ReadTranslateActions
                                    articleUrl={articleUrl}
                                    sourceLanguage={sourceLanguage}
                                    publicationName={article.publicationSource?.publication_name}
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
                            on the article id, not the (possibly refused) local
                            link, so it still renders for a row whose URL we
                            won't open. Always mounted — a pure observer of the
                            stored rows, it renders nothing itself when nobody
                            has asked about this article, which is the common
                            case. */}
                        <FactCheckPanel articleId={article._id ?? articleId} />

                        {(isLoadingRelated || related.length > 0) && (
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
