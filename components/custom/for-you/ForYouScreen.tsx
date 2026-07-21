import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedSyncLastUpdateText from '@/components/custom/FeedSyncLastUpdateText';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import FeedStatusShimmer from '@/components/custom/for-you/FeedStatusShimmer';
import FeedStatusSheet from '@/components/custom/for-you/FeedStatusSheet';
import FactRowsFeed from '@/components/custom/for-you/FactRowsFeed';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { loadSectionSnapshots, type SectionSnapshots } from '@/lib/stores/section-snapshots';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { getFacts } from '@/lib/database/services/fact-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import logger from '@/lib/logger';
import { ForYouSuggestion, useForYouStore } from '@/lib/stores/for-you-store';
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
    useForYouSuggestions,
    useForYouSyncStatusMessage,
    useForYouScoringError,
    useForYouDailyLimitResetAt,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import { useUserStore } from '@/lib/stores/user-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Profile is now a bottom tab — the right-edge swipe still opens it directly.
const openConfigPanel = () => router.push('/logged-in/app_container/profile');

const MeraNewsScreen: React.FC = () => {
    const { t } = useTranslation();
    // Local UI state only
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const { fromOnboarding } = useLocalSearchParams<{ fromOnboarding?: string }>();
    const [showOnboardingWait, setShowOnboardingWait] = useState(false);
    const [stuckOnEmpty, setStuckOnEmpty] = useState(false);
    const dbReady = useDatabaseStore((s) => s.ready);
    // Real navigator focus — used to pause the 30s timers (nowTick + empty-feed
    // watchdog) while this tab is blurred.
    const isFocused = useIsFocused();
    const edgeSwipeGesture = useMemo(() => Gesture.Pan()
        .activeOffsetX(-20)
        .failOffsetX(20)
        .failOffsetY([-20, 20])
        .onEnd((event) => {
            if (event.translationX < -50) {
                runOnJS(openConfigPanel)();
            }
        }), []);

    // Sub-tab state — Feed / Stories / Saved. All three are kept mounted after
    // their first visit (display-toggled) so scroll state survives a switch.
    const [activeSubTab, setActiveSubTab] = useState<ForYouSubTab>('feed');
    const [storiesVisited, setStoriesVisited] = useState(false);
    const [savedVisited, setSavedVisited] = useState(false);
    const selectSubTab = useCallback((tab: ForYouSubTab) => {
        setActiveSubTab(tab);
        if (tab === 'stories') setStoriesVisited(true);
        if (tab === 'saved') setSavedVisited(true);
    }, []);

    // Feed-status detail sheet (opened from the header status line + shimmer).
    const [statusSheetOpen, setStatusSheetOpen] = useState(false);
    const openStatusSheet = useCallback(() => setStatusSheetOpen(true), []);

    // The live store array — now rendered directly (no held-feed pill hop).
    const suggestions = useForYouSuggestions();

    // Hydrate the opened-story set once on mount; refresh on refocus so opens
    // recorded on other surfaces dim here too.
    useEffect(() => {
        void useOpenedStoriesStore.getState().hydrate();
    }, []);
    useEffect(() => {
        if (isFocused) void useOpenedStoriesStore.getState().hydrate();
    }, [isFocused]);

    const hasGeneratedInterests = useForYouHasGeneratedTopics();
    const { articleCount } = useForYouCounts();
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
        // Pause the ticking clock while blurred; re-arm + snap forward on focus.
        if (!isFocused) return;
        if (!lastProcessingRunFinishedAt && !dailyLimitResetAt) return;
        setNowTick(Date.now());
        const id = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [isFocused, lastProcessingRunFinishedAt, dailyLimitResetAt]);

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

    // Any client-visible fetch/scoring work still in flight. Round-4 B: dropped
    // the `unscoredCount > 0` term — deliberately-deferred rows (a sub-25 quantum
    // waiting for the next batch) are NOT "processing", so the shimmer no longer
    // spins forever while they wait. The deferred rows surface as a static note
    // via FeedStatusShimmer's `unscoredCount` prop instead.
    const isFeedProcessing =
        isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing;

    // The user is over their daily delivery cap (sticky until a sync delivers
    // again or the reset time passes).
    const isDailyLimited =
        dailyLimitResetAt != null && nowTick < dailyLimitResetAt;

    // Header counts reflect everything scored this cycle (live store).
    const { analysedCount, relevantCount } = useMemo(() => {
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        let analysed = 0;
        let relevant = 0;
        for (const s of suggestions) {
            if (s.status === ArticleSuggestionStatus.Unscored) continue;
            const pt = Date.parse(s.firstPubDate);
            if (!Number.isFinite(pt) || pt < cutoffMs) continue;
            analysed++;
            if (s.relevance > 0.3) relevant++;
        }
        return { analysedCount: analysed, relevantCount: relevant };
    }, [suggestions]);

    const { setHasGeneratedTopics } = getForYouActions();
    const { fetchUserPersona } = useUserStore();
    const { data: session } = authClient.useSession();
    const isConnected = useIsConnected();
    const insets = useSafeAreaInsets();
    const loadingRef = useRef(false);

    // ── Fact-rows feed (Round-3 C1/C2) ──
    // Persona snapshots (topics/facts/locations). Null while loading.
    const [snapshots, setSnapshots] = useState<SectionSnapshots | null>(null);

    // Load the persona snapshots when interests exist or the feed size changes
    // (tiny tables; a new sync's insert/remove is the coarse trigger).
    useEffect(() => {
        let cancelled = false;
        loadSectionSnapshots()
            .then((s) => { if (!cancelled) setSnapshots(s); })
            .catch((err: unknown) => {
                logger.captureException(err, {
                    tags: { screen: 'ForYouScreen', method: 'loadSectionSnapshots' },
                });
            });
        return () => { cancelled = true; };
    }, [hasGeneratedInterests, suggestions.length]);

    // The fact-rows selector output (breaking strip + per-fact rows). Empty until
    // the snapshots hydrate.
    const feed = useMemo(() => {
        if (!snapshots) return { breaking: [], rows: [] };
        return buildFactRows(suggestions, snapshots);
    }, [snapshots, suggestions]);

    const hasRenderableContent = feed.rows.length > 0 || feed.breaking.length > 0;

    // Initial load — fetch if store is empty (first visit or after logout).
    useEffect(() => {
        const storeState = useForYouStore.getState();
        if (!session?.user?.id) return;
        if (storeState.suggestions.length === 0) {
            loadArticles();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.user?.id]);

    // First arrival from onboarding: show waiting card if user has any facts.
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

    const loadArticles = async () => {
        if (!session?.user?.id) return;
        if (loadingRef.current) return;
        loadingRef.current = true;

        try {
            setErrorMessage(null);
            setIsLoading(true);

            const persona = await fetchUserPersona(session.user.id);
            const fetchedUserPersonaId = persona?._id;
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
            const isNetworkError = error?.networkError || error?.message?.includes('Network request failed');
            setErrorMessage(isNetworkError ? t('errors.networkError') : t('errors.feedError'));
        } finally {
            setIsLoading(false);
            loadingRef.current = false;
        }
    };

    // Hide the onboarding waiting card once the first card is ready.
    useEffect(() => {
        if (showOnboardingWait && hasRenderableContent) {
            setShowOnboardingWait(false);
        }
    }, [showOnboardingWait, hasRenderableContent]);

    // Clear the watchdog error when a new sync cycle / cloud scoring starts.
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

    // Empty-feed watchdog — the "feed empty" predicate now reads the fact-rows
    // selector output (hasRenderableContent). See the original rationale: 30s with
    // no renderable content while signed-in + hydrated + interests generated + no
    // error + no productive work in flight ⇒ something silently failed.
    useEffect(() => {
        if (hasRenderableContent) {
            if (stuckOnEmpty) setStuckOnEmpty(false);
            return;
        }
        const shouldArm =
            isFocused &&
            !!session?.user?.id &&
            dbReady &&
            hasGeneratedInterests &&
            !errorMessage &&
            syncStatusMessage?.errorCode !== 'no-topics-configured' &&
            !isDailyLimited &&
            asyncJobPhase === 'idle' &&
            unscoredCount === 0;
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFocused, session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, hasRenderableContent, asyncJobPhase, unscoredCount, syncStatusMessage?.errorCode, isDailyLimited]);

    const handleSuggestionPress = useCallback((suggestion: ForYouSuggestion) => {
        // Optimistically dim the row immediately.
        useOpenedStoriesStore.getState().markOpened(
            suggestion.articleId,
            suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null,
        );
        void recordOpen({
            articleId: suggestion.articleId,
            suggestionId: suggestion._id,
            stableClusterId:
                suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null,
            titleNorm:
                (suggestion.title_en ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null,
            surface: 'sectioned',
        });
        const userPersonaId = useUserStore.getState().userPersona?._id || '';
        router.push({
            pathname: '/logged-in/suggestion-detail',
            params: {
                articleSuggestionId: suggestion._id,
                userId: session?.user?.id || '',
                userPersonaId,
            },
        });
    }, [session?.user?.id]);

    const renderEmpty = useCallback(() => {
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
        if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
            return <FeedPreparingCard />;
        }
        return <AllCaughtUpCard />;
    }, [showOnboardingWait, isLoading, hasGeneratedInterests, errorMessage, t, stuckOnEmpty, isFeedProcessing, lastProcessingRunFinishedAt]);

    return (
        <Box className="flex-1 bg-black">
            <VStack className="px-5 pb-2 border-gray-800 z-10" style={{ paddingTop: insets.top + 16 }}>
                <HStack className="items-start justify-between mb-2">
                    <VStack className="flex-1 min-w-0 mr-3">
                        <Heading size="3xl" className="text-white" numberOfLines={1}>{t('feed.forYou')}</Heading>
                        {lastProcessedLabel && (
                            <Pressable
                                onPress={openStatusSheet}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('feedStatus.openA11y')}
                            >
                                <FeedSyncLastUpdateText lastProcessedLabel={lastProcessedLabel} />
                            </Pressable>
                        )}
                    </VStack>
                    <HStack className="items-center flex-shrink-0" space="sm">
                        <NotificationBellButton />
                    </HStack>
                </HStack>

                {/* Sub-tab pills — Feed / Stories / Saved. */}
                <ForYouSubTabs activeSubTab={activeSubTab} onSelect={selectSubTab} />

                {/* Feed-status shimmer — indeterminate bar + expand accordion. */}
                <FeedStatusShimmer
                    processing={isFeedProcessing}
                    error={scoringError !== null}
                    dailyLimited={isDailyLimited}
                    unscoredCount={unscoredCount}
                    processedCount={articleCount}
                    analysedCount={analysedCount}
                    relevantCount={relevantCount}
                    noiseRemovedCount={noisyDiscardedCount ?? 0}
                    injectNoiseEnabled={injectNoiseEnabled}
                    lastProcessedLabel={lastProcessedLabel}
                />

                {activeSubTab === 'feed' && !isConnected && (
                    <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mt-2" space="sm">
                        <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                        <Text size="sm" className="text-warning-400">{t('feed.offlineCached')}</Text>
                    </HStack>
                )}
            </VStack>

            {/* Keep-mounted sub-tab content. */}
            <View style={{ flex: 1 }}>
                {/* Feed */}
                <View style={{ flex: 1, display: activeSubTab === 'feed' ? 'flex' : 'none' }}>
                    <FactRowsFeed
                        breaking={feed.breaking}
                        rows={feed.rows}
                        onPressSuggestion={handleSuggestionPress}
                        ListEmptyComponent={renderEmpty}
                    />
                </View>

                {/* Stories (lazy-mounted on first visit) */}
                {storiesVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'stories' ? 'flex' : 'none' }}>
                        <StoriesSlotPlaceholder />
                    </View>
                )}

                {/* Saved (lazy-mounted on first visit) */}
                {savedVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'saved' ? 'flex' : 'none' }}>
                        <SavedSuggestionsScreen embedded onBack={() => selectSubTab('feed')} />
                    </View>
                )}
            </View>

            {/* Right edge swipe hitbox */}
            <GestureDetector gesture={edgeSwipeGesture}>
                <View style={styles.edgeSwipeHitbox} />
            </GestureDetector>

            {/* One-time "What's new" sheet. */}
            <WhatsNewSheet />

            {/* Feed-status detail sheet. */}
            <FeedStatusSheet
                isOpen={statusSheetOpen}
                onClose={() => setStatusSheetOpen(false)}
                processedCount={articleCount}
                analysedCount={analysedCount}
                relevantCount={relevantCount}
                noiseRemovedCount={noisyDiscardedCount ?? 0}
                injectNoiseEnabled={injectNoiseEnabled}
                lastProcessedLabel={lastProcessedLabel}
            />
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
