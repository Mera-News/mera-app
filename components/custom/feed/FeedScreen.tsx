// FeedScreen — the "Feed" tab (landing tab). A static, insert-only vertical
// scroll feed of personalized story cards. The candidate set is insert-only:
// new Complete suggestions are PREPENDED into `feed-order-store.order` and
// `maintainVisibleContentPosition` anchors the viewport, so the list grows
// without moving the card being read. The order persists across app restarts.
//
// DISPLAY ORDER (feed-entries.sortFeedEntries): unviewed high → medium → low,
// then viewed high → medium → low, in one continuous run. There is no
// "All Caught Up" DIVIDER — nothing partitions the list mid-scroll — but the
// same card does render once as a static end-of-list FOOTER
// (`ListFooterComponent`, testID `feed-caught-up-footer`) so the feed's end is
// explicit. The footer is display-only: no lifecycle meaning, and no card ever
// moves across it. NOTHING is ever removed for being read: a viewed card SINKS,
// so it stays reachable by scrolling on. Cards leave the feed by exactly one
// route: `hydrate` dropping a persisted id whose story aged out of the
// publication window between sessions (FEED_WINDOW_MS).
//
// The unviewed/viewed input to that sort is a SNAPSHOT, so a card never sinks
// under the reader mid-session. It refreshes at exactly TWO moments: app launch,
// and an explicit pull-to-refresh. Notably NOT on tab blur — opening an article
// blurs this tab, and re-sorting there made the card you just tapped vanish from
// its slot while you were reading it. And notably NOT on app-background either:
// a re-sort on the next foreground would reshuffle the list under a reader
// sitting mid-feed, with no scroll compensation.
//
// Pull-to-refresh RESETS TO TOP. That gesture is the one moment the user has
// unambiguously asked for a fresh view, and it is the only moment rows move; the
// reset happens once the re-sorted list has actually committed (see the effect
// on `partitionSnapshot`), because scrolling before the commit just lets
// `maintainVisibleContentPosition` re-anchor and land mid-list again.
//
// Each card carries a small borderless action bar (like / dislike / save /
// share); Ask-Mera lives on the card's rationale block. Tapping a thumb records
// a verdict and reveals the card's inline feedback surface
// (CardFeedbackSurface). Every one of those interactions — plus opening the card
// — marks it `viewed`.
// The header is the "Feed" heading + notification bell + 24h stats sentence.

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import {
  GLASS_AVAILABLE,
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GlassPlate,
} from '@/components/custom/GlassSurface';
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
import StatusBarScrim from '@/components/custom/StatusBarScrim';
import { scrollToTopWithRetry } from './scroll-to-top-with-retry';
import { useVisibleIndex } from './use-visible-index';
import { useFeedFunnelLog } from './use-feed-funnel-log';
import {
  sortFeedEntries,
  countUnviewed,
  type FeedEntry,
} from './feed-entries';
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
import { useTabPressScrollRefresh } from '@/lib/hooks/use-tab-press-scroll-refresh';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import {
  buildFeedList,
  type FeedListItem,
} from '@/lib/stores/feed-list-selector';
import {
  useFeedOrderStore,
  type CardStateRecord,
  type Verdict,
} from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useDatabaseReady } from '@/lib/stores/database-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import {
  useForYouHasGeneratedTopics,
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
} from '@/lib/stores/selectors';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, RefreshControl, StyleSheet, View } from 'react-native';
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
  // NOT `path.length > 0` — a branch descent writes a path and commits nothing.
  const committed = useFeedOrderStore((s) => !!s.verdicts[item.id]?.committed);
  const surfaceClosed = useFeedbackDismissedStore((s) => !!s.dismissed[item.id]);
  // ONE predicate decides both the read indicator and which block of the sort
  // this card lands in — otherwise a card could show the read state while
  // sitting among the unviewed. Note `articleIds`, not the union `ids`: a
  // stableClusterId match would mark a brand-new article as read because a
  // DIFFERENT article in the same ongoing story was opened.
  const openedExactly = useOpenedStoriesStore((s) => {
    const articleId = item.suggestion.articleId;
    return !!articleId && s.articleIds.has(articleId);
  });
  const hasCardState = useFeedOrderStore((s) => !!s.cardStates[item.id]);
  const seen = openedExactly || hasCardState;
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
      feedbackCommitted={committed}
      feedbackHandlers={feedbackHandlers}
      // Seen stories get ONLY the eye indicator (`read`) — no dimming.
      // Dimming is reserved for a recorded verdict (like/dislike).
      dimmed={verdict != null}
      read={seen}
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
  const { viewabilityConfigCallbackPairs, flushSkips } = useVisibleIndex();

  // ── Scroll-to-top FAB ── The list ref forwards to the underlying FlatList
  // (Animated.createAnimatedComponent), so scrollToOffset is available. The
  // visibility boolean is driven from the scroll worklet (below) but only
  // crosses the JS bridge when it actually flips (showFabShared guard).
  const listRef = useRef<Animated.FlatList<FeedEntry>>(null);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const showFabShared = useSharedValue(false);
  // Raw offset mirror, updated on every scroll frame (see tickHandler below) —
  // UI-thread only, no bridge crossing, no re-render. This exists solely so
  // `scrollToTop` can tell "the call landed" from "it didn't" (see below);
  // `showFabShared` only tracks the threshold boolean, not the offset itself.
  const lastOffsetShared = useSharedValue(0);
  const scrollToTop = useCallback(() => {
    scrollToTopWithRetry(listRef, () => lastOffsetShared.value);
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

  // ── Sort snapshot ──
  // The unviewed/viewed input to the sort is a SNAPSHOT of card state, never the
  // live store. Marking a card viewed-by-dwell mid-scroll would otherwise sink it
  // while the user is looking at it, closing the list up behind it — and that
  // fires on every scroll-stop. The snapshot refreshes at exactly two moments:
  // first hydrate, and pull-to-refresh (which also resets the scroll to the top).
  const [partitionSnapshot, setPartitionSnapshot] = useState<{
    cardStates: Record<string, CardStateRecord>;
    openedArticleIds: Set<string>;
  }>(() => ({ cardStates: {}, openedArticleIds: new Set() }));

  const refreshPartitionSnapshot = useCallback(() => {
    setPartitionSnapshot({
      cardStates: useFeedOrderStore.getState().cardStates,
      openedArticleIds: useOpenedStoriesStore.getState().articleIds,
    });
  }, []);

  // Seed once BOTH stores are hydrated — deliberately not inside `hydrate`,
  // which resolves before the opened store has loaded. Seeding there would
  // snapshot an empty `articleIds` and leave every previously-opened card in the
  // unviewed block for the whole first session, until the first pull-to-refresh.
  const didSeedSnapshot = useRef(false);
  useEffect(() => {
    if (!orderHydrated || !openedHydrated || didSeedSnapshot.current) return;
    didSeedSnapshot.current = true;
    refreshPartitionSnapshot();
  }, [orderHydrated, openedHydrated, refreshPartitionSnapshot]);

  // Flush buffered dwell marks when the user leaves the tab. FLUSH ONLY — it
  // must NOT re-sort. Opening a card pushes the detail screen, which blurs this
  // tab, so re-sorting here meant every article you read had already sunk by the
  // time you came back: you tapped a card and returned to find it gone from
  // where you were. That is the precise behaviour this redesign exists to remove.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    const was = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (!isFocused && was) flushSkips();
  }, [isFocused, flushSkips]);

  // App background: persist, but deliberately do NOT re-sort ('background' only —
  // iOS also fires 'inactive' for the app switcher and Control Centre). A
  // background re-sort lands on the next foreground, reshuffling the list under a
  // reader who is sitting mid-feed with no scroll compensation — the same
  // "where did my place go?" jump that pull-to-refresh had to be fixed for.
  // Pull-to-refresh is the ONLY re-sort, and it resets the scroll to the top.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background') return;
      flushSkips();
      useFeedOrderStore.getState().flushPersist();
    });
    return () => sub.remove();
  }, [flushSkips]);

  // Insert newly-Complete candidates while the tab is active. They are PREPENDED
  // (see feed-order-store) and the list is anchored by
  // `maintainVisibleContentPosition`, so an insert above the reader does not move
  // the card being read. `articleIds`, not the union set — see
  // opened-stories-store.
  useEffect(() => {
    if (!isFocused || !orderHydrated || !openedHydrated) return;
    useFeedOrderStore
      .getState()
      .ingest(candidates, useOpenedStoriesStore.getState().articleIds);
  }, [candidates, isFocused, orderHydrated, openedHydrated]);

  const data = useMemo(
    () => order.map((id) => itemsById[id]).filter((it): it is FeedListItem => !!it),
    [order, itemsById],
  );

  // Display list: unviewed (high → med → low), then viewed (high → med → low),
  // one continuous run. Nothing is ever removed; a viewed card sinks, it does not
  // disappear. Empty when there are no stories, so the empty-state chain renders.
  const listData = useMemo(
    () =>
      sortFeedEntries(
        data,
        partitionSnapshot.cardStates,
        partitionSnapshot.openedArticleIds,
      ),
    [data, partitionSnapshot],
  );

  // How many rows sit in the unviewed block. No longer a rendered boundary — the
  // funnel diagnostic still reports the split as its `dividerIdx`.
  const unviewedCount = useMemo(
    () =>
      countUnviewed(
        listData,
        partitionSnapshot.cardStates,
        partitionSnapshot.openedArticleIds,
      ),
    [listData, partitionSnapshot],
  );

  // DEV-only Metro log of the whole funnel + the rendered cards. Compiled out of
  // release builds; throttled and count-gated in dev (see the hook).
  useFeedFunnelLog(listData, unviewedCount, userGeoLanguageCtx);

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
    getCommitted: (key) => !!useFeedOrderStore.getState().verdicts[key]?.committed,
    setCommitted: (key, committed) =>
      useFeedOrderStore.getState().setCommitted(key, committed),
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
  const { refreshing, onRefresh: onRefreshSync } = useFeedSyncRefresh(reveal);

  // Pull-to-refresh is the explicit "tidy up now" gesture — the one moment the
  // user has unambiguously asked for a fresh view, and the ONLY moment rows are
  // allowed to move. Re-sorting runs even when the sync itself early-returns
  // (offline, paused): it only REORDERS what is already on screen, so there is
  // nothing to be starved of. Nothing is discarded either way.
  const pendingScrollResetRef = useRef(false);
  const onRefresh = useCallback(() => {
    flushSkips();
    pendingScrollResetRef.current = true;
    refreshPartitionSnapshot();
    onRefreshSync();
  }, [flushSkips, refreshPartitionSnapshot, onRefreshSync]);

  // Re-tap the Feed tab icon → scroll to top; tap again at the top → refresh.
  // Deliberately the SAME `onRefresh` the RefreshControl below calls, not
  // `onRefreshSync` and not the scheduler: routing around it would skip
  // flushSkips + the partition-snapshot refresh, and a scheduler-level call can
  // be swallowed by conditions that only gate the SCHEDULED path.
  useTabPressScrollRefresh({
    listRef,
    getOffset: () => lastOffsetShared.value,
    onRefresh,
    isRefreshing: refreshing,
  });

  // Reset to the top AFTER the re-sorted list has committed. Scrolling inside
  // `onRefresh` would run before the snapshot state lands, letting
  // `maintainVisibleContentPosition` re-anchor on the reshuffled content
  // afterwards — which is exactly how a refresh from the top used to dump the
  // user 1300–2000px down the feed. `animated: false`, because an animated
  // scroll racing the re-layout produces the same mid-list landing.
  //
  // The extra `requestAnimationFrame` is not superstition: a scrollToOffset
  // issued in the same frame as this re-layout is already known to be
  // dropped. The scroll-to-top FAB hits the same CLASS of drop from a wider
  // window — not this same frame (it's only reachable well after this reset,
  // once the user has scrolled back down past SCROLL_THRESHOLD; the leading
  // suspect for the wider window is `ingest` prepending post-refresh sync
  // results while the user is scrolled down, each prepend re-triggering
  // `maintainVisibleContentPosition`'s anchor adjustment, though that trigger
  // isn't proven, only the drop itself is) — see `scrollToTopWithRetry` in
  // ./scroll-to-top-with-retry.ts, which verifies the scroll landed and
  // retries once if not, rather than trying to name the exact cause. One
  // frame here is imperceptible with the spinner still up.
  useEffect(() => {
    if (!pendingScrollResetRef.current) return;
    pendingScrollResetRef.current = false;
    // Deliberately NO cleanup cancelling this frame. An effect cleanup runs
    // before EVERY re-run, not just unmount, and the flag above is already
    // consumed — so an ingest landing in the next tick would cancel the reset
    // and nothing would ever reschedule it. The `?.` guard makes a post-unmount
    // callback a no-op, which is the only case cancelling would have bought.
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [partitionSnapshot, listData]);

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport) —
  // mirrors DashboardSectionsFeed's composition.
  const tickHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      runOnJS(notifyScrollTick)();
      // Mirror the raw offset every frame — cheap (UI thread, no bridge
      // crossing, no re-render) and lets `scrollToTop` verify its own call.
      lastOffsetShared.value = e.contentOffset.y;
      // Toggle the scroll-to-top FAB — cross the JS bridge only when the
      // threshold boolean actually flips, not on every scroll frame.
      const next = e.contentOffset.y > SCROLL_THRESHOLD;
      if (next !== showFabShared.value) {
        showFabShared.value = next;
        runOnJS(setShowScrollToTop)(next);
      }
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

  const renderItem = useCallback(
    ({ item }: { item: FeedEntry }) => (
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

  const keyExtractor = useCallback((item: FeedEntry) => item.id, []);

  // End-of-feed marker. A static FOOTER after the last card — deliberately NOT
  // the mid-list divider that was removed: it never partitions the list, carries
  // no lifecycle meaning, and no card ever moves across it, so the sort and the
  // viewed/unviewed blocks are untouched.
  //
  // Gated on a non-empty list because FlatList renders `ListFooterComponent`
  // even when `data` is empty — without this, the zero-item case would show the
  // AllCaughtUpCard twice (the empty-state chain in `renderEmpty` already owns
  // that case, and still does).
  const listFooter = useMemo(
    () =>
      listData.length > 0 ? (
        <Box style={{ marginTop: 16 }} testID="feed-caught-up-footer">
          <AllCaughtUpCard />
        </Box>
      ) : null,
    [listData.length],
  );

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
        <Box className="items-center justify-center py-20" testID="feed-loading">
          <Spinner size="large" />
        </Box>
      );
    }
    if (errorMessage) {
      return (
        <Box className="items-center justify-center py-20 px-6" testID="feed-error">
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
    // on the morning cold start, where the overnight rows aged out of the
    // window and the running sync genuinely will bring content back.
    if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
      return <FeedPreparingCard />;
    }
    return <AllCaughtUpCard />;
  };

  return (
    // No `bg-black`: the AbstractGradientBackdrop below is the page background.
    <Box className="flex-1" testID="feed-screen">
            {/* App-wide tab background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

      <Animated.FlatList
        ref={listRef}
        testID="feed-list"
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        // The list GROWS UPWARD: new cards are prepended (feed-order-store),
        // and this anchors the first visible row so the card being read stays
        // visually fixed while its index changes. Deliberately WITHOUT the
        // Dashboard's `autoscrollToTopThreshold` — that would yank a user
        // reading the very first card up to the new top, which is the exact
        // behaviour this removes. Anchoring must be unconditional.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        // Plain JS scroll-end props — they coexist with the reanimated
        // `onScroll` worklet above, which only owns the scroll event itself.
        // Landing buffered dwell marks here keeps the debounce from being the
        // only thing standing between a skip and app termination.
        onMomentumScrollEnd={flushSkips}
        onScrollEndDrag={flushSkips}
        // Initial visibility tick. TranslatableDynamic only resolves its
        // on-screen check when something tells it to re-measure, and on a fresh
        // cell `measureInWindow` can return without ever invoking its callback —
        // so without this the FIRST tick was the user's first scroll, and every
        // title visibly swapped from original to translated (changing its wrap
        // height) at that moment. Content-size changes fire on mount and on
        // every prepend; `notifyScrollTick`'s 150ms trailing throttle coalesces
        // the burst. Plain JS prop — independent of the reanimated `onScroll`.
        onContentSizeChange={notifyScrollTick}
        refreshControl={
          <RefreshControl
            testID="feed-refresh"
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
        ListFooterComponent={listFooter}
        initialNumToRender={4}
        windowSize={7}
        maxToRenderPerBatch={3}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
      />

      {/* Status-bar scrim — covers the Dynamic Island/clock/battery region so
          content is never visible behind it once the collapsing header below
          translates away on scroll-down. Sits above the list, below the
          header (zIndex 10). */}
      <StatusBarScrim />

      {/* Collapsing header — "For you" heading (top-left) + notification bell
          (top-right), with the 24h stats sentence beneath. Absolute overlay,
          translates up on scroll-down and back on scroll-up / reveal(). */}
      <Animated.View
        testID="feed-header"
        onLayout={onHeaderLayout}
        // box-none: the header overlay must not swallow the top-of-list
        // pull-to-refresh gesture — touches pass through its empty area to the
        // FlatList beneath, while its interactive children (the bell) still
        // receive taps. Without this the absolute header intercepted the pull
        // and pull-to-refresh appeared "gone".
        pointerEvents="box-none"
        style={[
          { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
          // Liquid Glass on iOS 26+, flat black everywhere else. The opaque
          // background is REMOVED (not layered under the plate) where glass
          // paints — a solid fill over glass cancels it entirely. Where glass
          // does not paint, `GlassPlate` renders nothing, so dropping the
          // background too would leave an invisible header over the scrolling
          // list; hence the explicit fallback.
          GLASS_AVAILABLE
            ? {
                // The scrim paints BEHIND the plate, so it is what the glass
                // samples — that is what actually cuts the see-through. A
                // translucent dark layer, NOT an opaque fill: an opaque fill
                // here would cancel the glass entirely (see GlassSurface).
                backgroundColor: GLASS_HEADER_SCRIM,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: 'rgba(255,255,255,0.10)',
              }
            : { backgroundColor: '#000000' },
          headerStyle,
        ]}
      >
        {/* Absolute-fill glass. This Animated.View is unpadded (all padding
            lives on the VStack below), which is exactly what GlassPlate's
            parent must be — see GlassSurface. No corner radius here, so no
            `overflow: 'hidden'`: the header is full-bleed and clipping would
            only risk cutting off the bell's badge. */}
        <GlassPlate tint={GLASS_HEADER_TINT} />
        {/* PULL-TO-REFRESH PASSTHROUGH — see the matching note in ForYouScreen.
            `box-none` on the header wrapper leaves its CHILDREN touchable, and
            each row here is a full-width plain View, so every row is an opaque
            band that can swallow a downward pan before it reaches the list. This
            header is short enough that a pull usually starts below it — which is
            why the bug surfaced on the Dashboard first — but the defect is the
            same, so the same rule applies: non-interactive rows are
            `pointerEvents="none"`, rows merely CONTAINING a control are
            `box-none`, only real controls are `auto`. */}
        <VStack
          className="px-5 pb-2"
          space="xs"
          pointerEvents="box-none"
          style={{ paddingTop: insets.top + 16 }}
        >
          <HStack className="items-start justify-between" pointerEvents="box-none">
            <VStack className="flex-1 min-w-0 mr-3" pointerEvents="none">
              <Heading size="3xl" className="text-white" numberOfLines={1}>
                {t('swipeFeed.yourDeck')}
              </Heading>
            </VStack>
            <HStack className="items-center flex-shrink-0" space="sm" pointerEvents="box-none">
              <NotificationBellButton />
            </HStack>
          </HStack>
          <View pointerEvents="none">
            {/* Brighter + a little heavier than the muted body step: this line
                sits on glass with content moving under it, where
                typography-400 was barely legible. `leading-6` is repeated
                because the prop REPLACES FeedStatsSentence's default class
                string rather than merging with it. */}
            <FeedStatsSentence className="text-typography-700 font-medium leading-6" />
          </View>

          {/* Shared sync surface — the same indeterminate bar the Dashboard
              shows, plus the offline notice and the re-auth prompt. It goes up
              on the same frame as a pull on EITHER screen. */}
          <View pointerEvents="box-none">
            <FeedSyncIndicator />
          </View>
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
