import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import ArticleCountText from '@/components/custom/ArticleCountText';
import { ArticleCard } from '@/components/custom/ArticleCard';
import MeraProtocolProcessingStatus, { ProcessingStage, deriveProcessingStage } from '@/components/custom/MeraProtocolProcessingStatus';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import MeraLogo from '@/components/custom/MeraLogo';
import HeaderProgressBar from '@/components/custom/for-you/HeaderProgressBar';
import OnDeviceProcessingBanner from '@/components/custom/for-you/OnDeviceProcessingBanner';
import { StackedCards } from '@/components/custom/for-you/StackedCards';
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
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useForYouPrefsStore } from '@/lib/stores/for-you-prefs-store';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip';
import { useInjectNoise, useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import {
    getForYouActions,
    useForYouCounts,
    useForYouAsyncJobTotalCount,
    useForYouAsyncJobPhase,
    useForYouDeviceProcessing,
    useForYouHasGeneratedTopics,
    useForYouHydrationProgress,
    useForYouLastProcessingRunFinishedAt,
    useForYouNoisyDiscardedCount,
    useForYouPagination,
    useForYouSuggestions,
    useForYouSyncStatus,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import { useUserStore } from '@/lib/stores/user-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { Icon, SettingsIcon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Notifications from 'expo-notifications';
import { AppState, AppStateStatus, FlatList, ListRenderItem, NativeScrollEvent, NativeSyntheticEvent, StyleSheet, View, ViewToken } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type PriorityLabelItem = { type: 'priority-label'; label: string; relevance: number };
type SuggestionItem = { type: 'suggestion'; data: ForYouSuggestion };
// Stack of 2+ suggestions sharing a clusterId. `data` is sorted with the
// highest-relevance suggestion first — that one becomes the top card.
type StackedSuggestionItem = { type: 'stacked-suggestion'; data: ForYouSuggestion[] };
type ForYouListItem = PriorityLabelItem | SuggestionItem | StackedSuggestionItem;

const openConfigPanel = () => router.push('/logged-in/config-panel');


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
    const unscoredCount = useForYouUnscoredCount();
    const { isDeviceProcessing, deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncJobTotalCount = useForYouAsyncJobTotalCount();
    const { syncStatus, lastSyncError } = useForYouSyncStatus();
    const { hydrationCompleted, hydrationTotal } = useForYouHydrationProgress();
    const noisyDiscardedCount = useForYouNoisyDiscardedCount();
    const injectNoiseEnabled = useInjectNoise();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();
    const recent24hOnly = useForYouPrefsStore((s) => s.recent24hOnly);
    const prefsHydrated = useForYouPrefsStore((s) => s.hydrated);
    const setRecent24hOnly = useForYouPrefsStore((s) => s.setRecent24hOnly);
    const [nowTick, setNowTick] = useState(() => Date.now());

    useEffect(() => {
        if (!lastProcessingRunFinishedAt) return;
        const id = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [lastProcessingRunFinishedAt]);

    const lastProcessedLabel = useMemo(() => {
        if (!lastProcessingRunFinishedAt) return null;
        const diffSec = Math.max(0, Math.floor((nowTick - lastProcessingRunFinishedAt) / 1000));
        if (diffSec < 60) return 'just now';
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHour = Math.floor(diffMin / 60);
        if (diffHour < 24) return `${diffHour}h ago`;
        const diffDay = Math.floor(diffHour / 24);
        return `${diffDay}d ago`;
    }, [lastProcessingRunFinishedAt, nowTick]);

    // Derive the current processing stage from the live store fields, then
    // hold a "done" flash for 2s after the last active stage clears so the
    // user gets a satisfying confirmation before the article-count line
    // fades back in.
    const liveStage = useMemo(
        () => deriveProcessingStage(isOnDeviceProcessing && isDeviceProcessing, asyncJobPhase, syncStatus, hydrationTotal),
        [isOnDeviceProcessing, isDeviceProcessing, asyncJobPhase, syncStatus, hydrationTotal],
    );
    const [displayStage, setDisplayStage] = useState<ProcessingStage>(liveStage);
    const prevActiveRef = useRef(false);
    const prevWasErrorRef = useRef(false);
    useEffect(() => {
        const isLiveActive = liveStage !== 'idle';
        if (prevActiveRef.current && !isLiveActive) {
            // Don't flash 'done' if we just left the error state — error
            // clears when the user retries (or sync restarts), and a green
            // checkmark right after a red error reads as a false success.
            if (!prevWasErrorRef.current) {
                setDisplayStage('done');
                const id = setTimeout(() => setDisplayStage('idle'), 2000);
                prevActiveRef.current = false;
                prevWasErrorRef.current = false;
                return () => clearTimeout(id);
            }
            setDisplayStage('idle');
            prevActiveRef.current = false;
            prevWasErrorRef.current = false;
            return;
        }
        setDisplayStage(liveStage);
        if (isLiveActive) prevActiveRef.current = true;
        prevWasErrorRef.current = liveStage === 'error';
    }, [liveStage]);
    const showStatus = displayStage !== 'idle';
    const showBanner = showStatus && displayStage !== 'hydrating';

    // When the user backgrounds the app during a stage that can't run in the
    // background (the device-bound fetch), fire a local notification asking
    // them to return. Dismiss it once they're back. Read displayStage via a
    // ref so the AppState listener always sees the latest value without
    // re-subscribing on every stage change.
    const displayStageRef = useRef(displayStage);
    useEffect(() => { displayStageRef.current = displayStage; }, [displayStage]);
    useEffect(() => {
        let scheduledId: string | null = null;
        const onChange = async (next: AppStateStatus) => {
            const mustStay = displayStageRef.current === 'sending' || displayStageRef.current === 'hydrating';
            if ((next === 'background' || next === 'inactive') && mustStay) {
                try {
                    scheduledId = await Notifications.scheduleNotificationAsync({
                        content: {
                            title: t('feed.processing.mustReturnNotificationTitle'),
                            body: t('feed.processing.mustReturnNotificationBody'),
                            data: { type: 'mera-resume-fetch' },
                        },
                        trigger: null,
                    });
                } catch (err) {
                    logger.captureException(err, { tags: { service: 'for-you-resume-notif' } });
                }
            } else if (next === 'active' && scheduledId) {
                try { await Notifications.dismissNotificationAsync(scheduledId); } catch { /* best-effort */ }
                scheduledId = null;
            }
        };
        const sub = AppState.addEventListener('change', onChange);
        return () => { sub.remove(); };
    }, [t]);

    const { analysedCount, relevantCount } = useMemo(() => {
        let analysed = 0;
        let relevant = 0;
        for (const s of suggestions) {
            if (!s.relevanceGenerationCompleted) continue;
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
    const loadMoreArticles = useCallback(() => {}, []);

    // Scored cards grouped by priority, then collapsed into clusters.
    // Unscored rows and low-relevance rows (≤ 0.3) don't render.
    //
    // An article can belong to multiple clusters via `cluster-article-link`,
    // so a suggestion's `clusterIds` is a set. We bucket every (suggestion,
    // clusterId) pair, then assign each suggestion to its largest cluster
    // so each card renders exactly once. Suggestions whose largest cluster
    // is still a singleton — or who have no clusterIds at all — render as
    // a plain `ArticleCard`.
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
            if (!s.relevanceGenerationCompleted) return false;
            if (s.relevance <= 0.3) return false;
            if (recent24hOnly) {
                const t = pubDateMs(s);
                if (t === -Infinity || t < cutoffMs) return false;
            }
            return true;
        });

        // Cluster sizes across the visible window: count one membership per
        // (suggestion, clusterId) pair.
        const clusterSizes = new Map<string, number>();
        for (const s of visible) {
            for (const cid of s.clusterIds) {
                clusterSizes.set(cid, (clusterSizes.get(cid) ?? 0) + 1);
            }
        }

        // Assign each suggestion to a single group: its largest cluster (so
        // overlapping cluster sets resolve to the most useful stack). Ties
        // break on the lexicographically-smaller clusterId for stability.
        // Suggestions with no clusterIds, or whose chosen cluster has size 1,
        // become singleton groups keyed by suggestion `_id`.
        const groups = new Map<string, ForYouSuggestion[]>();
        for (const s of visible) {
            let chosen: string | null = null;
            let chosenSize = 0;
            for (const cid of s.clusterIds) {
                const size = clusterSizes.get(cid) ?? 0;
                if (
                    size > chosenSize ||
                    (size === chosenSize && chosen !== null && cid < chosen)
                ) {
                    chosen = cid;
                    chosenSize = size;
                }
            }
            const key = chosen && chosenSize >= 2 ? chosen : `__solo_${s._id}`;
            const bucket = groups.get(key);
            if (bucket) bucket.push(s);
            else groups.set(key, [s]);
        }

        // Each group's "head" — the highest-relevance member — drives its
        // priority bucket and sort position. Within a group, sort members
        // by relevance desc so the top card is also the head.
        type Group = { head: ForYouSuggestion; members: ForYouSuggestion[] };
        const sortedGroups: Group[] = Array.from(groups.values())
            .map((members) => {
                const sortedMembers = [...members].sort(
                    (a, b) => b.relevance - a.relevance,
                );
                return { head: sortedMembers[0], members: sortedMembers };
            })
            .sort((a, b) => {
                const lr =
                    labelRank(getRelevanceLabel(a.head.relevance)) -
                    labelRank(getRelevanceLabel(b.head.relevance));
                if (lr !== 0) return lr;
                return pubDateMs(b.head) - pubDateMs(a.head);
            });

        const items: ForYouListItem[] = [];
        let currentLabel = '';

        for (const { head, members } of sortedGroups) {
            const label = getRelevanceLabel(head.relevance);
            if (label !== currentLabel) {
                currentLabel = label;
                items.push({ type: 'priority-label', label, relevance: head.relevance });
            }
            if (members.length >= 2) {
                items.push({ type: 'stacked-suggestion', data: members });
            } else {
                items.push({ type: 'suggestion', data: head });
            }
        }

        return items;
    }, [suggestions, recent24hOnly]);

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
            !errorMessage;
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
                    syncInProgress: d.syncInProgress,
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
    }, [session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, listData.length]);

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
        if (item.type === 'stacked-suggestion') {
            const top = item.data[0];
            return (
                <StackedCards
                    suggestions={item.data}
                    onPress={() => handleSuggestionPress(top)}
                />
            );
        }
        return (
            <ArticleCard
                suggestion={item.data}
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

        // Don't claim "all caught up" while unscored candidates are still
        // sitting in the local DB — scoring is either in-flight on the
        // backend or recoverable on next tick. The header progress UI
        // (driven by `showStatus`) communicates the in-flight state.
        if (unscoredCount > 0) {
            return (
                <Box className="items-center justify-center py-20">
                    <Spinner size="large" />
                </Box>
            );
        }

        return <AllCaughtUpCard />;
    }, [showOnboardingWait, isLoading, hasGeneratedInterests, errorMessage, t, unscoredCount, stuckOnEmpty]);

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
            return <AllCaughtUpCard />;
        }
        return null;
    }, [listData.length, isLoadingMore, hasNextPage]);

    const keyExtractor = useCallback((item: ForYouListItem, index: number) => {
        if (item.type === 'priority-label') return `label-${item.label}`;
        if (item.type === 'stacked-suggestion') {
            return `stack-${item.data[0]?._id ?? index}`;
        }
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
                {/* Header with For you title and Config FAB */}
                <HStack className="items-center justify-between mb-2">
                    <HStack className="items-center" space="sm">
                        {showStatus ? (
                            <Animated.View
                                key="header-logo"
                                entering={FadeIn.duration(250)}
                                exiting={FadeOut.duration(250)}
                            >
                                <MeraLogo size={40} />
                            </Animated.View>
                        ) : (
                            <Animated.View
                                key="header-title"
                                entering={FadeIn.duration(250)}
                                exiting={FadeOut.duration(250)}
                            >
                                <Heading size="3xl" className="text-white">{t('feed.forYou')}</Heading>
                            </Animated.View>
                        )}
                        {lastProcessedLabel && (
                            <Text size="sm" className="text-gray-400">
                                {`Updated ${lastProcessedLabel}`}
                            </Text>
                        )}
                    </HStack>
                    <HStack className="items-center" space="sm">
                        <HStack className="items-center" space="xs">
                            <Tooltip
                                placement="bottom"
                                trigger={(triggerProps) => (
                                    <Pressable {...triggerProps} hitSlop={8}>
                                        <Text size="xs" className="text-gray-400">24h</Text>
                                    </Pressable>
                                )}
                            >
                                <TooltipContent className="bg-gray-800 py-1.5 px-3 rounded-md max-w-64">
                                    <TooltipText className="text-xs text-white">
                                        Only show articles published within the last 24 hours
                                    </TooltipText>
                                </TooltipContent>
                            </Tooltip>
                            <Switch
                                size="sm"
                                value={prefsHydrated ? recent24hOnly : false}
                                onValueChange={setRecent24hOnly}
                                disabled={!prefsHydrated}
                                trackColor={{ false: '#374151', true: '#7f1d1d' }}
                                thumbColor={recent24hOnly ? '#fca5a5' : '#9ca3af'}
                            />
                        </HStack>
                        <Pressable
                            onPress={openConfigPanel}
                            hitSlop={12}
                            className="p-3 rounded-full bg-primary-500"
                        >
                            <Icon as={SettingsIcon} size="xl" className="text-white" />
                        </Pressable>
                    </HStack>
                </HStack>
                <OnDeviceProcessingBanner />
                {/* Fixed-height slot: status and article count cross-fade in
                    place so the FlatList below never shifts. The thin
                    progress bar sits at the bottom edge of this slot. */}
                <Box style={{ minHeight: 76, position: 'relative', overflow: 'hidden', paddingBottom: 22 }} className="justify-center">
                    {showBanner ? (
                        <Animated.View
                            key="status"
                            entering={FadeIn.duration(250)}
                            exiting={FadeOut.duration(250)}
                        >
                            <MeraProtocolProcessingStatus
                                stage={displayStage}
                                processedCount={deviceProcessedCount}
                                totalCount={deviceTotalCount}
                                asyncJobTotalCount={asyncJobTotalCount}
                                hydrationCompleted={hydrationCompleted}
                                hydrationTotal={hydrationTotal}
                                errorMessage={lastSyncError}
                            />
                        </Animated.View>
                    ) : (
                        <Animated.View
                            key="count"
                            entering={FadeIn.duration(250)}
                            exiting={FadeOut.duration(250)}
                        >
                            <ArticleCountText
                                articlesProcessed={articleCount}
                                articlesAnalysed={analysedCount}
                                articlesImpactful={relevantCount}
                                articlesNoiseRemoved={noisyDiscardedCount}
                                injectNoiseEnabled={injectNoiseEnabled}
                                lastSuccessfulCompletedAt={userPersona?.lastSuccessfulCompletedAt}
                                isLoading={isMetadataLoading}
                            />
                        </Animated.View>
                    )}
                    {showBanner && (
                        <HeaderProgressBar
                            stage={displayStage}
                            hydrationCompleted={hydrationCompleted}
                            hydrationTotal={hydrationTotal}
                            deviceProcessedCount={deviceProcessedCount}
                            deviceTotalCount={deviceTotalCount}
                            meraProtocolEnabled={isOnDeviceProcessing}
                            injectNoiseEnabled={injectNoiseEnabled}
                        />
                    )}
                </Box>
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
            <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} />

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
