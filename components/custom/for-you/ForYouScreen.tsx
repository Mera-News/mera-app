import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import {
    useFeedSyncRefresh,
    useIsFeedProcessing,
    useIsFeedWorkingLocally,
} from '@/components/custom/FeedSyncIndicator';
import FeedStatusMark from '@/components/custom/feed/FeedStatusMark';
import { feedMarkMode } from '@/components/custom/feed/FeedHeaderTitleRow';
import { HEADER_ACTIONS_GAP } from '@/components/custom/for-you/HeaderIconButton';
import {
    headerTitleLineHeight,
    headerTitleSize,
    HEADER_TITLE_MIN_SCALE,
} from '@/lib/typography/header-title-size';
import HeaderWorkingGradient from '@/components/custom/HeaderWorkingGradient';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import {
    GLASS_HEADER_SCRIM,
    GLASS_HEADER_TINT,
    GlassHeaderAndroidBackdrop,
    GlassPlate,
} from '@/components/custom/GlassSurface';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import DashboardEmptyState from '@/components/custom/for-you/DashboardEmptyState';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import { StatusDropdownLayer, StatusDropdownProvider } from '@/components/custom/for-you/status-dropdown';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import DashboardSectionsFeed from '@/components/custom/for-you/DashboardSectionsFeed';
import FactChecksPanel from '@/components/custom/fact-checks/FactChecksPanel';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import ShareStatsFab from '@/components/custom/ShareStatsFab';
import StatusBarScrim from '@/components/custom/StatusBarScrim';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { useSectionSnapshots } from '@/components/custom/for-you/use-section-snapshots';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import {
    useForYouAsyncJobPhase,
    useForYouHasGeneratedTopics,
    useForYouLastProcessingRunFinishedAt,
    useForYouSuggestions,
    useForYouSyncStatusMessage,
    useForYouScoringError,
    useForYouDailyLimitResetAt,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import {
    DASHBOARD_RESORT_INTERVAL_MS,
    msUntilResortDue,
    shouldResort,
    type ResortTrigger,
} from '@/lib/feed-ordering/dashboard-resort';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, AppState, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Profile is a bottom tab and is reached by tapping it. The right-edge swipe
// that also opened it is GONE, and with it the 20pt hitbox strip that used to
// be drawn over the top of every sub-tab's content. `openConfigPanel` went with
// the gesture: the strip was its only caller.



/** The header's horizontal padding, which the pill row bleeds past. One
 *  constant for both so they cannot drift apart. */
const HEADER_SIDE_PADDING = 20;

const MeraNewsScreen: React.FC = () => {
    const { t } = useTranslation();
    // Local UI state only
    // Shared initial-load bootstrap (persona fetch + opened-set hydration) and
    // the shared open-suggestion handler — both extracted so the Feed tab reuses
    // them (see lib/hooks/*).
    const { isLoading, errorMessage } = useFeedBootstrap();
    const handleSuggestionPress = useOpenSuggestion('sectioned');
    // Collapsing Dashboard header (hides on scroll-down, reveals on scroll-up).
    const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal, resetScrollOrigin, hidden } =
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

    // Sub-tab state — Feed / Stories / Saved / History. All four are kept
    // mounted after their first visit (display-toggled) so scroll state
    // survives a switch.
    const [activeSubTab, setActiveSubTab] = useState<ForYouSubTab>('feed');
    const [storiesVisited, setStoriesVisited] = useState(false);
    const [savedVisited, setSavedVisited] = useState(false);
    const [historyVisited, setHistoryVisited] = useState(false);
    const [factChecksVisited, setFactChecksVisited] = useState(false);
    // Rows on the Visited list, reported by the list after each load. The share
    // FAB means nothing over an empty list (the share screen would show its own
    // empty state), so it is hidden until there is something to share.
    const [visitedCount, setVisitedCount] = useState(0);
    const selectSubTab = useCallback((tab: ForYouSubTab) => {
        setActiveSubTab(tab);
        if (tab === 'stories') setStoriesVisited(true);
        if (tab === 'saved') setSavedVisited(true);
        if (tab === 'history') setHistoryVisited(true);
        if (tab === 'factChecks') setFactChecksVisited(true);
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


    // Pull-to-refresh — the SAME handler the Feed tab uses. `refreshing` tracks
    // the scheduler's feed-sync flag (not local state), so it rises on the same
    // frame as the pull and stays up for the real duration of the sync. This is
    // also what finally makes the "pull down to retry" copy in the empty state true;
    // the Dashboard list had no refresh control at all before.
    const { refreshing, onRefresh } = useFeedSyncRefresh(reveal);

    // The live store array — now rendered directly (no held-feed pill hop).
    const suggestions = useForYouSuggestions();

    const hasGeneratedInterests = useForYouHasGeneratedTopics();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const unscoredCount = useForYouUnscoredCount();
    const syncStatusMessage = useForYouSyncStatusMessage();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
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



    // Any client-visible fetch/scoring work still in flight — the shared
    // derivation (see components/custom/FeedSyncIndicator). Used here only for
    // the empty-state chain and the header auto-reveal; the header indicator
    // OR-s in the scheduler flag on its own.
    const isFeedProcessing = useIsFeedProcessing();

    // Title ceiling from the window width; see header-title-size for why this
    // is two steps and not a ramp.
    const { width: windowWidth } = useWindowDimensions();
    const titleSize = headerTitleSize(windowWidth);
    // Pinned, in BOTH states — see `headerTitleLineHeight`. The Dashboard pays
    // for this twice over: `headerHeight` is handed to all four sub-tab panels.
    const titleRowHeight = headerTitleLineHeight(windowWidth);

    // Still read here for the empty state. The header carries no status mark
    // any more: the status panel opens from the Overview stats card.
    const statusMode = useFeedStatusMode();
    // The Mera mark left of the bell (owner), under the Feed's exact rules: it
    // grows and animates only while the PHONE works, never on a server wait.
    const markMode = feedMarkMode(useIsFeedWorkingLocally(), statusMode);
    // The header's first row: the status dropdown drops under it, at its width.
    const titleRowRef = useRef<View>(null);

    // ONE value drives the hidden title, the narration line and the strip, so
    // the three cannot disagree about whether a run is happening.
    //
    // `isFeedProcessing`, NEVER `statusMode === 'processing'`. That is
    // `schedulerRunning || isFeedProcessing`, and `feed-sync` is registered at
    // `frequency: 5 * 60 * 1000` plus app-foreground and network-reconnect
    // triggers, so the scheduler flag goes true roughly twelve times an hour
    // while someone reads — usually to announce a poll that found nothing.
    // Handing the header over for that is a strictly worse version of the
    // billboard `7e96aa4` deleted. `FeedSyncMachine` does not publish
    // `fetching-topic-ids` or `diffing` at all ("a bare poll that finds no new
    // articles must be silent"), so `isFeedProcessing` is true exactly when
    // articles are really being downloaded, grouped and scored.
    const narrating = isFeedProcessing;

    // The narration stops cycling when the sync ends (the line unmounts) and
    // the end is announced ONCE to a screen reader. With no status line, the
    // mark is the only visual signal, so this announcement is what tells a
    // VoiceOver reader the sync has finished.
    const wasNarrating = useRef(narrating);
    useEffect(() => {
        if (wasNarrating.current && !narrating && isFocused) {
            AccessibilityInfo.announceForAccessibility(t('feedStatus.syncDoneA11y'));
        }
        wasNarrating.current = narrating;
    }, [narrating, isFocused, t]);

    // The user is over their daily delivery cap (sticky until a sync delivers
    // again or the reset time passes).
    const isDailyLimited =
        dailyLimitResetAt != null && nowTick < dailyLimitResetAt;

    const { data: session } = authClient.useSession();
    const isConnected = useIsConnected();
    const insets = useSafeAreaInsets();

    // Hydrate the persisted section-visit map once on mount so the Dashboard's
    // "+N new" section badges are correct on first paint.
    useEffect(() => {
        void useSectionVisitsStore.getState().hydrate();
    }, []);


    // Persona snapshots, reloaded on a facts or locations change, on focus, and
    // on the two coarse triggers this screen always had (see the hook).
    const snapshots = useSectionSnapshots('ForYouScreen', [hasGeneratedInterests, suggestions.length]);

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
        return buildFactRows(
            suggestions,
            snapshots,
            sortSnapshot.openedIds,
            Date.now(),
            DEFAULT_HARNESS_CONFIG,
            userGeoLanguageCtx,
            // Decides an empty section's reason: not looked yet, or looked and
            // found nothing close enough (D4).
            lastProcessingRunFinishedAt,
        );
    }, [snapshots, suggestions, sortSnapshot, userGeoLanguageCtx, lastProcessingRunFinishedAt]);

    // "Something to show" means a STORY. Empty interest sections (D4) are rows
    // too, and counting them would retire the processing card and the empty-
    // feed watchdog the moment a reader has any interest at all.
    const hasRenderableContent =
        feed.breaking.length > 0 || feed.rows.some((r) => r.groups.length > 0);

    // DEV-only twin of FeedScreen's paint mark. `hasRenderableContent` is the
    // Dashboard's OWN "there is something to show" predicate (it already gates
    // the waiting card and the empty-feed watchdog), which is what makes the two
    // timestamps directly comparable.
    useEffect(() => {
        if (hasRenderableContent) {
            coldstartTimeline.mark(
                'dashboard-first-paint',
                `rows=${feed.rows.length} breaking=${feed.breaking.length}`,
            );
        }
    }, [hasRenderableContent, feed.rows.length, feed.breaking.length]);

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
            // Once a processing run has demonstrably finished, an empty feed is a
            // legitimate empty state, not a silent failure — the window simply
            // held nothing. Arming here would show "Couldn't load your feed /
            // Something went wrong on our end" over a working app, and it sits
            // ABOVE the caught-up branch below, so it would win. The watchdog
            // keeps its real job: a device that never gets a run off the ground.
            lastProcessingRunFinishedAt === null &&
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
    }, [isFocused, session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, hasRenderableContent, asyncJobPhase, unscoredCount, syncStatusMessage?.errorCode, isDailyLimited, lastProcessingRunFinishedAt]);

    // Auto-reveal the header on error / offline / daily-limit conditions so the
    // status chrome (shimmer, offline row) is never hidden under a collapsed
    // header when the user most needs it.
    useEffect(() => {
        if (!isConnected || scoringError !== null || isDailyLimited) {
            reveal();
        }
    }, [isConnected, scoringError, isDailyLimited, reveal]);

    // An ELEMENT, not a component type: see DashboardEmptyState (S11).
    const emptyState = (
        <DashboardEmptyState
            showOnboardingWait={showOnboardingWait}
            isLoading={isLoading}
            stuckOnEmpty={stuckOnEmpty}
            errorMessage={errorMessage}
            hasGeneratedInterests={hasGeneratedInterests}
            statusMode={statusMode}
            isFeedProcessing={isFeedProcessing}
            lastProcessingRunFinishedAt={lastProcessingRunFinishedAt}
        />
    );

    // ── Header rows ─────────────────────────────────────────────────────────
    //
    // `|Dashboard (?)            mark bell|` over the pill row, and NOTHING that
    // depends on the selected pill (owner: "the header will stay the same even
    // when the user taps on some other pill"), so its height is identical on
    // every pill. No stats sentence and no inline status panel: the count
    // sentence lives in the Overview stats card, and the panel is the shared
    // dropdown that card and the Mera mark both open. The mark follows the
    // Feed's rules (still at rest, animating only while the phone works); the
    // end of a sync is announced once to a screen reader.
    return (
        // No `bg-black`: the AbstractGradientBackdrop below is the page background.
        // The provider holds the Overview stats card's dropdown state; the
        // card (deep in the list) opens it, the layer (last child) draws it.
        <StatusDropdownProvider>
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
                        ListEmptyComponent={emptyState}
                        noStoriesLead={emptyState}
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
                        {/* Share control for the History tab.
                            It lives HERE rather than in VisitedPublicationsList
                            because that component suppresses its DrillDownHeader
                            when embedded, on the stated grounds that the host
                            owns the top chrome. This IS the host, so honouring
                            that division is what puts the button here rather
                            than un-suppressing a header the Dashboard already
                            replaced. The affordance is the same one that file
                            uses when standalone — ios-share, the shareStats
                            entry label — but under its own testID, because a
                            shared id returns the FIRST match and would let an
                            assertion pass against the wrong instance. */}
                        <VisitedPublicationsList embedded active={activeSubTab === 'history'} onBack={() => selectSubTab('feed')} scrollHandler={scrollHandler} headerHeight={headerHeight} onCountChange={setVisitedCount} />
                        {/* A FAB, floating over the list, NOT a row above it.
                            The row version wrapped itself in `paddingTop:
                            headerHeight` so it would clear the collapsing
                            header, and the list below it pads by `headerHeight`
                            too. Two offsets for one header left a screen-tall
                            gap between the sub-tabs and the first row. Floating
                            it removes the wrapper, so the list keeps the only
                            header padding there is.

                            Same geometry as ScrollToTopFab (right: 20, bottom:
                            20 + inset + tab bar) so the two read as one family
                            and land in the same place. They never co-occur:
                            that one is mounted by FactFeedScreen, which is the
                            Fact checks sub-tab, not this one. */}
                        {visitedCount > 0 && (
                            <ShareStatsFab onPress={() => router.push('/logged-in/share-stats')} />
                        )}
                    </View>
                )}

                {/* Fact checks (lazy-mounted on first visit) — the ONLY surface
                    for the feature. `active` drives its bounded re-read: the
                    panel stays mounted behind display:'none' once visited, so a
                    mount-only read would go stale after the first visit. */}
                {factChecksVisited && (
                    <View style={{ flex: 1, display: activeSubTab === 'factChecks' ? 'flex' : 'none' }} testID="dashboard-fact-checks-content">
                        <FactChecksPanel active={activeSubTab === 'factChecks'} scrollHandler={scrollHandler} headerHeight={headerHeight} />
                    </View>
                )}

            </View>

            {/* Status-bar scrim — covers the Dynamic Island/clock/battery region
                so content is never visible behind it once the collapsing
                header below translates away on scroll-down. Sits above the
                sub-tab content, below the header (zIndex 10). Shared across
                all three sub-tabs (Feed/Stories/Saved) since the header above
                it is too. */}
            {/* The dark base under the clock follows the header's own hidden
                value: there only while the header is out of the way (F21). */}
            <StatusBarScrim coverProgress={hidden} />

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
                    // Paints BEHIND the plate, so on iOS 26 it is what the glass
                    // samples — that is what actually cuts the see-through.
                    // Translucent, NOT opaque: an opaque fill here would cancel
                    // the glass (GlassSurface). No flat-black branch for other
                    // platforms any more — `GlassPlate` degrades to a flat
                    // translucent fill, so this is correct everywhere.
                    {
                        backgroundColor: GLASS_HEADER_SCRIM,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: 'rgba(255,255,255,0.10)',
                    },
                    headerStyle,
                ]}
            >
                {/* Android-only opaque-ish gradient — must render BEFORE
                    GlassPlate so the tint below still lifts it to a readable
                    surface tone (see GlassSurface.tsx's
                    GlassHeaderAndroidBackdrop doc comment). No-op on iOS. */}
                <GlassHeaderAndroidBackdrop />
                {/* Absolute-fill glass. This Animated.View is unpadded (all
                    padding lives on the VStack below), which is exactly what
                    GlassPlate's parent must be — see GlassSurface. No corner
                    radius here, so no `overflow: 'hidden'`: the header is
                    full-bleed and clipping would only risk cutting off the
                    bell's badge. */}
                <GlassPlate tint={GLASS_HEADER_TINT} />
                {/* ABOVE the plate, not below. A `GlassView` re-samples its
                    backdrop every frame that backdrop changes, which is the
                    single most expensive term the backdrop measured; below the
                    plate this would run that resampling at 100% duty for every
                    sync. See HeaderWorkingGradient's own header for the other
                    two reasons. */}
                <HeaderWorkingGradient active={narrating} />
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
                    (the "?", the bell, the sub-tab pills) may be `auto`. */}
                <VStack
                    className="pb-2"
                    pointerEvents="box-none"
                    style={{ paddingTop: insets.top + 16, paddingHorizontal: HEADER_SIDE_PADDING }}
                >
                    <HStack
                        ref={titleRowRef}
                        // Measured as the status dropdown's anchor; a flattened
                        // view has nothing native to measure.
                        collapsable={false}
                        className="items-start justify-between mb-2"
                        pointerEvents="box-none"
                    >
                        <VStack className="flex-1 min-w-0 mr-3" pointerEvents="box-none">
                            <HStack
                                className="items-center min-w-0"
                                space="sm"
                                pointerEvents="box-none"
                                style={{ height: titleRowHeight }}
                                testID="dashboard-header-title-row"
                            >
                                <View pointerEvents="none" className="flex-shrink min-w-0">
                                    <Heading
                                        size={titleSize}
                                        className="text-white"
                                        numberOfLines={1}
                                        // SHRINK THE TYPE, DO NOT CUT THE WORD. At a
                                        // fixed 36px "Dashboard" truncated to "Dasbo…".
                                        // `titleSize` lowers the ceiling on a compact
                                        // phone; this pair handles "Tableau de bord"
                                        // needing room "Dashboard" does not, and a
                                        // larger Dynamic Type wrapping MID-WORD.
                                        adjustsFontSizeToFit
                                        minimumFontScale={HEADER_TITLE_MIN_SCALE}
                                        testID="dashboard-title"
                                    >
                                        {t('feed.dashboardTitle')}
                                    </Heading>
                                </View>
                                {/* The "?" sits beside the title (owner). */}
                                <TabExplainerButton tab="forYou" testID="dashboard-explainer-open" />
                                <View pointerEvents="none" className="flex-1" />
                            </HStack>
                        </VStack>
                        {/* `[mark] [bell]`, pinned to the title row's height so
                            both centre on the title. The mark is the same shared
                            status control as the Feed's: tapping it drops the
                            one status panel (the stats card is the other trigger
                            of the same dropdown). It announces nothing itself;
                            DashboardStatsCard owns the announcement. */}
                        <HStack
                            className="items-center flex-shrink-0"
                            pointerEvents="box-none"
                            style={{ height: titleRowHeight, gap: HEADER_ACTIONS_GAP }}
                            testID="dashboard-header-actions"
                        >
                            <FeedStatusMark
                                mode={markMode}
                                anchorRef={titleRowRef}
                                testID="dashboard-status-indicator"
                            />
                            <NotificationBellButton />
                        </HStack>
                    </HStack>

                    {/* Sub-tab pills. box-none: the ROW is a full-width band and
                        must not swallow a pull — only the pills themselves take
                        touches (ForYouSubTabs' own HStack is box-none too). */}
                    <View pointerEvents="box-none">
                        <ForYouSubTabs
                            activeSubTab={activeSubTab}
                            onSelect={selectSubTab}
                            // The header's own side padding: the row runs edge
                            // to edge and clips at the screen, not the padding.
                            bleed={HEADER_SIDE_PADDING}
                        />
                    </View>
                </VStack>
            </Animated.View>

            {/* The stats card's dropdown, over the list AND the header. In the
                screen, not a Modal, so the tab bar stays tappable. */}
            <StatusDropdownLayer testIDPrefix="dashboard-stats" />
        </Box>
        </StatusDropdownProvider>
    );
};


export default MeraNewsScreen;
