import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import ArticleCountForYouBanner from '@/components/custom/ArticleCountForYouBanner';
import FeedSyncLastUpdateText from '@/components/custom/FeedSyncLastUpdateText';
import NewsPollingBanner from '@/components/custom/NewsPollingBanner';
import SyncProgressForYouBanner from '@/components/custom/SyncProgressForYouBanner';
import { ArticleCard } from '@/components/custom/ArticleCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import DailyLimitForYouBanner from '@/components/custom/for-you/DailyLimitForYouBanner';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import PriorityLabelCard from '@/components/custom/PriorityLabelCard';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import SectionNavigator, { SectionItem } from '@/components/custom/for-you/SectionNavigator';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import { getDisplaySectionLabel, getRelevanceLabel } from '@/lib/relevance-utils';
import { ForYouSuggestion, useForYouStore } from '@/lib/stores/for-you-store';
import {
    buildStoryGroups,
    pickRepresentative,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useInjectNoise } from '@/lib/stores/mera-protocol-store';
import {
    getForYouActions,
    useForYouCounts,
    useForYouAsyncJobPhase,
    useForYouDeviceProcessing,
    useForYouHasGeneratedTopics,
    useForYouLastProcessingRunFinishedAt,
    useForYouNoisyDiscardedCount,
    useForYouPagination,
    useForYouSuggestions,
    useForYouSyncStatusMessage,
    useForYouScoringError,
    useForYouDailyLimitResetAt,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import { useUserStore } from '@/lib/stores/user-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, NativeScrollEvent, NativeSyntheticEvent, StyleSheet, View, ViewToken } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type PriorityLabelItem = { type: 'priority-label'; label: string; relevance: number };
// `members` = the other suggestions collapsed into this story card (group minus
// representative). Present only when the group has more than one member.
type SuggestionItem = { type: 'suggestion'; data: ForYouSuggestion; members?: ForYouSuggestion[] };
type ForYouListItem = PriorityLabelItem | SuggestionItem;

// Number of additional source publications a collapsed story carries, for the
// "+N sources" chip. Count the distinct member publication names (trimmed,
// case-insensitive) that differ from the representative's; each unknown/null
// name counts as its own distinct source. If every member shares the
// representative's publication we still surface the extra articles, so fall
// back to the raw member count.
function computeMoreSourcesCount(rep: ForYouSuggestion, members: ForYouSuggestion[]): number {
    if (members.length === 0) return 0;
    const repPub = (rep.publication_name ?? '').trim().toLowerCase();
    const distinct = new Set<string>();
    for (const m of members) {
        const pub = (m.publication_name ?? '').trim().toLowerCase();
        if (pub !== repPub) distinct.add(pub || `__unknown_${m._id}`);
    }
    return distinct.size > 0 ? distinct.size : members.length;
}

// Profile is now a bottom tab — the right-edge swipe still opens it directly
// (the header gear icon that used to open the config panel is removed).
const openConfigPanel = () => router.push('/logged-in/app_container/profile');


const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<ForYouListItem>);

const SCROLL_THRESHOLD = 300; // Show FAB after scrolling 300px

