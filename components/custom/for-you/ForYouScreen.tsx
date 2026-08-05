import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedSyncIndicator, {
    useFeedSyncRefresh,
    useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import FeedSyncLastUpdateText from '@/components/custom/FeedSyncLastUpdateText';
import {
    GLASS_AVAILABLE,
    GLASS_HEADER_SCRIM,
    GLASS_HEADER_TINT,
    GlassPlate,
} from '@/components/custom/GlassSurface';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import ImportanceFilterDropdown from '@/components/custom/ImportanceFilterDropdown';
import { useImportanceFilterStore } from '@/lib/stores/importance-filter-store';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import FeedStatusSheet from '@/components/custom/for-you/FeedStatusSheet';
import DashboardSectionsFeed from '@/components/custom/for-you/DashboardSectionsFeed';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import StatusBarScrim from '@/components/custom/StatusBarScrim';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { loadSectionSnapshots, type SectionSnapshots } from '@/lib/stores/section-snapshots';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
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
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useInjectNoise } from '@/lib/stores/mera-protocol-store';
import {
    useForYouAsyncJobPhase,
    useForYouHasGeneratedTopics,
    useForYouLastProcessingRunFinishedAt,
    useForYouNoisyDiscardedCount,
    useForYouSuggestions,
    useForYouSyncStatusMessage,
    useForYouScoringError,
    useForYouDailyLimitResetAt,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import { EDGE_SWIPE_HITBOX_WIDTH } from '@/lib/navigation/edge-swipe';
import {
    DASHBOARD_RESORT_INTERVAL_MS,
    msUntilResortDue,
    shouldResort,
    type ResortTrigger,
} from '@/lib/feed-ordering/dashboard-resort';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, StyleSheet, View } from 'react-native';
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
    const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal, resetScrollOrigin } =
        useCollapsibleHeader();
    // Live opened set — subscribed so the per-card read treatment updates as
    // stories are opened. (There is no green tick; `read` only suppresses the
    // NEW badge. Section ORDER comes from the throttled `sortSnapshot`, not from
    // this live set.)
    const openedIds = useOpenedStoriesStore((s) => s.ids);
    const { fromOnboarding } = useLocalSearchParams<{ fromOnboarding?: string }>();
    const [showOnboardingWait, setShowOnboardingWait] = useState(false);
    const [stuckOnEmpty, setStuckOnEmpty] = useState(false);
    const dbReady = useDatabaseStore((s) => s.ready);
    // Real navigator focus — used to pause the 30s timers (nowTick + empty-feed
    // watchdog) while this tab is blurred.
    const isFocused = useIsFocused();
    // ── Section-order snapshot (THROTTLED) ──
    // The Dashboard uses the Feed's priority order, but it is a browsing surface
    // the user scans repeatedly — re-sorting on every focus or store tick would
    // reshuffle sections under their eyes. So ORDER reads a frozen snapshot of
    // the viewed-state, replaced at most once per DASHBOARD_RESORT_INTERVAL_MS.
    //
    // NEW ARRIVALS ARE NOT THROTTLED, and the separation is clean rather than
    // approximate: the sort key is (viewed, relevance band, incoming index).
    // Freezing only the VIEWED lookup leaves relevance and arrival order live,
    // so a newly-synced story still slots into its band immediately while every
    // already-present story keeps its relative position. The throttle governs
    // re-RANKING, not arrival.
    //
    // `openedIds` here mirrors the live opened-stories store's full `ids` set
    // (article_id ∪ stable_cluster_id) — NOT just `openedArticleIds` (article-id
    // only, kept alongside for other consumers of this snapshot). buildFactRows'
    // unread-count/section-order sort key is `isSuggestionOpened`, which matches
    // on EITHER key (fact-rows-selector.ts:697-699); snapshotting only the
    // article-id subset would silently degrade that match for an ongoing story
    // whose representative article changes id between resorts, so the full set
    // is carried across intact rather than narrowed.
    const [sortSnapshot, setSortSnapshot] = useState<{
        cardStates: Record<string, unknown>;
        openedArticleIds: Set<string>;
        openedIds: Set<string>;
    }>(() => ({ cardStates: {}, openedArticleIds: new Set(), openedIds: new Set() }));
    const lastResortAtRef = useRef<number | null>(null);

    const applyResort = useCallback((trigger: ResortTrigger) => {
        const nowMs = Date.now();
        if (!shouldResort({ lastAppliedMs: lastResortAtRef.current, nowMs, trigger })) return;
        lastResortAtRef.current = nowMs;
        setSortSnapshot({
            cardStates: useFeedOrderStore.getState().cardStates,
            openedArticleIds: useOpenedStoriesStore.getState().articleIds,
            openedIds: useOpenedStoriesStore.getState().ids,
        });
    }, []);

    // Seed once both stores have hydrated (an empty snapshot would rank every
    // already-read story as unviewed for the whole first session).
    const openedHydrated = useOpenedStoriesStore((s) => s.hydrated);
    useEffect(() => {
        if (!openedHydrated || lastResortAtRef.current !== null) return;
        applyResort('unwatched');
    }, [openedHydrated, applyResort]);

    // PREFERRED moment: the user stopped looking (tab blur or app background).
    useEffect(() => {
        if (isFocused) return;
        applyResort('unwatched');
    }, [isFocused, applyResort]);

    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next !== 'background') return;
            applyResort('unwatched');
        });
        return () => sub.remove();
    }, [applyResort]);

    // FALLBACK: a user who never looks away still gets a converging order. One
    // timer armed at the exact mark — not a poll — re-armed whenever the
    // snapshot changes.
    useEffect(() => {
        if (!isFocused) return;
        const delay = msUntilResortDue(lastResortAtRef.current, Date.now());
        const timer = setTimeout(() => applyResort('elapsed'), delay || DASHBOARD_RESORT_INTERVAL_MS);
        return () => clearTimeout(timer);
    }, [isFocused, sortSnapshot, applyResort]);

    const edgeSwipeGesture = useMemo(() => Gesture.Pan()
        .activeOffsetX(-20)
        .failOffsetX(20)
        .failOffsetY([-20, 20])
        .onEnd((event) => {
            if (event.translationX < -50) {
                runOnJS(openConfigPanel)();
            }
        }), []);

    // Sub-tab state — Feed / Stories / Saved / History. All four are kept
    // mounted after their first visit (display-toggled) so scroll state
    // survives a switch.
    const [activeSubTab, setActiveSubTab] = useState<ForYouSubTab>('feed');
    // Display-only importance filter (header pills). Default 'low' shows
    // everything — see lib/stores/importance-filter-store.
    const dashboardThreshold = useImportanceFilterStore((s) => s.dashboardThreshold);
    const setDashboardThreshold = useImportanceFilterStore((s) => s.setDashboardThreshold);
    const [storiesVisited, setStoriesVisited] = useState(false);
    const [savedVisited, setSavedVisited] = useState(false);
    const [historyVisited, setHistoryVisited] = useState(false);
    const selectSubTab = useCallback((tab: ForYouSubTab) => {
        setActiveSubTab(tab);
        if (tab === 'stories') setStoriesVisited(true);
        if (tab === 'saved') setSavedVisited(true);
        if (tab === 'history') setHistoryVisited(true);
        // Always reveal the header on a sub-tab switch.
        reveal();
        // ...and drop the scroll baseline. All four panels stay mounted behind
        // display:'none' and keep their own offsets, but they SHARE one handler,
        // so `lastY` holds whichever panel scrolled last. Without this the first
        // scroll on the panel being switched TO reads the difference between two
        // panels as travel — a spurious hide/reveal in whichever direction the
        // offsets happen to differ. `reveal()` alone can't cover it: it clears
        // the accumulators, not `lastY`.
        resetScrollOrigin();
    }, [reveal, resetScrollOrigin]);

    // Feed-status detail sheet (opened from the header status line + shimmer).
    const [statusSheetOpen, setStatusSheetOpen] = useState(false);
    const openStatusSheet = useCallback(() => setStatusSheetOpen(true), []);

    // Pull-to-refresh — the SAME handler the Feed tab uses. `refreshing` tracks
    // the scheduler's feed-sync flag (not local state), so it rises on the same
    // frame as the pull and stays up for the real duration of the sync. This is
    // also what finally makes the "pull down to retry" copy in renderEmpty true;
    // the Dashboard list had no refresh control at all before.
    const { refreshing, onRefresh } = useFeedSyncRefresh(reveal);

    // The live store array — now rendered directly (no held-feed pill hop).
    const suggestions = useForYouSuggestions();

    const hasGeneratedInterests = useForYouHasGeneratedTopics();
    // Mera News Free: `DashboardSectionsFeed`'s list header already renders
    // `FreeTierCard`, which explains this mode. NoGeneratedInterestsCard would
    // sit right under it saying a blunter version of the same thing ("Mera
    // cannot analyze news for you"), pointing the user at building a persona
    // when a plan — not a persona — is what's missing. Same gate as FreeTierCard
    // itself (`=== 'locked'`, never `!== 'entitled'`) so that during the
    // `'unknown'` window of a cold start, where FreeTierCard renders null, this
    // card is still there.
    const freeTierCardShown = useAiAccess() === 'locked';
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
    const asyncJobPhase = useForYouAsyncJobPhase();
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
        return formatTimeAgo(t, lastProcessingRunFinishedAt, { now: nowTick });
    }, [lastProcessingRunFinishedAt, nowTick, t]);

    // Any client-visible fetch/scoring work still in flight — the shared
    // derivation (see components/custom/FeedSyncIndicator). Used here only for
    // the empty-state chain and the header auto-reveal; the header indicator
    // OR-s in the scheduler flag on its own.
    const isFeedProcessing = useIsFeedProcessing();

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

    // Hydrate the persisted section-visit map once on mount so the Dashboard's
    // "+N new" section badges are correct on first paint.
    useEffect(() => {
        void useSectionVisitsStore.getState().hydrate();
    }, []);

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

    // The user's geo/language context (home/other countries + app language) —
    // makes representative election tier-aware. Null while loading/on failure,
    // which `buildFactRows` treats as the legacy geo/language-blind pick.
    const userGeoLanguageCtx = useUserGeoLanguageContext();

    // The fact-rows selector output (breaking strip + per-fact rows). Empty until
    // the snapshots hydrate.
    //
    // Reads `sortSnapshot.openedIds` — NOT the live `openedIds` — because
    // `row.unreadCount` is section-order sort key #2 (fact-rows-selector.ts:
    // 666-673): opening an article flips the LIVE set the instant the tap
    // happens, and buildFactRows would immediately move that whole section.
    // The live `openedIds` still flows separately to `DashboardSectionsFeed`
    // below for per-card read/dim state, which must update instantly — only the
    // section-order input is frozen. Deliberately depending on `sortSnapshot`
    // itself (not `openedIds`) means this only recomputes on a resort, an
    // arrival, or a snapshot input change — never on a live open.
    const feed = useMemo(() => {
        if (!snapshots) return { breaking: [], rows: [] };
        return buildFactRows(suggestions, snapshots, sortSnapshot.openedIds, Date.now(), DEFAULT_HARNESS_CONFIG, userGeoLanguageCtx);
    }, [snapshots, suggestions, sortSnapshot, userGeoLanguageCtx]);

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
                <Box className="items-center justify-center py-20" testID="dashboard-loading">
                    <Spinner size="large" />
                </Box>
            );
        }
        if (stuckOnEmpty) {
            return (
                <Box className="items-center justify-center py-20 px-6" testID="dashboard-stuck-empty">
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
                <Box className="items-center justify-center py-20 px-6" testID="dashboard-error">
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
            return freeTierCardShown ? null : <NoGeneratedInterestsCard />;
        }
        if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
            return <FeedPreparingCard />;
        }
        return <AllCaughtUpCard />;
    }, [showOnboardingWait, isLoading, hasGeneratedInterests, freeTierCardShown, errorMessage, t, stuckOnEmpty, isFeedProcessing, lastProcessingRunFinishedAt]);

    return (
        // No `bg-black`: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1" testID="dashboard-screen">
            {/* App-wide tab background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* Keep-mounted sub-tab content — rendered FIRST so the absolute
                collapsing header paints on top of it. */}
            <View style={{ flex: 1 }}>
                {/* Feed — the list handles its own top padding (contentContainer)
                    so it can scroll under the collapsing header. */}
                <View style={{ flex: 1, display: activeSubTab === 'feed' ? 'flex' : 'none' }} testID="dashboard-feed-content">
                    <DashboardSectionsFeed
                        breaking={feed.breaking}
                        rows={feed.rows}
                        openedIds={openedIds}
                        sortSnapshot={sortSnapshot}
                        onPressSuggestion={handleSuggestionPress}
                        scrollHandler={scrollHandler}
                        headerHeight={headerHeight}
                        ListEmptyComponent={renderEmpty}
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                    />
                </View>

                {/* Stories / Saved / History — each owns its own list, so each
                    gets the SAME four legs the Feed panel above already has:
                    `scrollHandler` on an `Animated.FlatList`, `scrollEventThrottle`,
                    the header's height as the list's content `paddingTop`, and
                    `progressViewOffset` wherever a RefreshControl exists.

                    The wrapper Views used to carry `paddingTop: headerHeight`
                    instead — which is exactly why the header stayed pinned here:
                    padding a wrapper reserves the space statically, so there was
                    nothing to scroll under and hiding the header would only have
                    left a dead gap. The padding now lives inside each list's
                    contentContainer, and each panel's own title scrolls with it.

                    Child ORDER is untouched on purpose: react-native-screens finds
                    a tab's scroll view by walking subviews[0], AbstractGradientBackdrop
                    occupies that slot, and that is the measured reason these lists
                    get no automatic content inset. Threading props is safe;
                    reordering is not. */}
                {storiesVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'stories' ? 'flex' : 'none' }} testID="dashboard-stories-content">
                        <StoriesSlotPlaceholder scrollHandler={scrollHandler} headerHeight={headerHeight} />
                    </View>
                )}

                {/* Saved (lazy-mounted on first visit) */}
                {savedVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'saved' ? 'flex' : 'none' }} testID="dashboard-saved-content">
                        <SavedSuggestionsScreen embedded onBack={() => selectSubTab('feed')} scrollHandler={scrollHandler} headerHeight={headerHeight} />
                    </View>
                )}

                {/* History (lazy-mounted on first visit) */}
                {historyVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'history' ? 'flex' : 'none' }} testID="dashboard-history-content">
                        <VisitedPublicationsList embedded active={activeSubTab === 'history'} onBack={() => selectSubTab('feed')} scrollHandler={scrollHandler} headerHeight={headerHeight} />
                    </View>
                )}
            </View>

            {/* Status-bar scrim — covers the Dynamic Island/clock/battery region
                so content is never visible behind it once the collapsing
                header below translates away on scroll-down. Sits above the
                sub-tab content, below the header (zIndex 10). Shared across
                all three sub-tabs (Feed/Stories/Saved) since the header above
                it is too. */}
            <StatusBarScrim />

            {/* Collapsing Dashboard header — absolute overlay, translates up on
                scroll-down and back on scroll-up / reveal(). */}
            <Animated.View
                testID="dashboard-header"
                onLayout={onHeaderLayout}
                // box-none: the absolute header must not swallow the top-of-list
                // pull-to-refresh gesture — touches pass through its empty area
                // to the FlatList beneath, while its interactive children (bell,
                // sub-tab pills, status bar) still receive taps. Without this the
                // Dashboard's new pull-to-refresh simply never fires (the Feed
                // tab hit exactly this and carries the same note).
                pointerEvents="box-none"
                style={[
                    { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
                    // Liquid Glass on iOS 26+, flat black everywhere else. The
                    // opaque background is REMOVED (not layered under the plate)
                    // where glass paints — a solid fill over glass cancels it
                    // entirely. Where glass does not paint, `GlassPlate` renders
                    // nothing, so dropping the background too would leave an
                    // invisible header over the scrolling list; hence the
                    // explicit fallback.
                    GLASS_AVAILABLE
                        ? {
                              // Paints BEHIND the plate, so it is what the glass
                              // samples — that is what actually cuts the
                              // see-through. Translucent, NOT opaque: an opaque
                              // fill here would cancel the glass (GlassSurface).
                              backgroundColor: GLASS_HEADER_SCRIM,
                              borderBottomWidth: StyleSheet.hairlineWidth,
                              borderBottomColor: 'rgba(255,255,255,0.10)',
                          }
                        : { backgroundColor: '#000000' },
                    headerStyle,
                ]}
            >
                {/* Absolute-fill glass. This Animated.View is unpadded (all
                    padding lives on the VStack below), which is exactly what
                    GlassPlate's parent must be — see GlassSurface. No corner
                    radius here, so no `overflow: 'hidden'`: the header is
                    full-bleed and clipping would only risk cutting off the
                    bell's badge. */}
                <GlassPlate tint={GLASS_HEADER_TINT} />
                {/* PULL-TO-REFRESH PASSTHROUGH — read this before adding a row.
                    `box-none` makes a view itself untouchable but leaves its
                    CHILDREN touchable. Putting it only on this VStack (and on the
                    Animated.View above) was NOT enough: every direct child here
                    is a full-width plain View, so the title row, the stats
                    sentence, the sub-tab row and the sync indicator each formed an
                    opaque full-width band. A downward pan starting anywhere in the
                    header was consumed by whichever band it landed on and never
                    reached the FlatList underneath — which is exactly why the
                    gesture produced ZERO list displacement while a programmatic
                    scroll worked fine.
                    The Feed tab's header has two such bands and is much shorter,
                    so its pull usually starts below the header and works; this
                    header is tall enough that it almost never does.
                    RULE: every non-interactive row in this header must be
                    `pointerEvents="none"`, and every row that merely CONTAINS an
                    interactive child must be `box-none`. Only genuine controls
                    (bell, status line, sub-tab pills) may be `auto`. */}
                <VStack
                    className="px-5 pb-2"
                    pointerEvents="box-none"
                    style={{ paddingTop: insets.top + 16 }}
                >
                    <HStack className="items-start justify-between mb-2" pointerEvents="box-none">
                        <VStack className="flex-1 min-w-0 mr-3" pointerEvents="box-none">
                            {/* Same in-title dropdown as the Feed. It only
                                filters the Overview sub-tab's sections —
                                title-row placement is a deliberate user call
                                (consistency with Feed over strict scoping). */}
                            <HStack className="items-center min-w-0" space="sm" pointerEvents="box-none">
                                <View pointerEvents="none" className="flex-shrink min-w-0">
                                    <Heading
                                        size="3xl"
                                        className="text-white"
                                        numberOfLines={1}
                                    >
                                        {t('feed.dashboardTitle')}
                                    </Heading>
                                </View>
                                <ImportanceFilterDropdown
                                    value={dashboardThreshold}
                                    onChange={setDashboardThreshold}
                                    testIDPrefix="dashboard-importance"
                                />
                            </HStack>
                            {lastProcessedLabel && (
                                <Pressable
                                    onPress={openStatusSheet}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('feedStatus.openA11y')}
                                    testID="dashboard-open-status-sheet"
                                >
                                    <FeedSyncLastUpdateText lastProcessedLabel={lastProcessedLabel} />
                                </Pressable>
                            )}
                        </VStack>
                        <HStack className="items-center flex-shrink-0" space="sm" pointerEvents="box-none">
                            <NotificationBellButton />
                        </HStack>
                    </HStack>

                    {/* Stats sentence — decorative text, never tapped: fully
                        transparent to touches so a pull can start on it. */}
                    <View pointerEvents="none">
                        {/* Brighter + a little heavier than the muted body step:
                            this line sits on glass with content moving under it,
                            where typography-400 was barely legible. Only colour
                            and weight change — `leading-6 mb-2` is preserved. */}
                        <FeedStatsSentence className="text-typography-700 font-medium leading-6 mb-2" />
                    </View>

                    {/* Sub-tab pills. box-none: the ROW is a full-width band and
                        must not swallow a pull — only the pills themselves take
                        touches (ForYouSubTabs' own HStack is box-none too). */}
                    <View pointerEvents="box-none">
                        <ForYouSubTabs activeSubTab={activeSubTab} onSelect={selectSubTab} />
                    </View>

                    {/* Shared sync surface — indeterminate bar + expand accordion.
                        Identical to the Feed tab's, and it goes up on the same
                        frame as a pull on EITHER screen (see FeedSyncIndicator).
                        The offline notice moved to the global OfflineBanner at
                        the root layout, so there is no longer a per-sub-tab
                        connectivity prop to pass. */}
                    <View pointerEvents="box-none">
                        <FeedSyncIndicator lastProcessedLabel={lastProcessedLabel} />
                    </View>
                </VStack>
            </Animated.View>

            {/* Right edge swipe hitbox */}
            <GestureDetector gesture={edgeSwipeGesture}>
                <View style={styles.edgeSwipeHitbox} testID="dashboard-edge-swipe-hitbox" />
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
        // Rendered ON TOP of the sub-tab content, so every tap inside this band
        // is swallowed (the pan never activates and RN's responder system does
        // not fall through to the covered sibling). Width is shared via
        // lib/navigation/edge-swipe.ts so controls pinned near the right edge —
        // e.g. the Saved sub-tab's delete button, which this strip used to
        // render completely unpressable — can derive their clearance from it.
        width: EDGE_SWIPE_HITBOX_WIDTH,
    },
});

export default MeraNewsScreen;
