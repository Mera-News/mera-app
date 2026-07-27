// FeedScreen — the "For you" tab (landing tab). A static, insert-only vertical
// scroll feed of personalized story cards. The order is built ONCE when empty
// (first launch / post-wipe) and NEVER fully rebuilt — new Complete suggestions
// are INSERTED beyond the current viewport. The order persists across app
// restarts (feed-order-store).
//
// Cards NEVER move or vanish on interaction. Every card carries a lifecycle
// state (unviewed → skipped / viewed, see feed-order-store): a tapped or thumbed
// card stays exactly where it is, and a card the user dwelt on is only removed
// by the eviction SWEEP, 10 minutes later. The sweep runs at safe moments only —
// tab focus regain, app foreground, pull-to-refresh (force), app launch — and
// never while the user is deep in the list, so rows can't yank out from under
// a scroll. When the sweep has to be deferred it re-fires on the way back to
// the top.
//
// Each card carries a small borderless action bar (like / dislike / Mera /
// save); tapping a thumb records a verdict and reveals the card's inline
// feedback surface (CardFeedbackSurface). Every one of those interactions —
// plus opening the card — marks it `viewed`.
// The header is the "For you" heading + notification bell + 24h stats sentence.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedPreparingCard from '@/components/custom/FeedPreparingCard';
import FeedSyncIndicator, {
  useFeedSyncRefresh,
  useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { useVisibleIndex, frozenThroughIndexFor } from './use-visible-index';
import {
  useFeedbackSheet,
  type CardFeedbackHandlers,
  type VerdictStoreAdapter,
} from './use-feedback-sheet';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import {
  buildFeedList,
  type FeedListItem,
} from '@/lib/stores/feed-list-selector';
import { useFeedOrderStore, type Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useDatabaseReady } from '@/lib/stores/database-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import {
  useForYouHasGeneratedTopics,
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
} from '@/lib/stores/selectors';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, RefreshControl, type AppStateStatus } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const REFRESH_TINT = '#EDA77E';

/** Show the scroll-to-top FAB once the feed is scrolled past this many px. */
const SCROLL_THRESHOLD = 300;

/** Max scroll offset at which an eviction sweep is allowed to mutate the list.
 *  Deliberately near-zero rather than reusing SCROLL_THRESHOLD: at 300px the
 *  user is still inside the first card, so removing row 0 would visibly shift
 *  what they are looking at. Only at the very top is a removal invisible. */
const SWEEP_SAFE_OFFSET = 8;

/** How long after an evicting sweep the empty feed reads "all caught up"
 *  rather than "preparing" — long enough to cover the sync it kicked off. */
const SWEPT_EMPTY_GRACE_MS = 30_000;

// Module-constant empty exclusion set: candidates keep opened items (they back
// frozen rows for refresh + hydrate survival). Opened-exclusion happens only
// for NEW ids inside `ingest`.
const EMPTY_SET: Set<string> = new Set();

/** One rendered feed row. Subscribes to its OWN verdict + opened state so a
 *  verdict/open change re-renders only this row, not the whole list. The action
 *  handlers are the (stable) card-action handlers from `useFeedbackSheet`, which
 *  resolve the suggestion → list-item verdict key via the screen's adapter. */
const FeedRow = React.memo(function FeedRow({
  item,
  onPress,
  onVerdict,
  onAskMera,
  onSaveToggled,
  feedbackHandlers,
}: {
  item: FeedListItem;
  onPress: (suggestion: ForYouSuggestion) => void;
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  onAskMera: (suggestion: ForYouSuggestion) => void;
  onSaveToggled: (suggestion: ForYouSuggestion, saved: boolean) => void;
  feedbackHandlers: CardFeedbackHandlers;
}) {
  const verdict = useFeedOrderStore((s) => s.verdicts[item.id]?.verdict ?? null);
  const path = useFeedOrderStore((s) => s.verdicts[item.id]?.path);
  const surfaceClosed = useFeedbackDismissedStore((s) => !!s.dismissed[item.id]);
  const opened = useOpenedStoriesStore((s) => isSuggestionOpened(item.suggestion, s.ids));
  // Save and Ask Mera mark a card `viewed` WITHOUT recording an open (they must
  // not feed the personalization seen-set), so the opened store alone would
  // leave those cards looking untouched while they sit on a 10-minute eviction
  // clock. A `skipped` write leaves this selector false → false, so zustand
  // bails and the scroll-driven skip flush still costs zero re-renders.
  const viewed = useFeedOrderStore((s) => s.cardStates[item.id]?.state === 'viewed');
  return (
    <ArticleSuggestionCard
      suggestion={item.suggestion}
      onPress={onPress}
      verdict={verdict}
      onVerdict={onVerdict}
      onAskMera={onAskMera}
      onSaveToggled={onSaveToggled}
      feedbackVisible={verdict != null && !surfaceClosed}
      feedbackInitialPath={path}
      feedbackHandlers={feedbackHandlers}
      // Viewed stories get ONLY the eye indicator (`read`) — no dimming.
      // Dimming is reserved for a recorded verdict (like/dislike).
      dimmed={verdict != null}
      read={opened || viewed}
      flat
    />
  );
});