const MeraNewsScreen: React.FC = () => {
    const { t } = useTranslation();
    // Local UI state only
    const [isLoading, setIsLoading] = useState(false);
    const [isMetadataLoading] = useState(false);
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const [isLoadingMore] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const { fromOnboarding } = useLocalSearchParams<{ fromOnboarding?: string }>();
    const [showOnboardingWait, setShowOnboardingWait] = useState(false);
    const [stuckOnEmpty, setStuckOnEmpty] = useState(false);
    const dbReady = useDatabaseStore((s) => s.ready);
    const edgeSwipeGesture = useMemo(() => Gesture.Pan()
        .activeOffsetX(-20)
        .failOffsetX(20)
        .failOffsetY([-20, 20])
        .onEnd((event) => {
            if (event.translationX < -50) {
                runOnJS(openConfigPanel)();
            }
        }), []);

    // Optimized Zustand selectors (granular subscriptions to prevent unnecessary re-renders)
    const suggestions = useForYouSuggestions();
    const hasGeneratedInterests = useForYouHasGeneratedTopics();
    const { articleCount } = useForYouCounts();
    const { hasNextPage } = useForYouPagination();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const { isDeviceProcessing } = useForYouDeviceProcessing();
    const unscoredCount = useForYouUnscoredCount();
    const syncStatusMessage = useForYouSyncStatusMessage();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
    const noisyDiscardedCount = useForYouNoisyDiscardedCount();
    const injectNoiseEnabled = useInjectNoise();
    const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();
    const [nowTick, setNowTick] = useState(() => Date.now());

    useEffect(() => {
        if (!lastProcessingRunFinishedAt && !dailyLimitResetAt) return;
        const id = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [lastProcessingRunFinishedAt, dailyLimitResetAt]);

    const lastProcessedLabel = useMemo(() => {
        if (!lastProcessingRunFinishedAt) return null;
        const diffSec = Math.max(0, Math.floor((nowTick - lastProcessingRunFinishedAt) / 1000));
        if (diffSec < 60) return t('feed.justNow');
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return t('feed.minutesAgo', { count: diffMin });
        const diffHour = Math.floor(diffMin / 60);
        if (diffHour < 24) return t('feed.hoursAgo', { count: diffHour });
        const diffDay = Math.floor(diffHour / 24);
        return t('feed.daysAgo', { count: diffDay });
    }, [lastProcessingRunFinishedAt, nowTick, t]);

    const isAnySyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    const showSyncProgress =
        isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing || scoringError !== null;

    // Any client-visible fetch/scoring work still in flight. Deliberately
    // excludes scoringError — an error is not progress.
    const isFeedProcessing =
        isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing || unscoredCount > 0;

    // The user is over their daily delivery cap (sticky until a sync delivers
    // again or the reset time passes). Takes banner priority over the
    // article-count line so the "limit reached" notice is always visible.
    const isDailyLimited =
        dailyLimitResetAt != null && nowTick < dailyLimitResetAt;

    const { analysedCount, relevantCount } = useMemo(() => {
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        let analysed = 0;
        let relevant = 0;
        for (const s of suggestions) {
            if (s.status === ArticleSuggestionStatus.Unscored) continue;
            const t = Date.parse(s.firstPubDate);
            if (!Number.isFinite(t) || t < cutoffMs) continue;
            analysed++;
            if (s.relevance > 0.3) relevant++;
        }
        return { analysedCount: analysed, relevantCount: relevant };
    }, [suggestions]);

    const { setHasGeneratedTopics } = getForYouActions();

    const { userPersona, fetchUserPersona } = useUserStore();

    const { data: session } = authClient.useSession();
    const isConnected = useIsConnected();
    const insets = useSafeAreaInsets();

    const flatListRef = useRef<FlatList<ForYouListItem>>(null);
    const loadingRef = useRef(false);
    const [activeSection, setActiveSection] = useState<string | null>(null);
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 });

    // Initial load — fetch if store is empty (first visit or after logout).
    useEffect(() => {
        const storeState = useForYouStore.getState();
        if (!session?.user?.id) return;
        if (storeState.suggestions.length === 0) {
            loadArticles();
        }
        // Initial load keyed only on the user id; loadArticles is re-created each
        // render and excluded to avoid re-fetching on unrelated re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.user?.id]);

    // First arrival from onboarding: show waiting card if user has any facts locally.
    useEffect(() => {
        if (fromOnboarding !== '1') return;
        let cancelled = false;
        getFacts()
            .then((facts) => {
                if (!cancelled && facts.length > 0) setShowOnboardingWait(true);
            })
            .catch((err: unknown) => {
                logger.captureException(err, {
                    tags: { screen: 'ForYouScreen', step: 'get-facts-onboarding' },
                });
            });
        return () => { cancelled = true; };
    }, [fromOnboarding]);

    // No foreground refetch — feed updates come exclusively from the
    // hourly silent push (background reconciler) or the Process button.

    const loadArticles = async () => {
        if (!session?.user?.id) {
            return;
        }

        if (loadingRef.current) {
            return;
        }
        loadingRef.current = true;

        try {
            setErrorMessage(null);
            setIsLoading(true);

            // Fetch user persona from store (cached). Only sets up local
            // persona/topic state — the feed itself is hydrated by the
            // local DB stores via background syncs.
            const persona = await fetchUserPersona(session.user.id);
            const fetchedUserPersonaId = persona?._id;

            // Check if user has generated topics
            const hasInterests = persona?.userTopics && persona.userTopics.length > 0;
            setHasGeneratedTopics(hasInterests ?? false);

            if (!fetchedUserPersonaId || !hasInterests) {
                return;
            }

        } catch (error: any) {
            logger.captureException(error, {
                tags: { screen: 'ForYouScreen', method: 'loadArticles' },
                extra: { userId: session.user.id },
            });

            // Surface a user-visible error message — never expose raw server strings
            const isNetworkError = error?.networkError || error?.message?.includes('Network request failed');
            if (isNetworkError) {
                setErrorMessage(t('errors.networkError'));
            } else {
                setErrorMessage(t('errors.feedError'));
            }
        } finally {
            setIsLoading(false);
            loadingRef.current = false;
        }
    };

    // No pagination — feed is rebuilt locally by background syncs.
    const loadMoreArticles = useCallback(() => { }, []);

    // Scored cards grouped by priority, then collapsed into one card per story.
    // Unscored rows and low-relevance rows (≤ 0.3) don't render.
    //
    // Story collapse runs union-find over two weak signals (shared
    // `buildStoryGroups` utility): a cluster edge when two suggestions share an
    // HDBSCAN cluster at ≥ CLUSTER_CORE_CONFIDENCE_THRESHOLD membership
    // confidence, a title edge when their normalized-title Jaccard is
    // ≥ TITLE_JACCARD_DISPLAY_THRESHOLD, and (display-only) an IDF-weighted title
    // edge at ≥ WEIGHTED_JACCARD_DISPLAY_THRESHOLD that catches same-story
    // paraphrases sharing distinctive rare tokens but too little raw text
    // overlap. The title edges bridge articles
    // stranded in different clustering generations — the server wipes and
    // re-inserts clusters with fresh ids every run, so the same story can carry
    // different clusterIds across sync times, and cluster edges alone would miss
    // them. Each group collapses to a single representative card; the other
    // members ride along as `members` (surfaced via the "+N sources" chip). The
    // detail screen still fetches the live cluster siblings via
    // `relatedArticles(articleId)`.
    const listData: ForYouListItem[] = useMemo(() => {
        if (suggestions.length === 0) return [];

        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        const pubDateMs = (s: ForYouSuggestion): number => {
            const t = Date.parse(s.firstPubDate);
            return Number.isFinite(t) ? t : -Infinity;
        };

        const labelRank = (label: string): number => {
            if (label === 'Emergency Priority Articles') return 0;
            if (label === 'High Priority Articles') return 1;
            if (label === 'Medium Priority Articles') return 2;
            if (label === 'Low Priority Articles') return 3;
            return 4;
        };

        const visible = suggestions.filter((s) => {
            if (s.status === ArticleSuggestionStatus.Unscored) return false;
            if (s.relevance <= 0.3) return false;
            const t = pubDateMs(s);
            if (t === -Infinity || t < cutoffMs) return false;
            return true;
        });

        // Union-find over cluster + title edges (see the block comment above).
        const groups = buildStoryGroups(
            visible.map((s) => ({
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

        // Each group collapses to one representative: the newest member of the
        // story's best-earned priority bucket fronts the card — a fresh
        // development re-fronts the story; relevance only tiebreaks. The
        // bucket is the section the group's max relevance maps to (via
        // getRelevanceLabel), so the chosen card's own on-card priority chip
        // always matches the section it renders in. Tie-break relevance, then
        // smaller id (inside pickRepresentative).
        const entries = groups.map((g) => {
            const maxRelevance = g.reduce((max, m) => Math.max(max, m.s.relevance), -Infinity);
            const bucketLabel = getRelevanceLabel(maxRelevance);
            const pool = g.filter((m) => getRelevanceLabel(m.s.relevance) === bucketLabel);
            const rep = pickRepresentative(
                pool,
                (a, b) => (pubDateMs(b.s) - pubDateMs(a.s)) || (b.s.relevance - a.s.relevance),
            );
            return { rep: rep.s, members: g.filter((m) => m !== rep).map((m) => m.s) };
        });

        if (__DEV__) {
            const multiMember = entries.filter((e) => e.members.length > 0).length;
            const collapsed = visible.length - groups.length;
            console.log(
                `[ForYou] story groups: ${groups.length} groups, ${multiMember} multi-member, ${collapsed} cards collapsed`,
            );
        }

        entries.sort((a, b) => {
            const lr =
                labelRank(getRelevanceLabel(a.rep.relevance)) -
                labelRank(getRelevanceLabel(b.rep.relevance));
            if (lr !== 0) return lr;
            return pubDateMs(b.rep) - pubDateMs(a.rep);
        });

        const items: ForYouListItem[] = [];
        let currentLabel = '';

        for (const { rep, members } of entries) {
            const label = getRelevanceLabel(rep.relevance);
            if (label !== currentLabel) {
                currentLabel = label;
                items.push({ type: 'priority-label', label, relevance: rep.relevance });
            }
            items.push({ type: 'suggestion', data: rep, members: members.length > 0 ? members : undefined });
        }

        // Unscored section — articles that have been fetched but not yet scored.
        // Sorted by newest-first since relevance isn't known yet.
        const unscored = suggestions
            .filter((s) => s.status === ArticleSuggestionStatus.Unscored)
            .sort((a, b) => pubDateMs(b) - pubDateMs(a));
        if (unscored.length > 0) {
            items.push({ type: 'priority-label', label: 'Unscored Articles', relevance: -1 });
            for (const s of unscored) {
                items.push({ type: 'suggestion', data: s });
            }
        }

        return items;
    }, [suggestions]);

    const availableSections = useMemo((): SectionItem[] => {
        const seen = new Set<string>();
        const result: SectionItem[] = [];
        for (const item of listData) {
            if (item.type !== 'priority-label') continue;
            const shortLabel = getDisplaySectionLabel(item.label);
            if (!seen.has(shortLabel)) {
                seen.add(shortLabel);
                result.push({ label: item.label, shortLabel });
            }
        }
        return result;
    }, [listData]);

    // Hide the onboarding waiting card once the first scored, relevant card is ready.
    useEffect(() => {
        if (showOnboardingWait && listData.length > 0) {
            setShowOnboardingWait(false);
        }
    }, [showOnboardingWait, listData.length]);

    // Clear the watchdog error when a new sync cycle becomes active or when
    // cloud async scoring starts. Without this, stuckOnEmpty persists while
    // the progress bar/status text shows active work.
    useEffect(() => {
        if (!syncStatusMessage) return;
        const isActive =
            syncStatusMessage.state !== 'idle' &&
            syncStatusMessage.state !== 'failed' &&
            syncStatusMessage.state !== 'done';
        if (isActive) setStuckOnEmpty(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncStatusMessage?.state]);

    useEffect(() => {
        if (asyncJobPhase !== 'idle') setStuckOnEmpty(false);
    }, [asyncJobPhase]);

    // Empty-feed watchdog. If the For You screen has been mounted with no
    // renderable cards for 30s — and the user is signed in, hydration has
    // finished, interests are generated, and no user-visible error is shown —
    // something silently failed upstream (swallowed error, stalled scoring,
    // stale unscoredCount). Send a Sentry event with a snapshot of the store
    // state, and break the spinner loop in ListEmptyComponent so the user
    // sees a recoverable card instead of a forever-spinner.
    useEffect(() => {
        if (listData.length > 0) {
            if (stuckOnEmpty) setStuckOnEmpty(false);
            return;
        }
        const shouldArm =
            !!session?.user?.id &&
            dbReady &&
            hasGeneratedInterests &&
            !errorMessage &&
            // An empty feed because the user has no topics configured is an
            // expected state, not a silent failure — the no-topics prompt is
            // shown elsewhere. Don't trip the watchdog (and don't spam Sentry).
            syncStatusMessage?.errorCode !== 'no-topics-configured' &&
            // A feed blocked by the daily delivery cap is an expected state,
            // not a silent failure — the limit banner explains it.
            !isDailyLimited &&
            asyncJobPhase === 'idle' && // cloud scoring in-flight counts as productive work
            unscoredCount === 0; // unscored articles exist but scoring is blocked (e.g. no push token) — not truly stuck
        if (!shouldArm) return;

        const timer = setTimeout(() => {
            const s = useForYouStore.getState();
            const d = useDatabaseStore.getState();
            logger.captureMessage('ForYouScreen empty-feed watchdog tripped', {
                level: 'warning',
                tags: { screen: 'ForYouScreen', watchdog: 'empty-feed-30s' },
                extra: {
                    suggestionsLen: s.suggestions.length,
                    unscoredCount: s.unscoredCount,
                    asyncJobPhase: s.asyncJobPhase,
                    asyncJobProcessedCount: s.asyncJobProcessedCount,
                    asyncJobTotalCount: s.asyncJobTotalCount,
                    articleCount: s.articleCount,
                    hasGeneratedTopics: s.hasGeneratedTopics,
                    lastProcessingRunFinishedAt: s.lastProcessingRunFinishedAt,
                    dbReady: d.ready,
                    loadingRef: loadingRef.current,
                },
            });
            setStuckOnEmpty(true);
        }, 30_000);

        return () => clearTimeout(timer);
        // Re-arms the stuck-on-empty timer on the listed state inputs only; the
        // store snapshots read inside are pulled via getState() at fire time, so
        // they are intentionally excluded from the dep array.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, listData.length, asyncJobPhase, unscoredCount, syncStatusMessage?.errorCode, isDailyLimited]);

    const handleSuggestionPress = useCallback((suggestion: ForYouSuggestion) => {
        const userPersonaId = useUserStore.getState().userPersona?._id || '';
        router.push({
            pathname: '/logged-in/suggestion-detail',
            params: {
                articleSuggestionId: suggestion._id,
                userId: session?.user?.id || '',
                userPersonaId: userPersonaId,
            }
        });
    }, [session?.user?.id]);

    const renderItem: ListRenderItem<ForYouListItem> = useCallback(({ item }) => {
        if (item.type === 'priority-label') {
            return <PriorityLabelCard label={item.label} relevance={item.relevance} />;
        }
        const moreSourcesCount = item.members ? computeMoreSourcesCount(item.data, item.members) : 0;
        return (
            <ArticleCard
                suggestion={item.data}
                moreSourcesCount={moreSourcesCount}
                onPress={() => handleSuggestionPress(item.data)}
            />
        );
    }, [handleSuggestionPress]);

    const ListEmptyComponent = useCallback(() => {
        if (showOnboardingWait) {
            return <OnboardingWaitingCard />;
        }

        if (isLoading && !stuckOnEmpty) {
            return (
                <Box className="items-center justify-center py-20">
                    <Spinner size="large" />
                </Box>
            );
        }

        if (stuckOnEmpty) {
            return (
                <Box className="items-center justify-center py-20 px-6">
                    <Icon as={AlertCircleIcon} size="xl" className="text-error-400 mb-3" />
                    <Text size="md" className="text-error-400 text-center font-semibold mb-1">
                        {t('feed.stuckTitle')}
                    </Text>
                    <Text size="sm" className="text-typography-400 text-center">
                        {t('feed.stuckDescription')}
                    </Text>
                    <Text size="xs" className="text-typography-500 text-center mt-3">
                        {t('feed.stuckHint')}
                    </Text>
                </Box>
            );
        }

        if (errorMessage) {
            return (
                <Box className="items-center justify-center py-20 px-6">
                    <Icon as={AlertCircleIcon} size="xl" className="text-error-400 mb-3" />
                    <Text size="md" className="text-error-400 text-center font-semibold mb-1">
                        {t('errors.failedToLoad')}
                    </Text>
                    <Text size="sm" className="text-typography-400 text-center">
                        {errorMessage}
                    </Text>
                    <Text size="xs" className="text-typography-500 text-center mt-3">
                        {t('feed.pullDownToRetry')}
                    </Text>
                </Box>
            );
        }

        if (!hasGeneratedInterests) {
            return <NoGeneratedInterestsCard />;
        }

        // While work is in flight — or before the very first processing run has
        // ever completed on this device — the feed isn't "caught up", it's
        // still being prepared.
        if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
            return <FeedPreparingCard />;
        }

        return <AllCaughtUpCard />;
    }, [showOnboardingWait, isLoading, hasGeneratedInterests, errorMessage, t, stuckOnEmpty, isFeedProcessing, lastProcessingRunFinishedAt]);

    const ListFooterComponent = useCallback(() => {
        if (isLoadingMore) {
            return (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            );
        }
        // Only show the footer "caught up" card when the visible list isn't
        // empty — otherwise ListEmptyComponent already renders one and we'd
        // get two stacked cards (e.g. when every suggestion is filtered out).
        if (listData.length > 0 && !hasNextPage) {
            return isFeedProcessing ? <FeedPreparingCard /> : <AllCaughtUpCard />;
        }
        return null;
    }, [listData.length, isLoadingMore, hasNextPage, isFeedProcessing]);

    const keyExtractor = useCallback((item: ForYouListItem, index: number) => {
        if (item.type === 'priority-label') return `label-${item.label}`;
        return item.data._id || `suggestion-${index}`;
    }, []);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        setShowScrollToTop(offsetY > SCROLL_THRESHOLD);
        notifyScrollTick();
    }, []);

    const scrollToTop = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        if (viewableItems.length === 0) return;
        const firstLabel = viewableItems.find((vi) => vi.item?.type === 'priority-label');
        if (firstLabel) {
            setActiveSection(getDisplaySectionLabel((firstLabel.item as PriorityLabelItem).label));
            return;
        }
        const firstIdx = viewableItems[0]?.index ?? 0;
        for (let i = firstIdx - 1; i >= 0; i--) {
            if (listData[i]?.type === 'priority-label') {
                setActiveSection(getDisplaySectionLabel((listData[i] as PriorityLabelItem).label));
                return;
            }
        }
    }, [listData]);

    const scrollToSection = useCallback((shortLabel: string) => {
        const index = listData.findIndex(
            (item) => item.type === 'priority-label' && getDisplaySectionLabel(item.label) === shortLabel,
        );
        if (index !== -1) {
            flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
        }
    }, [listData]);

    const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
        flatListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        setTimeout(() => {
            flatListRef.current?.scrollToIndex({ index: info.index, animated: true });
        }, 100);
    }, []);

    return (
        <Box className="flex-1 bg-black">
            <VStack className="px-5 pb-4 border-gray-800 z-10" style={{ paddingTop: insets.top + 16 }}>
                {/* Title row — static */}
                <HStack className="items-start justify-between mb-1">
                    <VStack className="flex-1 min-w-0 mr-3">
                        <Heading size="3xl" className="text-white" numberOfLines={1}>{t('feed.forYou')}</Heading>
                        <FeedSyncLastUpdateText lastProcessedLabel={lastProcessedLabel} />
                    </VStack>
                    <HStack className="items-center flex-shrink-0" space="sm">
                        <Pressable
                            onPress={() => router.push('/logged-in/visited-publications')}
                            hitSlop={12}
                            accessibilityRole="button"
                            accessibilityLabel={t('publicationVisits.visitedListTitle')}
                            className="p-3 rounded-full border border-primary-500 bg-transparent"
                        >
                            <MaterialIcons name="history" size={22} color="#EDA77E" />
                        </Pressable>
                        <Pressable
                            onPress={() => router.push('/logged-in/saved-suggestions')}
                            hitSlop={12}
                            accessibilityRole="button"
                            accessibilityLabel={t('savedSuggestions.title')}
                            className="p-3 rounded-full border border-primary-500 bg-transparent"
                        >
                            <MaterialIcons name="bookmark" size={22} color="#EDA77E" />
                        </Pressable>
                    </HStack>
                </HStack>

                {/* Banner area — polling status + progress/article-count in one compact slot */}
                <View className="mb-2" style={{ minHeight: 70 }}>
                    <NewsPollingBanner />
                    {isDailyLimited ? (
                        <DailyLimitForYouBanner />
                    ) : showSyncProgress ? (
                        <SyncProgressForYouBanner />
                    ) : (
                        <ArticleCountForYouBanner
                            articlesProcessed={articleCount}
                            articlesAnalysed={analysedCount}
                            articlesImpactful={relevantCount}
                            articlesNoiseRemoved={noisyDiscardedCount}
                            injectNoiseEnabled={injectNoiseEnabled}
                            lastSuccessfulCompletedAt={userPersona?.lastSuccessfulCompletedAt}
                            isLoading={isMetadataLoading}
                        />
                    )}
                </View>
                {availableSections.length > 0 && (
                    <Box className="mt-2 mb-1">
                        <SectionNavigator
                            sections={availableSections}
                            activeSection={activeSection}
                            onSelect={scrollToSection}
                        />
                    </Box>
                )}
                {!isConnected && (
                    <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mt-2" space="sm">
                        <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                        <Text size="sm" className="text-warning-400">{t('feed.offlineCached')}</Text>
                    </HStack>
                )}
            </VStack>
            <AnimatedFlatList
                ref={flatListRef}
                data={listData}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                contentContainerStyle={{ paddingVertical: 20, paddingBottom: 100 }}
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={16}
                onScroll={handleScroll}
                onEndReached={loadMoreArticles}
                onEndReachedThreshold={0.5}
                ListEmptyComponent={ListEmptyComponent}
                ListFooterComponent={ListFooterComponent}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 10,
                }}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig.current}
                onScrollToIndexFailed={onScrollToIndexFailed}
            />
            <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} extraBottomOffset={TAB_BAR_HEIGHT} />

            {/* Right edge swipe hitbox */}
            <GestureDetector gesture={edgeSwipeGesture}>
                <View style={styles.edgeSwipeHitbox} />
            </GestureDetector>

        </Box>
    );
};

const styles = StyleSheet.create({
    edgeSwipeHitbox: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 40,
    },
});

export default MeraNewsScreen;
