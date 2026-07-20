import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedSyncLastUpdateText from '@/components/custom/FeedSyncLastUpdateText';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import PriorityLabelCard from '@/components/custom/PriorityLabelCard';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import SectionNavigator, { NavSection } from '@/components/custom/for-you/SectionNavigator';
import FactSectionHeader from '@/components/custom/for-you/FactSectionHeader';
import BreakingStrip from '@/components/custom/for-you/BreakingStrip';
import ShowMoreRow from '@/components/custom/for-you/ShowMoreRow';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import ForYouSubTabs, { type ForYouSubTab } from '@/components/custom/for-you/ForYouSubTabs';
import StoriesSlotPlaceholder from '@/components/custom/for-you/StoriesSlotPlaceholder';
import TrackedStoriesRail from '@/components/custom/tracked-stories/TrackedStoriesRail';
import NewStoriesPill from '@/components/custom/for-you/NewStoriesPill';
import FeedStatusShimmer from '@/components/custom/for-you/FeedStatusShimmer';
import FeedStatusSheet from '@/components/custom/for-you/FeedStatusSheet';
import CaughtUpDivider from '@/components/custom/for-you/CaughtUpDivider';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import {
    buildSectionedFeed,
    buildTwoZoneFeed,
    isSuggestionOpened,
    zoneOneSectionDescriptors,
    loadSectionSnapshots,
    EARLIER_EXPANSION_KEY,
    type SectionSnapshots,
    type SectionedListItem,
} from '@/lib/stores/feed-sections-selector';
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
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, NativeScrollEvent, NativeSyntheticEvent, Platform, StyleSheet, View, ViewToken } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useHeldFeedSuggestions } from '@/lib/hooks/use-held-feed-suggestions';
import { useFeedWatermarkStore } from '@/lib/stores/feed-watermark-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { computeGroupingFingerprint } from '@/components/custom/for-you/story-fingerprint';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ── Legacy (pre-persona-v3-migration) priority-bucket layout items. Kept as the
//    fallback path when the on-device `topics` table is still empty. ──
type PriorityLabelItem = { type: 'priority-label'; label: string; relevance: number };
// `members` = the other suggestions collapsed into this story card (group minus
// representative). Present only when the group has more than one member.
type SuggestionItem = { type: 'suggestion'; data: ForYouSuggestion; members?: ForYouSuggestion[] };
type LegacyListItem = PriorityLabelItem | SuggestionItem;