const FeedScreen: React.FC = () => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const { isLoading, errorMessage } = useFeedBootstrap();

  // Collapsing header (hides on scroll-down, reveals on scroll-up) — shared
  // with the Dashboard tab.
  const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal } =
    useCollapsibleHeader();

  // ── Live inputs ──
  const suggestions = useForYouSuggestions();

  // The user's geo/language context (home/other countries + app language) —
  // makes representative election tier-aware. Null while loading/on failure,
  // which `buildFeedList` treats as the legacy geo/language-blind pick.
  const userGeoLanguageCtx = useUserGeoLanguageContext();

  // Candidates keep opened items in (they back frozen rows + survive hydrate) —
  // no exclusion here; opened-filtering happens only for NEW ids in ingest.
  const candidates = useMemo(
    () => buildFeedList(suggestions, EMPTY_SET, Date.now(), userGeoLanguageCtx),
    [suggestions, userGeoLanguageCtx],
  );
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // ── Persisted order store (reactive) ──
  const order = useFeedOrderStore((s) => s.order);
  const itemsById = useFeedOrderStore((s) => s.itemsById);
  const orderHydrated = useFeedOrderStore((s) => s.hydrated);
  const openedHydrated = useOpenedStoriesStore((s) => s.hydrated);

  // ── Freeze boundary + skip dwell (viewability → refs only; no store/DB
  //    writes mid-scroll). `FeedRow` subscribes to the opened set per row for
  //    its own eye indicator, so the screen deliberately does NOT — that used
  //    to re-render the entire list on every markOpened. ──
  const { viewabilityConfigCallbackPairs, seenIdsRef, flushSkips } = useVisibleIndex();

  // ── Scroll-to-top FAB ── The list ref forwards to the underlying FlatList
  // (Animated.createAnimatedComponent), so scrollToOffset is available. The
  // visibility boolean is driven from the scroll worklet (below) but only
  // crosses the JS bridge when it actually flips (showFabShared guard).
  const listRef = useRef<Animated.FlatList<FeedListItem>>(null);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const showFabShared = useSharedValue(false);
  // Mirrors `atTopRef` on the UI thread so the worklet can flip-guard it. Starts
  // true — a freshly-mounted list is at offset 0.
  const atTopShared = useSharedValue(true);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Hydrate the persisted order ONCE, when the DB is ready. Evicts persisted ids
  // with no live backing item; restores survivors in their persisted order.
  const dbReady = useDatabaseReady();
  const didHydrate = useRef(false);
  useEffect(() => {
    if (!dbReady || didHydrate.current) return;
    didHydrate.current = true;
    void useFeedOrderStore.getState().hydrate(candidatesRef.current);
  }, [dbReady]);

  // ── Lifecycle eviction sweep ──
  // Safe moments ONLY. A sweep must never remove rows out from under a user who
  // is mid-list: returning from an article detail re-focuses this tab (the most
  // common flow of all), and evicting rows above the viewport there would yank
  // the content they are reading. So unless the list is at the very top
  // (SWEEP_SAFE_OFFSET) the sweep is DEFERRED, and re-fires on the way back up.
  const atTopRef = useRef(true);
  const pendingSweepRef = useRef(false);
  const pendingForceRef = useRef(false);
  /** When a sweep last actually evicted something — see `renderEmpty`. */
  const sweptAtRef = useRef(0);
  const runSweep = useCallback(
    (force: boolean) => {
      // Buffered dwell marks must land BEFORE the sweep reads card state,
      // otherwise a card the user just finished looking at survives a round.
      flushSkips();
      if (!useFeedOrderStore.getState().hydrated) return;
      if (!atTopRef.current) {
        pendingSweepRef.current = true;
        // Keep the force flag sticky — a deferred pull-to-refresh sweep must
        // still ignore the grace period when it eventually lands.
        pendingForceRef.current = pendingForceRef.current || force;
        return;
      }
      const evicted = useFeedOrderStore.getState().sweep({
        force: force || pendingForceRef.current,
        openedIds: useOpenedStoriesStore.getState().ids,
      });
      if (evicted > 0) sweptAtRef.current = Date.now();
      pendingSweepRef.current = false;
      pendingForceRef.current = false;
    },
    [flushSkips],
  );
  const runSweepRef = useRef(runSweep);
  runSweepRef.current = runSweep;

  // (a) Tab regains focus. EDGE-DETECTED: both feed tabs stay mounted under
  //     NativeTabs and `useIsFocused` is already true on first mount, so an
  //     un-edged effect would sweep before hydrate and persist an empty order.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const was = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (isFocused && !was) runSweep(false);
    else if (!isFocused && was) flushSkips(); // blur: don't lose buffered marks
  }, [isFocused, runSweep, flushSkips]);

  // (b) App returns to foreground. On the way out we only flush — and only on
  //     'background', never 'inactive', which iOS also fires for the app
  //     switcher and Control Centre.
  useEffect(() => {
    const appStateRef = { current: AppState.currentState as AppStateStatus };
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'background') {
        flushSkips();
        useFeedOrderStore.getState().flushPersist();
        return;
      }
      if ((prev === 'background' || prev === 'inactive') && next === 'active') {
        runSweepRef.current(false);
      }
    });
    return () => sub.remove();
  }, [flushSkips]);

  // Reaching the top of the list is the only place a deferred sweep can safely
  // land — nothing above the viewport means nothing to shift.
  const onAtTopFlip = useCallback((top: boolean) => {
    atTopRef.current = top;
    if (top && pendingSweepRef.current) runSweepRef.current(false);
  }, []);

  // Insert newly-Complete candidates while the tab is active (frozen ingest —
  // never reorders rows already laid out; freezes through the deepest row the
  // user has actually reached + 2, recomputed against the live order).
  useEffect(() => {
    if (!isFocused || !orderHydrated || !openedHydrated) return;
    const store = useFeedOrderStore.getState();
    store.ingest(
      candidates,
      useOpenedStoriesStore.getState().ids,
      frozenThroughIndexFor(store.order, seenIdsRef.current),
    );
  }, [candidates, isFocused, orderHydrated, openedHydrated, seenIdsRef]);

  const data = useMemo(
    () => order.map((id) => itemsById[id]).filter((it): it is FeedListItem => !!it),
    [order, itemsById],
  );

  // ── Feedback sheet (shared plumbing) ──
  // The verdict store is `feed-order-store`, keyed by the rep-switch-safe
  // list-item id. The card hands back the suggestion, so the adapter resolves
  // suggestion._id → list-item id via a ref map rebuilt from the live order.
  const openSuggestionBase = useOpenSuggestion('feed');

  const suggestionToItemId = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of data) m.set(it.suggestion._id, it.id);
    return m;
  }, [data]);
  const suggestionToItemIdRef = useRef(suggestionToItemId);
  suggestionToItemIdRef.current = suggestionToItemId;

  /** Stamp a card `viewed` from a suggestion, via the rep-switch-safe key. */
  const markViewedFor = useCallback((s: ForYouSuggestion) => {
    const key = suggestionToItemIdRef.current.get(s._id);
    if (key) useFeedOrderStore.getState().markViewed(key);
  }, []);

  // Tap-open. Wrapped HERE rather than inside `useOpenSuggestion` — that hook is
  // shared with the Dashboard, which has no card lifecycle.
  const openSuggestion = useCallback(
    (s: ForYouSuggestion) => {
      markViewedFor(s);
      openSuggestionBase(s);
    },
    [markViewedFor, openSuggestionBase],
  );

  const feedAdapter: VerdictStoreAdapter = {
    keyFor: (s) => suggestionToItemIdRef.current.get(s._id) ?? null,
    getVerdict: (key) => useFeedOrderStore.getState().verdicts[key]?.verdict ?? null,
    setVerdict: (key, v) => {
      const store = useFeedOrderStore.getState();
      // One line covers all four verdict paths — fresh, flip, and un-vote — so
      // `use-feedback-sheet` (shared with FactFeedScreen) needs no change.
      store.markViewed(key);
      if (v == null) store.clearVerdict(key);
      else store.setVerdict(key, v);
    },
    getPath: (key) => useFeedOrderStore.getState().verdicts[key]?.path,
    setPath: (key, path) => useFeedOrderStore.getState().setPath(key, path),
  };
  const {
    onVerdict,
    onAskMera: askMeraBase,
    feedbackHandlers,
  } = useFeedbackSheet(feedAdapter);

  // Ask Mera and Save mark the card `viewed` but deliberately do NOT record an
  // open — skips and these two must stay out of the personalization seen-set.
  // `FeedRow` reads the `viewed` card state for its eye indicator instead.
  const onAskMera = useCallback(
    (s: ForYouSuggestion) => {
      markViewedFor(s);
      askMeraBase(s);
    },
    [markViewedFor, askMeraBase],
  );
  const onSaveToggled = useCallback(
    (s: ForYouSuggestion) => markViewedFor(s),
    [markViewedFor],
  );

  // ── Pull-to-refresh — triggers a feed sync AND a force eviction sweep.
  //    The sweep hangs off `onPullAccepted`, which fires only after the hook's
  //    offline and auth-paused early-returns: force-emptying the feed while
  //    offline would leave nothing able to refill it. `refreshing` tracks the
  //    scheduler's feed-sync flag rather than local state — `trigger()` has four
  //    silent early-returns, three of which resolve in the same tick, so the old
  //    setRefreshing(true)/await/false pattern collapsed the spinner instantly
  //    and the user saw nothing. See components/custom/FeedSyncIndicator. ──
  const forceSweep = useCallback(() => runSweepRef.current(true), []);
  const { refreshing, onRefresh } = useFeedSyncRefresh(reveal, forceSweep);

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport) —
  // mirrors DashboardSectionsFeed's composition.
  const tickHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      runOnJS(notifyScrollTick)();
      const y = e.contentOffset.y;
      // Toggle the scroll-to-top FAB — cross the JS bridge only when the
      // threshold boolean actually flips, not on every scroll frame.
      const next = y > SCROLL_THRESHOLD;
      if (next !== showFabShared.value) {
        showFabShared.value = next;
        runOnJS(setShowScrollToTop)(next);
      }
      // Same flip-only discipline for the sweep-safety gate.
      const top = y <= SWEEP_SAFE_OFFSET;
      if (top !== atTopShared.value) {
        atTopShared.value = top;
        runOnJS(onAtTopFlip)(top);
      }
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  const renderItem = useCallback(
    ({ item }: { item: FeedListItem }) => (
      <FeedRow
        item={item}
        onPress={openSuggestion}
        onVerdict={onVerdict}
        onAskMera={onAskMera}
        onSaveToggled={onSaveToggled}
        feedbackHandlers={feedbackHandlers}
      />
    ),
    [openSuggestion, onVerdict, onAskMera, onSaveToggled, feedbackHandlers],
  );

  const keyExtractor = useCallback((item: FeedListItem) => item.id, []);

  // ── Empty-state chain (mirrors ForYouScreen.renderEmpty priority) ──
  const hasGeneratedInterests = useForYouHasGeneratedTopics();
  const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();
  // Shared derivation (see components/custom/FeedSyncIndicator) — used here only
  // for the empty-state chain and the header auto-reveal. The header indicator
  // OR-s in the scheduler flag on its own.
  const isFeedProcessing = useIsFeedProcessing();

  // Auto-reveal the header on an error state or while the list is empty
  // (preparing / no interests yet) so the header chrome is never hidden
  // under a collapsed header when the user most needs it — mirrors
  // ForYouScreen's auto-reveal rationale.
  useEffect(() => {
    const isEmptyState =
      data.length === 0 &&
      (!hasGeneratedInterests || isFeedProcessing || lastProcessingRunFinishedAt === null);
    if (errorMessage || isEmptyState) {
      reveal();
    }
  }, [errorMessage, data.length, hasGeneratedInterests, isFeedProcessing, lastProcessingRunFinishedAt, reveal]);

  const renderEmpty = () => {
    if (isLoading) {
      return (
        <Box className="items-center justify-center py-20">
          <Spinner size="large" />
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
        </Box>
      );
    }
    if (!hasGeneratedInterests) {
      return <NoGeneratedInterestsCard />;
    }
    // Caught-up flash guard: only show AllCaughtUpCard once hydrated AND not
    // processing; otherwise the feed is still preparing.
    //
    // A sweep that JUST emptied the list short-circuits it. A force sweep
    // triggers a sync on the same tick, so `isFeedProcessing` is true and this
    // would otherwise tell a user who read everything and pulled to refresh
    // that their feed is being "prepared". The gate is deliberately the recent
    // sweep and NOT "has this device ever built a feed" — the latter also fires
    // on the morning cold start, where the overnight rows aged out of the 24h
    // window and the running sync genuinely will bring content back.
    const justSwept = Date.now() - sweptAtRef.current < SWEPT_EMPTY_GRACE_MS;
    if (!justSwept && (isFeedProcessing || lastProcessingRunFinishedAt === null)) {
      return <FeedPreparingCard />;
    }
    return <AllCaughtUpCard />;
  };

  return (
    <Box className="flex-1 bg-black">
      <Animated.FlatList
        ref={listRef}
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        // Plain JS scroll-end props — they coexist with the reanimated
        // `onScroll` worklet above, which only owns the scroll event itself.
        // Landing buffered dwell marks here keeps the debounce from being the
        // only thing standing between a skip and app termination.
        onMomentumScrollEnd={flushSkips}
        onScrollEndDrag={flushSkips}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={REFRESH_TINT}
            colors={[REFRESH_TINT]}
            // Push the spinner below the absolute collapsing header so it isn't
            // hidden behind it (Android).
            progressViewOffset={headerHeight}
          />
        }
        contentContainerStyle={{
          paddingTop: headerHeight,
          paddingHorizontal: 12,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
          flexGrow: 1,
        }}
        ListEmptyComponent={renderEmpty()}
        // VirtualizedList renders ListFooterComponent unconditionally, so the
        // length guard is required — without it an empty feed stacks this on
        // top of the empty-state chain's own AllCaughtUpCard.
        ListFooterComponent={
          data.length > 0 ? (
            <Box style={{ marginTop: 16 }}>
              <AllCaughtUpCard />
            </Box>
          ) : null
        }
        initialNumToRender={4}
        windowSize={7}
        maxToRenderPerBatch={3}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
      />

      {/* Collapsing header — "For you" heading (top-left) + notification bell
          (top-right), with the 24h stats sentence beneath. Absolute overlay,
          translates up on scroll-down and back on scroll-up / reveal(). */}
      <Animated.View
        onLayout={onHeaderLayout}
        // box-none: the header overlay must not swallow the top-of-list
        // pull-to-refresh gesture — touches pass through its empty area to the
        // FlatList beneath, while its interactive children (the bell) still
        // receive taps. Without this the absolute header intercepted the pull
        // and pull-to-refresh appeared "gone".
        pointerEvents="box-none"
        style={[
          { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: '#000000' },
          headerStyle,
        ]}
      >
        <VStack className="px-5 pb-2" space="xs" style={{ paddingTop: insets.top + 16 }}>
          <HStack className="items-start justify-between">
            <VStack className="flex-1 min-w-0 mr-3">
              <Heading size="3xl" className="text-white" numberOfLines={1}>
                {t('swipeFeed.yourDeck')}
              </Heading>
            </VStack>
            <HStack className="items-center flex-shrink-0" space="sm">
              <NotificationBellButton />
            </HStack>
          </HStack>
          <FeedStatsSentence />

          {/* Shared sync surface — the same indeterminate bar the Dashboard
              shows, plus the offline notice and the re-auth prompt. It goes up
              on the same frame as a pull on EITHER screen. */}
          <FeedSyncIndicator />
        </VStack>
      </Animated.View>

      <ScrollToTopFab
        visible={showScrollToTop}
        onPress={scrollToTop}
        extraBottomOffset={TAB_BAR_HEIGHT}
      />

      {/* One-time "What's new" sheet (carried over from the old feed screen). */}
      <WhatsNewSheet />
    </Box>
  );
};

export default FeedScreen;
