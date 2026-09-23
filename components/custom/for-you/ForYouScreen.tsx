import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import {
    useFeedSyncRefresh,
    useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import FeedStatusIndicator from '@/components/custom/for-you/FeedStatusIndicator';
import FeedStatusPanel from '@/components/custom/for-you/FeedStatusPanel';
import {
    headerTitleLineHeight,
    headerTitleSize,
    HEADER_TITLE_MIN_SCALE,
} from '@/lib/typography/header-title-size';
import HeaderWorkingGradient from '@/components/custom/HeaderWorkingGradient';
import HeaderNarrationLine from '@/components/custom/for-you/HeaderNarrationLine';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import { HEADER_NARRATION_METRICS, NARRATION_COLOR } from '@/components/custom/for-you/header-narration';
import { Text } from '@/components/ui/text';
import { useProcessingSnapshot } from '@/components/custom/processing/use-processing-snapshot';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useStatusDisclosure } from '@/lib/hooks/use-status-disclosure';
import {
    GLASS_HEADER_SCRIM,
    GLASS_HEADER_TINT,
    GlassHeaderAndroidBackdrop,
    GlassPlate,
} from '@/components/custom/GlassSurface';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import DashboardEmptyState from '@/components/custom/for-you/DashboardEmptyState';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import FeedStatusSheet from '@/components/custom/for-you/FeedStatusSheet';
import DashboardSectionsFeed from '@/components/custom/for-you/DashboardSectionsFeed';
import FactChecksPanel from '@/components/custom/fact-checks/FactChecksPanel';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
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
import { Pressable } from '@/components/ui/pressable';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import {
    useForYouAsyncJobPhase,
    useForYouDeviceProcessing,
    useForYouHasGeneratedTopics,
    useForYouLastNewArticlesAt,
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
import { formatTimeAgo } from '@/lib/utils/time-ago';
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


/** Above this OS text scale the status row may wrap and the header grow. */
const LARGE_TEXT_SCALE = 1.2;

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

    // Sub-tab state — Feed / Stories / Saved / History. All four are kept
    // mounted after their first visit (display-toggled) so scroll state
    // survives a switch.
    const [activeSubTab, setActiveSubTab] = useState<ForYouSubTab>('feed');
    const [storiesVisited, setStoriesVisited] = useState(false);
    const [savedVisited, setSavedVisited] = useState(false);
    const [historyVisited, setHistoryVisited] = useState(false);
    const [factChecksVisited, setFactChecksVisited] = useState(false);
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

    // Feed-status detail sheet (opened from the header status line + shimmer).
    const [statusSheetOpen, setStatusSheetOpen] = useState(false);
    const openStatusSheet = useCallback(() => setStatusSheetOpen(true), []);

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
    const lastNewArticlesAt = useForYouLastNewArticlesAt();
    const [nowTick, setNowTick] = useState(() => Date.now());

    useEffect(() => {
        // Pause the ticking clock while blurred; re-arm + snap forward on focus.
        if (!isFocused) return;
        if (!lastProcessingRunFinishedAt && !dailyLimitResetAt && !lastNewArticlesAt) return;
        setNowTick(Date.now());
        const id = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [isFocused, lastProcessingRunFinishedAt, dailyLimitResetAt, lastNewArticlesAt]);

    // "Last processed" in the status panel and sheet: when a run last finished,
    // including one that found nothing. That is what the words say.
    const lastProcessedLabel = useMemo(() => {
        if (!lastProcessingRunFinishedAt) return null;
        return formatTimeAgo(t, lastProcessingRunFinishedAt, { now: nowTick });
    }, [lastProcessingRunFinishedAt, nowTick, t]);

    // "Updated <time>" in the header: when new articles last ARRIVED
    // (`lastNewArticlesAt`), never when a poll that found nothing finished,
    // which reset it to "just now" while the reader was reading (F16). Null
    // until a sync has delivered something, and then the row simply shows
    // nothing. Under a minute it is its own sentence-case string: splicing
    // "Just now" into "Updated {{time}}" read "Updated Just now".
    const updatedLabel = useMemo(() => {
        if (!lastNewArticlesAt) return null;
        if (nowTick - lastNewArticlesAt < 60_000) return t('feed.updatedJustNow');
        return t('feed.updatedAt', { time: formatTimeAgo(t, lastNewArticlesAt, { now: nowTick }) });
    }, [lastNewArticlesAt, nowTick, t]);

    // Any client-visible fetch/scoring work still in flight — the shared
    // derivation (see components/custom/FeedSyncIndicator). Used here only for
    // the empty-state chain and the header auto-reveal; the header indicator
    // OR-s in the scheduler flag on its own.
    const isFeedProcessing = useIsFeedProcessing();

    // Same status mark + panel pair the Feed mounts, with NO auto-collapse:
    // this is the screen you come to in order to look at the numbers, so the
    // panel stays open until you close it — which is how this accordion has
    // always behaved.
    //
    // `available` is hard-coded true, matching the Feed. It used to be
    // `isStatusVisible(statusMode)`, whose whole job was closing a panel whose
    // mark had just unmounted at the end of a sync. The mark is on screen in
    // every state now, so that guard would only yank an open accordion shut the
    // moment the pipeline settled — on the one screen whose panel is meant to
    // stay put.
    // Title ceiling from the window width; see header-title-size for why this
    // is two steps and not a ramp.
    const { width: windowWidth } = useWindowDimensions();
    const titleSize = headerTitleSize(windowWidth);
    // Pinned, in BOTH states — see `headerTitleLineHeight`. The Dashboard pays
    // for this twice over: `headerHeight` is handed to all four sub-tab panels.
    const titleRowHeight = headerTitleLineHeight(windowWidth);

    const statusMode = useFeedStatusMode();
    const { expanded: statusExpanded, toggle: toggleStatus } = useStatusDisclosure(true);

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
    // the end is announced ONCE to a screen reader, rather than the line being
    // a live region that talks over the list every four seconds.
    const wasNarrating = useRef(narrating);
    useEffect(() => {
        if (wasNarrating.current && !narrating && isFocused) {
            AccessibilityInfo.announceForAccessibility(t('feedStatus.syncDoneA11y'));
        }
        wasNarrating.current = narrating;
    }, [narrating, isFocused, t]);
    // Read for the STAGE only. The snapshot's own `visible` is the wider
    // scheduler-inclusive question and is deliberately not consulted here.
    // No parameter is added to the snapshot for this; on-device is its own
    // store read, the same one the snapshot itself makes.
    const { stage } = useProcessingSnapshot();
    const { isDeviceProcessing } = useForYouDeviceProcessing();

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
    // The TITLE IS ALWAYS SHOWN (D6). It used to step aside while a sync ran
    // and hand its slot to the narration, which then had 88pt beside the mark
    // and the bell: "Dashboard" is 184pt wide. The narration truncated
    // mid-sentence and the screen lost its name. The status sentence now has
    // its OWN full-width row under the title (N11), one line at every text
    // size up to large, and the row is height-PINNED in every state, empty
    // included, so a sync starting or ending never moves the header, and so
    // never moves the four panels padded by its height. At a large text size
    // the row may wrap to three lines and the header grows once.
    //
    // The Feed still puts its line beside its title: its title is 82pt and it
    // has no bell, so it has 245pt there. Do not unify without re-measuring.
    const { fontScale } = useWindowDimensions();
    const statusRowLines = fontScale > LARGE_TEXT_SCALE ? 3 : 1;
    const statusRowStyle =
        statusRowLines === 1
            ? { height: HEADER_NARRATION_METRICS.lineHeight }
            : { minHeight: HEADER_NARRATION_METRICS.lineHeight };
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
                        <VisitedPublicationsList embedded active={activeSubTab === 'history'} onBack={() => selectSubTab('feed')} scrollHandler={scrollHandler} headerHeight={headerHeight} />
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
                        <ShareStatsFab onPress={() => router.push('/logged-in/share-stats')} />
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
                                <FeedStatusIndicator
                                    mode={statusMode}
                                    expanded={statusExpanded}
                                    onPress={toggleStatus}
                                    testID="dashboard-status-indicator"
                                />
                                <View pointerEvents="none" className="flex-1" />
                            </HStack>
                        </VStack>
                        <HStack className="items-center flex-shrink-0" space="md" pointerEvents="box-none">
                            <TabExplainerButton tab="forYou" testID="dashboard-explainer-open" />
                            <NotificationBellButton />
                        </HStack>
                    </HStack>

                    {/* The status row: full width, its own line, pinned. While a
                        sync runs it narrates; otherwise it says when new
                        articles last arrived, and a tap opens the status sheet.
                        Never "Updated" while a run is going. */}
                    <View
                        pointerEvents="box-none"
                        className="mb-2"
                        style={statusRowStyle}
                        testID="dashboard-status-row"
                    >
                        {narrating ? (
                            <View pointerEvents="none" testID="dashboard-header-narration">
                                <HeaderNarrationLine
                                    stage={stage}
                                    onDevice={isDeviceProcessing}
                                    layout="row"
                                    maxLines={statusRowLines}
                                    testID="dashboard-narration-line"
                                />
                            </View>
                        ) : updatedLabel ? (
                            <Pressable
                                onPress={openStatusSheet}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('feedStatus.openA11y')}
                                testID="dashboard-open-status-sheet"
                            >
                                <Text
                                    numberOfLines={statusRowLines}
                                    style={{
                                        color: NARRATION_COLOR,
                                        fontSize: HEADER_NARRATION_METRICS.fontSize,
                                        lineHeight: HEADER_NARRATION_METRICS.lineHeight,
                                    }}
                                    testID="dashboard-updated-label"
                                >
                                    {updatedLabel}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>

                    {/* Stats sentence — decorative text, never tapped: fully
                        transparent to touches so a pull can start on it. */}
                    {activeSubTab === 'feed' && (
                    <View pointerEvents="none" testID="dashboard-stats-sentence">
                        {/* Overview only: on Saved, Visited, Stories and Fact
                            checks these numbers describe a different list and
                            cost three lines of header (M3).
                            Brighter + a little heavier than the muted body step:
                            this line sits on glass with content moving under it,
                            where typography-400 was barely legible. Only colour
                            and weight change — `leading-6 mb-2` is preserved. */}
                        <FeedStatsSentence className="text-typography-700 font-medium mb-2" />
                    </View>
                    )}

                    {/* Sub-tab pills. box-none: the ROW is a full-width band and
                        must not swallow a pull — only the pills themselves take
                        touches (ForYouSubTabs' own HStack is box-none too). */}
                    <View pointerEvents="box-none">
                        <ForYouSubTabs activeSubTab={activeSubTab} onSelect={selectSubTab} />
                    </View>

                    {/* The detail panel the status glyph in the title row opens.
                        Same component the Feed mounts; the full-width
                        indeterminate bar that used to live here is gone from
                        both tabs. The offline notice moved to the global
                        OfflineBanner at the root layout, so there is no longer a
                        per-sub-tab connectivity prop to pass. */}
                    <View pointerEvents="box-none">
                        <FeedStatusPanel
                            expanded={statusExpanded}
                            mode={statusMode}
                            lastProcessedLabel={lastProcessedLabel}
                        />
                    </View>
                </VStack>
            </Animated.View>

            {/* Right edge swipe hitbox */}

            {/* Feed-status detail sheet. */}
            <FeedStatusSheet
                isOpen={statusSheetOpen}
                onClose={() => setStatusSheetOpen(false)}
                lastProcessedLabel={lastProcessedLabel}
            />
        </Box>
    );
};


export default MeraNewsScreen;
