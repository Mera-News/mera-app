import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedSyncLastUpdateText from '@/components/custom/FeedSyncLastUpdateText';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import FeedStatusShimmer from '@/components/custom/for-you/FeedStatusShimmer';
import FeedStatusSheet from '@/components/custom/for-you/FeedStatusSheet';
import FactSectionsFeed from '@/components/custom/for-you/FactSectionsFeed';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
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
import logger from '@/lib/logger';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useInjectNoise } from '@/lib/stores/mera-protocol-store';
import {
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
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Profile is now a bottom tab — the right-edge swipe still opens it directly.
const openConfigPanel = () => router.push('/logged-in/app_container/profile');

const MeraNewsScreen: React.FC = () => {
    const { t } = useTranslation();
    // Local UI state only
    // Shared initial-load bootstrap (persona fetch + opened-set hydration) and
    // the shared open-suggestion handler — both extracted so the Feed tab reuses
    // them (see lib/hooks/*).
    const { isLoading, errorMessage } = useFeedBootstrap();
    const handleSuggestionPress = useOpenSuggestion('sectioned');
    // Collapsing Dashboard header (hides on scroll-down, reveals on scroll-up).
    const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal } =
        useCollapsibleHeader();
    // Live opened set — subscribed so the section resort + green ticks update as
    // stories are opened.
    const openedIds = useOpenedStoriesStore((s) => s.ids);
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
        // Always reveal the header on a sub-tab switch.
        reveal();
    }, [reveal]);

    // Feed-status detail sheet (opened from the header status line + shimmer).
    const [statusSheetOpen, setStatusSheetOpen] = useState(false);
    const openStatusSheet = useCallback(() => setStatusSheetOpen(true), []);

    // The live store array — now rendered directly (no held-feed pill hop).
    const suggestions = useForYouSuggestions();

    const hasGeneratedInterests = useForYouHasGeneratedTopics();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
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

    const { data: session } = authClient.useSession();
    const isConnected = useIsConnected();
    const insets = useSafeAreaInsets();

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
        return buildFactRows(suggestions, snapshots, openedIds);
    }, [snapshots, suggestions, openedIds]);

    const hasRenderableContent = feed.rows.length > 0 || feed.breaking.length > 0;

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
                },
            });
            setStuckOnEmpty(true);
        }, 30_000);

        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFocused, session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, hasRenderableContent, asyncJobPhase, unscoredCount, syncStatusMessage?.errorCode, isDailyLimited]);

    // Auto-reveal the header on error / offline / daily-limit conditions so the
    // status chrome (shimmer, offline row) is never hidden under a collapsed
    // header when the user most needs it.
    useEffect(() => {
        if (!isConnected || scoringError !== null || isDailyLimited) {
            reveal();
        }
    }, [isConnected, scoringError, isDailyLimited, reveal]);

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
            {/* Keep-mounted sub-tab content — rendered FIRST so the absolute
                collapsing header paints on top of it. */}
            <View style={{ flex: 1 }}>
                {/* Feed — the list handles its own top padding (contentContainer)
                    so it can scroll under the collapsing header. */}
                <View style={{ flex: 1, display: activeSubTab === 'feed' ? 'flex' : 'none' }}>
                    <FactSectionsFeed
                        breaking={feed.breaking}
                        rows={feed.rows}
                        openedIds={openedIds}
                        onPressSuggestion={handleSuggestionPress}
                        scrollHandler={scrollHandler}
                        headerHeight={headerHeight}
                        ListEmptyComponent={renderEmpty}
                    />
                </View>

                {/* Stories (lazy-mounted on first visit) — header stays revealed,
                    so pad the content below its measured height. */}
                {storiesVisited && (
                    <View style={{ flex: 1, paddingTop: headerHeight, display: activeSubTab === 'stories' ? 'flex' : 'none' }}>
                        <StoriesSlotPlaceholder />
                    </View>
                )}

                {/* Saved (lazy-mounted on first visit) */}
                {savedVisited && (
                    <View style={{ flex: 1, paddingTop: headerHeight, display: activeSubTab === 'saved' ? 'flex' : 'none' }}>
                        <SavedSuggestionsScreen embedded onBack={() => selectSubTab('feed')} />
                    </View>
                )}
            </View>

            {/* Collapsing Dashboard header — absolute overlay, translates up on
                scroll-down and back on scroll-up / reveal(). */}
            <Animated.View
                onLayout={onHeaderLayout}
                style={[
                    { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: '#000000' },
                    headerStyle,
                ]}
            >
                <VStack className="px-5 pb-2" style={{ paddingTop: insets.top + 16 }}>
                    <HStack className="items-start justify-between mb-2">
                        <VStack className="flex-1 min-w-0 mr-3">
                            <Heading size="3xl" className="text-white" numberOfLines={1}>{t('feed.dashboardTitle')}</Heading>
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

                    {/* Stats sentence — always visible in the Dashboard header. */}
                    <FeedStatsSentence className="text-typography-400 leading-6 mb-2" />

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
            </Animated.View>

            {/* Right edge swipe hitbox */}
            <GestureDetector gesture={edgeSwipeGesture}>
                <View style={styles.edgeSwipeHitbox} />
            </GestureDetector>

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