// The unified FlatList item type: legacy priority-bucket items OR the new
// fact-sectioned items (Wave 7c N2). renderItem/keyExtractor discriminate on
// `type`; only one family is present at a time depending on the migration gate.
type ForYouListItem = LegacyListItem | SectionedListItem;

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
    const [showScrollToTop, setShowScrollToTop] = useState(false);
    const [isLoadingMore] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const { fromOnboarding } = useLocalSearchParams<{ fromOnboarding?: string }>();
    const [showOnboardingWait, setShowOnboardingWait] = useState(false);
    const [stuckOnEmpty, setStuckOnEmpty] = useState(false);
    const dbReady = useDatabaseStore((s) => s.ready);
    // Real navigator focus — used to pause the 30s timers (nowTick + empty-feed
    // watchdog) while this tab is blurred. Tabs stay mounted (no freeze), so
    // effects/intervals keep running unless focus-gated; this pauses them.
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
    // their first visit (display-toggled) so FlatList scroll state survives a
    // switch; Stories/Saved mount lazily on first visit.
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

    // Optimized Zustand selectors (granular subscriptions to prevent unnecessary re-renders).
    // The LIVE store array (used directly by the analysed/relevant counts and the
    // empty-feed watchdog). The RENDERED feed goes through useHeldFeedSuggestions,
    // which holds insertions as a "N new stories" pill instead of injecting them
    // mid-scroll (and coalesces offscreen work while blurred).
    const liveSuggestions = useForYouSuggestions();
    const { suggestions, pendingNewCount, adoptPending } = useHeldFeedSuggestions(liveSuggestions);

    // Two-zone presentation state: the watermark (null until hydrated) splits the
    // feed into a "new" zone and an "Earlier" zone; the opened-story id set dims
    // already-read rows.
    const watermarkMs = useFeedWatermarkStore((s) => s.watermarkMs);
    const openedIds = useOpenedStoriesStore((s) => s.ids);

    // Hydrate the watermark + opened-story stores once on mount; refresh the
    // opened set on refocus so opens recorded on other surfaces dim here too.
    useEffect(() => {
        void useFeedWatermarkStore.getState().hydrate();
        void useOpenedStoriesStore.getState().hydrate();
    }, []);
    useEffect(() => {
        if (isFocused) void useOpenedStoriesStore.getState().hydrate();
    }, [isFocused]);

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
        // Pause the ticking clock while the tab is blurred — nothing on-screen is
        // reading it, and it would otherwise re-render the offscreen screen every
        // 30s. Re-arm on focus and snap `nowTick` forward so the relative-time
        // label is correct the instant the tab is shown again.
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

    // Any client-visible fetch/scoring work still in flight. Deliberately
    // excludes scoringError — an error is not progress.
    const isFeedProcessing =
        isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing || unscoredCount > 0;

    // The user is over their daily delivery cap (sticky until a sync delivers
    // again or the reset time passes). Takes banner priority over the
    // article-count line so the "limit reached" notice is always visible.
    const isDailyLimited =
        dailyLimitResetAt != null && nowTick < dailyLimitResetAt;

    // Read the LIVE store (not the held/rendered array) — these header counts
    // reflect everything scored this cycle, including still-held new arrivals.
    const { analysedCount, relevantCount } = useMemo(() => {
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        let analysed = 0;
        let relevant = 0;
        for (const s of liveSuggestions) {
            if (s.status === ArticleSuggestionStatus.Unscored) continue;
            const t = Date.parse(s.firstPubDate);
            if (!Number.isFinite(t) || t < cutoffMs) continue;
            analysed++;
            if (s.relevance > 0.3) relevant++;
        }
        return { analysedCount: analysed, relevantCount: relevant };
    }, [liveSuggestions]);

    const { setHasGeneratedTopics } = getForYouActions();

    const { fetchUserPersona } = useUserStore();

    const { data: session } = authClient.useSession();
    const isConnected = useIsConnected();
    const insets = useSafeAreaInsets();

    const flatListRef = useRef<FlatList<ForYouListItem>>(null);
    const loadingRef = useRef(false);
    // Story-grouping cache for the legacy listData memo — reused across
    // score/reason-only feed updates whose grouping fingerprint is unchanged
    // (perf A3). Stores groups as arrays of `_id`s, never object refs.
    const groupCacheRef = useRef<{ fp: string; idGroups: string[][] } | null>(null);
    const [activeSection, setActiveSection] = useState<string | null>(null);
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 });

    // ── Fact-sectioned feed (Wave 7c N2) ──
    // Persona-v3 snapshots (topics/facts/locations). Null while loading; when
    // loaded with `hasTopics === false` the screen renders the LEGACY layout.
    const [snapshots, setSnapshots] = useState<SectionSnapshots | null>(null);
    // Per-section expand state for "Show N more" — survives re-render, resets
    // on unmount (tab switch) and when a new sync replaces the feed.
    const [expandedSectionKeys, setExpandedSectionKeys] = useState<Set<string>>(() => new Set());

    // Load the persona snapshots when interests exist or the feed size changes
    // (facts/topics/locations are tiny tables; a new sync's insert/remove is the
    // coarse trigger — live fact-weight edits are picked up on the next change).
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

    // A new sync (feed size changed) invalidates the expand state.
    const prevFeedSizeRef = useRef(suggestions.length);
    useEffect(() => {
        if (prevFeedSizeRef.current !== suggestions.length) {
            prevFeedSizeRef.current = suggestions.length;
            setExpandedSectionKeys((prev) => (prev.size > 0 ? new Set() : prev));
        }
    }, [suggestions.length]);

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

        // ── Expensive stage (union-find over cluster + title edges) — GATED. ──
        // buildStoryGroups is O(n²)-ish and depends ONLY on identity + cluster
        // memberships + titles, never on relevance/reason/score. A score-only or
        // reason-only feed update (the common case — the pipeline scores rows in
        // place) yields a NEW `suggestions` array but an IDENTICAL grouping
        // fingerprint, so we reuse the cached id-groups and skip the union-find.
        // Groups are cached as arrays of `_id`s (never object refs) so the cheap
        // stage below always re-binds to the CURRENT objects and reflects fresh
        // scores (perf A3). See story-fingerprint.ts for the fp definition.
        const fp = computeGroupingFingerprint(visible);
        let idGroups: string[][];
        if (groupCacheRef.current && groupCacheRef.current.fp === fp) {
            idGroups = groupCacheRef.current.idGroups;
        } else {
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
            idGroups = groups.map((g) => g.map((m) => m.id));
            groupCacheRef.current = { fp, idGroups };
        }

        // ── Cheap stage (ALWAYS runs) — bind id-groups to the current objects. ──
        // Each group collapses to one representative: the newest member of the
        // story's best-earned priority bucket fronts the card — a fresh
        // development re-fronts the story; relevance only tiebreaks. The
        // bucket is the section the group's max relevance maps to (via
        // getRelevanceLabel), so the chosen card's own on-card priority chip
        // always matches the section it renders in. Tie-break relevance, then
        // smaller id (inside pickRepresentative).
        const byId = new Map<string, ForYouSuggestion>(visible.map((s) => [s._id, s]));
        const entries = idGroups.map((idGroup) => {
            const members = idGroup
                .map((id) => byId.get(id))
                .filter((s): s is ForYouSuggestion => s !== undefined);
            const maxRelevance = members.reduce((max, m) => Math.max(max, m.relevance), -Infinity);
            const bucketLabel = getRelevanceLabel(maxRelevance);
            const pool = members.filter((m) => getRelevanceLabel(m.relevance) === bucketLabel);
            const rep = pickRepresentative(
                pool.map((s) => ({ id: s._id, title: s.title_en ?? s.title_original, clusters: s.clusters, s })),
                (a, b) => (pubDateMs(b.s) - pubDateMs(a.s)) || (b.s.relevance - a.s.relevance),
            );
            return { rep: rep.s, members: members.filter((m) => m !== rep.s) };
        });

        if (__DEV__) {
            const multiMember = entries.filter((e) => e.members.length > 0).length;
            const collapsed = visible.length - idGroups.length;
            console.log(
                `[ForYou] story groups: ${idGroups.length} groups, ${multiMember} multi-member, ${collapsed} cards collapsed`,
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

    const legacyAvailableSections = useMemo((): { label: string; shortLabel: string }[] => {
        const seen = new Set<string>();
        const result: { label: string; shortLabel: string }[] = [];
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

    // ── Fact-sectioned build (Wave 7c N2 → two-zone). Null ⇒ legacy path. ──
    // Two-zone splits the feed around the presentation watermark once it has
    // hydrated (watermarkMs !== null); until then we fall back to the flat
    // single-zone build so the feed still renders on a cold start.
    const useSectioned = snapshots?.hasTopics === true;
    const sectioned = useMemo(() => {
        if (!useSectioned || !snapshots) return null;
        if (watermarkMs === null) {
            return buildSectionedFeed(suggestions, snapshots, expandedSectionKeys);
        }
        return buildTwoZoneFeed(suggestions, snapshots, expandedSectionKeys, watermarkMs, openedIds);
    }, [useSectioned, snapshots, suggestions, expandedSectionKeys, watermarkMs, openedIds]);

    // The list the FlatList actually renders — sectioned when available, else legacy.
    const activeListData: ForYouListItem[] = sectioned ? sectioned.items : listData;

    // Navigator chips: dynamic section titles (sectioned) or translated priority
    // labels (legacy). translatable:true → TranslatableDynamic; false → t()'d.
    const navSections = useMemo((): NavSection[] => {
        if (sectioned) {
            // Two-zone: chips reflect only the NEW (zone-1) sections, in the same
            // order/watermark rule buildTwoZoneFeed uses. Pre-hydration fallback
            // uses the full section set.
            if (watermarkMs !== null) {
                const byId = new Map(suggestions.map((s) => [s._id, s]));
                return zoneOneSectionDescriptors(sectioned.result, byId, watermarkMs).map((d) => ({
                    key: d.key,
                    title: d.title,
                    translatable: d.kind !== 'also',
                }));
            }
            return sectioned.result.sections.map((s) => ({
                key: s.key,
                title: s.title,
                translatable: s.kind !== 'also', // "Also for you" is a static string
            }));
        }
        return legacyAvailableSections.map((s) => ({
            key: s.shortLabel,
            title: t(s.shortLabel as any),
            translatable: false,
        }));
    }, [sectioned, watermarkMs, suggestions, legacyAvailableSections, t]);

    // Hide the onboarding waiting card once the first scored, relevant card is ready.
    useEffect(() => {
        if (showOnboardingWait && activeListData.length > 0) {
            setShowOnboardingWait(false);
        }
    }, [showOnboardingWait, activeListData.length]);

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
        if (activeListData.length > 0) {
            if (stuckOnEmpty) setStuckOnEmpty(false);
            return;
        }
        const shouldArm =
            // Don't run the 30s watchdog while the tab is blurred — the user
            // isn't looking at the offscreen feed, and it would fire a spurious
            // Sentry event for a screen nobody is waiting on. Re-arms cleanly on
            // refocus (isFocused is in the dep array).
            isFocused &&
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
    }, [isFocused, session?.user?.id, dbReady, hasGeneratedInterests, errorMessage, activeListData.length, asyncJobPhase, unscoredCount, syncStatusMessage?.errorCode, isDailyLimited]);

    const handleSuggestionPress = useCallback((suggestion: ForYouSuggestion) => {
        // Optimistically dim the row immediately (Earlier + zone-1 dimming reads
        // this store) — the DB open row is still written below.
        useOpenedStoriesStore.getState().markOpened(
            suggestion.articleId,
            suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null,
        );
        // Record the open into story-impression seen-state (fire-and-forget —
        // never blocks navigation). For-You is the sectioned surface.
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
                userPersonaId: userPersonaId,
            }
        });
    }, [session?.user?.id]);

    const toggleSection = useCallback((sectionKey: string) => {
        setExpandedSectionKeys((prev) => {
            const next = new Set(prev);
            if (next.has(sectionKey)) next.delete(sectionKey);
            else next.add(sectionKey);
            return next;
        });
    }, []);

    // "N new stories" pill press: adopt the held arrivals (advancing the
    // watermark over the outgoing rows) then snap to the top.
    const handleAdoptPending = useCallback(() => {
        adoptPending();
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, [adoptPending]);

    // Zone-1 dimming predicate — an opened story's card renders dimmed.
    const isRowOpened = useCallback(
        (s: ForYouSuggestion) => isSuggestionOpened(s, openedIds),
        [openedIds],
    );

    const renderItem: ListRenderItem<ForYouListItem> = useCallback(({ item }) => {
        switch (item.type) {
            // ── Legacy priority-bucket items ──
            case 'priority-label':
                return <PriorityLabelCard label={item.label} relevance={item.relevance} />;
            case 'suggestion': {
                const moreSourcesCount = item.members ? computeMoreSourcesCount(item.data, item.members) : 0;
                return (
                    <ArticleSuggestionCard
                        suggestion={item.data}
                        moreSourcesCount={moreSourcesCount}
                        onPress={handleSuggestionPress}
                        showActions
                        surface="for_you"
                        dimmed={isRowOpened(item.data)}
                    />
                );
            }
            // ── Fact-sectioned items (Wave 7c N2) ──
            case 'breaking-strip':
                return <BreakingStrip items={item.items} onPressItem={handleSuggestionPress} />;
            case 'fact-header':
                return (
                    <FactSectionHeader
                        section={item.section}
                        eventType={item.eventType}
                        factStatement={item.factStatement}
                    />
                );
            case 'suggestion-card': {
                const moreSourcesCount = item.members.length > 0 ? computeMoreSourcesCount(item.data, item.members) : 0;
                return (
                    <ArticleSuggestionCard
                        suggestion={item.data}
                        moreSourcesCount={moreSourcesCount}
                        onPress={handleSuggestionPress}
                        showActions
                        surface="for_you"
                        dimmed={isRowOpened(item.data)}
                    />
                );
            }
            case 'show-more':
                return <ShowMoreRow remaining={item.remaining} onPress={() => toggleSection(item.sectionKey)} />;
            // ── Two-zone items ──
            case 'caught-up-divider':
                return <CaughtUpDivider variant={item.variant} earlierCount={item.earlierCount} />;
            case 'earlier-card':
                return (
                    <ArticleSuggestionCompactCard
                        suggestion={item.data}
                        onPress={handleSuggestionPress}
                        surface="for_you"
                        dimmed={item.opened}
                    />
                );
            case 'earlier-show-more':
                return (
                    <ShowMoreRow remaining={item.count} onPress={() => toggleSection(EARLIER_EXPANSION_KEY)} />
                );
            default:
                return null;
        }
    }, [handleSuggestionPress, toggleSection, isRowOpened]);

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
        if (activeListData.length > 0 && !hasNextPage) {
            return isFeedProcessing ? <FeedPreparingCard /> : <AllCaughtUpCard />;
        }
        return null;
    }, [activeListData.length, isLoadingMore, hasNextPage, isFeedProcessing]);

    const keyExtractor = useCallback((item: ForYouListItem, index: number) => {
        switch (item.type) {
            case 'priority-label':
                return `label-${item.label}`;
            case 'suggestion':
                return item.data._id || `suggestion-${index}`;
            default:
                // Sectioned items all carry a stable, unique `key`.
                return item.key;
        }
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
        if (sectioned) {
            // Sectioned: the topmost visible fact-header names the active section;
            // if none is visible, scan backwards for the owning header.
            const header = viewableItems.find((vi) => vi.item?.type === 'fact-header');
            if (header) {
                setActiveSection((header.item as Extract<SectionedListItem, { type: 'fact-header' }>).section.key);
                return;
            }
            // Viewport in the Earlier zone (past the caught-up divider) → no active
            // section chip (the Earlier zone is flat, section-less).
            const inZoneTwo = viewableItems.some(
                (vi) =>
                    vi.item?.type === 'caught-up-divider' ||
                    vi.item?.type === 'earlier-card' ||
                    vi.item?.type === 'earlier-show-more',
            );
            if (inZoneTwo) {
                setActiveSection(null);
                return;
            }
            const firstIdx = viewableItems[0]?.index ?? 0;
            for (let i = firstIdx; i >= 0; i--) {
                const it = activeListData[i];
                if (it?.type === 'fact-header') {
                    setActiveSection(it.section.key);
                    return;
                }
            }
            return;
        }
        // Legacy priority-bucket sections.
        const firstLabel = viewableItems.find((vi) => vi.item?.type === 'priority-label');
        if (firstLabel) {
            setActiveSection(getDisplaySectionLabel((firstLabel.item as PriorityLabelItem).label));
            return;
        }
        const firstIdx = viewableItems[0]?.index ?? 0;
        for (let i = firstIdx - 1; i >= 0; i--) {
            if (activeListData[i]?.type === 'priority-label') {
                setActiveSection(getDisplaySectionLabel((activeListData[i] as PriorityLabelItem).label));
                return;
            }
        }
    }, [sectioned, activeListData]);

    const scrollToSection = useCallback((key: string) => {
        const index = sectioned
            ? activeListData.findIndex((item) => item.type === 'fact-header' && item.section.key === key)
            : activeListData.findIndex(
                (item) => item.type === 'priority-label' && getDisplaySectionLabel(item.label) === key,
            );
        if (index !== -1) {
            flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
        }
    }, [sectioned, activeListData]);

    // Overflow chip → jump to the 9th section (first one hidden by the cap).
    const scrollToOverflow = useCallback(() => {
        const ninth = sectioned?.result.sections[8];
        if (ninth) scrollToSection(ninth.key);
    }, [sectioned, scrollToSection]);

    const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
        flatListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        setTimeout(() => {
            flatListRef.current?.scrollToIndex({ index: info.index, animated: true });
        }, 100);
    }, []);

    return (
        <Box className="flex-1 bg-black">
            <VStack className="px-5 pb-2 border-gray-800 z-10" style={{ paddingTop: insets.top + 16 }}>
                {/* Title row — heading + tappable last-update line (opens the feed
                    status sheet) + the inline notification bell. */}
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

                {/* Feed-status shimmer directly under the pill row. */}
                <View className="mt-2">
                    <FeedStatusShimmer
                        processing={isFeedProcessing}
                        error={scoringError !== null}
                        dailyLimited={isDailyLimited}
                        onPress={openStatusSheet}
                    />
                </View>

                {/* Section navigator + offline notice — Feed sub-tab only. */}
                {activeSubTab === 'feed' && navSections.length > 0 && (
                    <Box className="mt-2 mb-1">
                        <SectionNavigator
                            sections={navSections}
                            activeKey={activeSection}
                            onSelect={scrollToSection}
                            onOverflow={scrollToOverflow}
                        />
                    </Box>
                )}
                {activeSubTab === 'feed' && !isConnected && (
                    <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mt-2" space="sm">
                        <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                        <Text size="sm" className="text-warning-400">{t('feed.offlineCached')}</Text>
                    </HStack>
                )}
            </VStack>

            {/* Keep-mounted sub-tab content — each tab's tree survives a switch
                (display-toggled) so FlatList/scroll state is preserved. Stories
                and Saved mount lazily on first visit. */}
            <View style={{ flex: 1 }}>
                {/* Feed */}
                <View style={{ flex: 1, display: activeSubTab === 'feed' ? 'flex' : 'none' }}>
                    {/* Followed-stories rail — self-contained; renders null unless
                        an active tracked story has unseen developments. Sits
                        directly above the feed list, inside the Feed pane only. */}
                    <TrackedStoriesRail />
                    <AnimatedFlatList
                        ref={flatListRef}
                        data={activeListData}
                        renderItem={renderItem}
                        keyExtractor={keyExtractor}
                        contentContainerStyle={{ paddingVertical: 20, paddingBottom: 100 }}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={handleScroll}
                        onEndReached={loadMoreArticles}
                        onEndReachedThreshold={0.5}
                        // Virtualization tuning (perf A2). Cards are variable-height so
                        // NO getItemLayout; these keep the render/retain window small.
                        // removeClippedSubviews is Android-only (it causes blank-cell
                        // glitches on iOS and buys little there).
                        windowSize={7}
                        maxToRenderPerBatch={6}
                        initialNumToRender={6}
                        updateCellsBatchingPeriod={50}
                        removeClippedSubviews={Platform.OS === 'android'}
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
                    {activeSubTab === 'feed' && pendingNewCount > 0 && (
                        <NewStoriesPill count={pendingNewCount} onPress={handleAdoptPending} />
                    )}
                    <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} extraBottomOffset={TAB_BAR_HEIGHT} />
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

            {/* One-time "What's new" sheet (existing users, first launch post-OTA). */}
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
