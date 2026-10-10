// FeedScreen — the "Feed" tab (landing tab). A vertical scroll feed of
// personalized story cards, split into a STATIC region the user has already read
// past and a DYNAMIC region below it. The order persists across app restarts.
//
// THE ZIP. New Complete suggestions are still PREPENDED into
// `feed-order-store.order`, but `order` position is only a tie-break WITHIN a
// relevance band — where a row may actually render is decided here, by the
// PINNED PREFIX (`pinnedIds`). The prefix covers every story down to the deepest
// one the user has seen, plus one card of slack: three rows visible ⇒ four
// pinned ⇒ the fifth card is the first dynamic slot. Anything new lands at index
// >= that boundary, sorted among the dynamic region by priority. So the list
// "zips": what you have read stays put in the order you read it, and everything
// below you keeps re-ranking as news arrives. Nothing is ever inserted above the
// reader — which is also why the feed no longer opens mid-list (the old prepend
// moved the viewport by the height of every newly-inserted card).
//
// The prefix is SESSION-ONLY and resets on exactly the two events that re-freeze
// the partition (see `resetSession`).
//
// DISPLAY ORDER (feed-entries.sortFeedEntries) — three attention tiers, all
// inside the dynamic region:
//
//   [ pinned prefix — reading order, mixed tiers, static ]
//   [ tier 0 unseen — high → med → low; new arrivals land here ]
//   [ tier 1 seen but not opened ]
//   [ tier 2 opened ]
//
// The tiers decide ORDER only. There USED to be an AllCaughtUpCard divider
// spliced in at each tier boundary (variant="seen" / "read"), plus a third copy
// of the same component as the end-of-list footer (variant="end") — three
// instances of one component, differing only in headline + instruction line.
// The user reported the in-list dividers' position wasn't reliable (a card
// whose slot moves as new stories arrive and old ones sink reads as broken), so
// both were removed: the list renders nothing at a tier boundary any more.
// Exactly ONE caught-up card remains, always at the very end, under real
// cards (`listFooter`); an empty Feed never shows it (`renderEmpty`). NOTHING is ever removed for being read: a read card
// SINKS to the bottom, so it stays reachable by scrolling on. Cards leave the
// feed by exactly one route: `hydrate` dropping a persisted id whose story aged
// out of the publication window between sessions (FEED_WINDOW_MS).
//
// The end card carries no button: the tabs and the Mera button are the way
// on. The empty states are the counts card plus the shortcuts (FeedShortcuts).
//
// The unviewed/viewed input to that sort is a SNAPSHOT, so a card never sinks
// under the reader mid-session. Together with the pinned prefix it refreshes at
// exactly TWO moments (see `resetSession`): an explicit pull-to-refresh, and
// returning to the app after being away longer than SESSION_RESUME_AFTER_MS —
// including every cold launch, which gets it for free because neither the
// snapshot nor the pin is persisted. Notably NOT on tab blur: opening an article
// blurs this tab, and re-sorting there made the card you just tapped vanish from
// its slot while you were reading it. And notably NOT on a SHORT background
// either — a glance at a notification must not reshuffle the list under a reader
// sitting mid-feed. Both re-sort paths return the list to the top, which is what
// makes a re-sort safe at all.
//
// Pull-to-refresh RESETS TO TOP. That gesture is the one moment the user has
// unambiguously asked for a fresh view, and it is the only moment rows move; the
// reset happens once the re-sorted list has actually committed (see the effect
// on `partitionSnapshot`), because scrolling before the commit just lets
// `maintainVisibleContentPosition` re-anchor and land mid-list again.
//
// Each card carries a small borderless action bar (like / dislike / save /
// share); Ask-Mera lives on the card's rationale block. Tapping a thumb records
// a verdict and opens the shared ••• sheet at that verdict's feedback tree.
// Every one of those interactions — plus opening the card — marks it `viewed`.
// This screen is a place you read, not one you check for arrivals: nothing on
// it counts or announces new stories (no progress bar, no counts sentence, no
// "New stories" pill). New stories are inserted live below the pinned prefix,
// never above the reader.
//
// navx: the Feed is a PAGE of the Feed tab (FeedPages over TabPages). The tab
// owns the header (the page strip), the backdrop and the collapsing-header
// binding; this screen is the list. It is KEEP-MOUNTED in the pager, so its
// reading session (pinned prefix, partition snapshot, row session) survives
// any swipe or reorder, and everything that used to hang off "the tab is
// focused" hangs off `active` (the visible page of the focused tab) instead:
// ingest, the skip flush on leaving, seen marking, the re-tap. The seen band
// is bounded sideways too, so a warm Feed beside Interests marks nothing.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedProcessingCard from '@/components/custom/processing/FeedProcessingCard';
import { useStatsCardItem } from '@/components/custom/for-you/DashboardStatsCard';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import FeedShortcuts from '@/components/custom/feed/FeedShortcuts';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useReasonWriting } from '@/components/custom/cards/use-reason-in-flight';
import { resolveFeedRowDisplay } from '@/components/custom/feed/feed-row-display';
import FeedSkeleton from '@/components/custom/feed/FeedSkeleton';
import { arrivedAtOf, isNewCard, type FeedEntry } from './feed-entries';
import NewCardsGlow from './NewCardsGlow';
import FeedMinimap, { MINIMAP_LIST_INSET } from './FeedMinimap';
import { useFeedScreen } from './useFeedScreen';
import type { CardFeedbackHandlers } from './use-feedback-sheet';
import { Box } from '@/components/ui/box';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import { useFeedOrderStore, type Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';


/** Gap between the collapsing header's bottom edge and the first card.
 *  Matches the Interests page's (`DashboardSectionsFeed`, +12). */
const CONTENT_TOP_GAP = PAGE_CONTENT_GAP;

// ── Arrival transition ──────────────────────────────────────────────────────
//
// ENTERING ONLY. No `exiting` and no `layout` on a list item: a layout
// animation under `maintainVisibleContentPosition` is how the pull-to-refresh
// bug class documented in `for-you/DashboardSectionsFeed.tsx` gets re-opened,
// and the feed is insert-only anyway, so nothing ever leaves mid-session.
//
// It fires for CARDS THAT JUST ARRIVED and for nothing else. A FlatList mounts
// and unmounts cells as the reader scrolls, so an unconditional `entering`
// animates rows that have been in the list for minutes every time they
// re-enter the window, which reads as the feed twitching rather than as
// anything arriving. `arrivingIdsRef` below is the difference.
// FinalMotion "Cards land": a 10pt fade-down, 60 ms apart. Past
// `MOTION.cardsLand.max` rows the stagger stops growing: a full sync can
// prepend dozens, and a linear stagger would leave the last one waiting.
const ARRIVAL = MOTION.cardsLand;
const ARRIVAL_ENTERING = (delay: number) =>
  FadeInDown.duration(ARRIVAL.duration)
    .delay(delay)
    .withInitialValues({ opacity: 0, transform: [{ translateY: -ARRIVAL.rise }] });

/** One rendered feed row. Subscribes to its OWN verdict + opened state so a
 *  verdict/open change re-renders only this row, not the whole list. The action
 *  handlers are the (stable) card-action handlers from `useFeedbackSheet`, which
 *  resolve the suggestion → list-item verdict key via the screen's adapter. */
const FeedRow = React.memo(function FeedRow({
  item,
  suggestion,
  reserveNoteSpace,
  onPress,
  onVerdict,
  onAskMera,
  onSaveToggled,
  feedbackHandlers,
  enterDelay,
  registerRow,
  newSince,
}: {
  item: FeedListItem;
  /** What the card renders: the session-frozen representative's LIVE row
   *  (`resolveFeedRowDisplay`). Never `item.suggestion` directly: the store
   *  re-elects representatives and keeps a stale copy of a row that left the
   *  pool, and neither may show up under the reader. */
  suggestion: ForYouSuggestion;
  /** Reserve the note area's height: this row was pending this session. */
  reserveNoteSpace: boolean;
  onPress: (suggestion: ForYouSuggestion) => void;
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  onAskMera: (suggestion: ForYouSuggestion) => void;
  onSaveToggled: (suggestion: ForYouSuggestion, saved: boolean) => void;
  feedbackHandlers: CardFeedbackHandlers;
  /** ms to hold before this card's arrival transition, or null for no
   *  transition at all — a row that was already here, or a reader who asked
   *  for less motion. */
  enterDelay: number | null;
  /** `useVisibleIndex().registerRow`: the row's view, measured for the
   *  bottom-edge seen rule. Stable per id. */
  registerRow: (id: string) => (node: any) => void;
  /** `lastLeftAt` for this visit; null until known (no halo). */
  newSince: number | null;
}) {
  const verdict = useFeedOrderStore((s) => s.verdicts[item.id]?.verdict ?? null);
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
  const isNew = newSince !== null && isNewCard(arrivedAtOf(suggestion), seen, newSince);
  // Whether "Writing a note" is true right now (reasons in flight, within the
  // backstop). Read here, not in the card: the store must stay out of the card
  // graph.
  const reasonWriting = useReasonWriting(suggestion._id);
  return (
    // The wrapper is UNCONDITIONAL and only `entering` varies, so the tree
    // shape never changes between renders of the same row.
    <Animated.View
      ref={registerRow(item.id)}
      entering={
        enterDelay === null
          ? undefined
          : ARRIVAL_ENTERING(enterDelay)
      }
    >
    <ArticleSuggestionCard
      suggestion={suggestion}
      reasonWriting={reasonWriting}
      reserveNoteSpace={reserveNoteSpace}
      onPress={onPress}
      // No age label and no NEW badge on this screen. "2h ago" and a green NEW
      // pill are both answers to "has something arrived?", which is the
      // question this feed is deliberately not asking. Interests' compact
      // cards keep both, and the article detail screen always shows the time.
      showRecency={false}
      verdict={verdict}
      onVerdict={onVerdict}
      onAskMera={onAskMera}
      onSaveToggled={onSaveToggled}
      feedbackHandlers={feedbackHandlers}
      // Seen stories get ONLY the eye indicator (`read`) — no dimming.
      // Dimming is reserved for a recorded verdict (like/dislike).
      dimmed={verdict != null}
      read={seen}
      halo={isNew}
      flat
    />
    </Animated.View>
  );
});

interface FeedScreenProps {
  /** The visible page of the focused Feed tab (TabPages). */
  readonly active: boolean;
  /** The tab's one collapsing header. */
  readonly header: PageHeaderBinding;
}

const FeedScreen: React.FC<FeedScreenProps> = ({ active, header }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const listEndClearance = useListEndClearance();
  // "Focused" for everything this screen used to gate on the tab: the visible
  // page of the focused tab. Leaving the page is a blur (skips flush, ingest
  // pauses), exactly as switching away from the old Feed tab was.
  const isFocused = useIsFocused() && active;

  const {
    listRef,
    listData,
    liveById,
    rowSessionRef,
    arrivingIdsRef,
    arrivalMotion,
    newSince,
    registerRow,
    viewabilityConfigCallbackPairs,
    onScrollToIndexFailed,
    onScroll,
    flushSkips,
    refreshing,
    onRefresh,
    openSuggestion,
    onVerdict,
    onAskMera,
    onSaveToggled,
    feedbackHandlers,
    warmup,
    isLoading,
    errorMessage,
    noFacts,
    isFeedProcessing,
    lastProcessingRunFinishedAt,
    emptyHere,
    hasRows,
    minimapOn,
    minimapRows,
    minimapFirst,
    minimapLast,
    jumpToRow,
    glowOn,
    headerHeight,
    windowHeight,
  } = useFeedScreen({ isFocused, header });

  const renderItem = useCallback(
    ({ item, index }: { item: FeedEntry; index: number }) => {
      const display = resolveFeedRowDisplay(item, liveById, rowSessionRef.current);
      return (
      <FeedRow
        item={item}
        suggestion={display.suggestion}
        reserveNoteSpace={display.reserveNoteSpace}
        onPress={openSuggestion}
        onVerdict={onVerdict}
        onAskMera={onAskMera}
        onSaveToggled={onSaveToggled}
        feedbackHandlers={feedbackHandlers}
        enterDelay={
          arrivalMotion && arrivingIdsRef.current.has(item.id)
            ? Math.min(index, ARRIVAL.max - 1) * ARRIVAL.stagger
            : null
        }
        registerRow={registerRow}
        newSince={newSince}
      />
      );
    },
    [openSuggestion, onVerdict, onAskMera, onSaveToggled, feedbackHandlers, arrivalMotion, registerRow, liveById, newSince],
  );

  const keyExtractor = useCallback((item: FeedEntry) => item.id, []);

  // End-of-feed marker — the ONLY caught-up card left (see the header comment):
  // no in-list dividers any more, just this footer.
  //
  // Gated on a non-empty list because FlatList renders `ListFooterComponent`
  // even when `data` is empty, and an empty Feed shows the counts card and the
  // shortcuts instead (`renderEmpty`).
  const listFooter = useMemo(
    () =>
      listData.length > 0 ? (
        <Box style={{ marginTop: 16 }} testID="feed-caught-up-footer">
          <AllCaughtUpCard />
        </Box>
      ) : null,
    [listData.length],
  );


  const renderEmpty = () => {
    if (warmup === 'blank') return null;
    if (warmup === 'skeleton') return <FeedSkeleton />;
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
          <Icon as={AlertCircleIcon} size="xl" className="text-negative mb-3" />
          <Text size="md" className="text-negative text-center font-semibold mb-1">
            {t('errors.failedToLoad')}
          </Text>
          <Text size="sm" className="text-ink-3 text-center">
            {errorMessage}
          </Text>
        </Box>
      );
    }
    // No facts: the block sits in the list header (above any top headlines,
    // C4), so the empty list itself says nothing more.
    if (noFacts) return null;
    // Nothing to show (FinalFeed "Feed, empty after a long gap"): the counts
    // card (the list's first item, collapsed: `emptyHere` below) says which state
    // this is; the list shows the shortcuts. They fold away when the first rows
    // land. The first run after setup (no run has finished) keeps the
    // processing scene.
    if (lastProcessingRunFinishedAt !== null) {
      return (
        <Animated.View exiting={FadeOut.duration(200)}>
          <FeedShortcuts reading={isFeedProcessing} />
        </Animated.View>
      );
    }
    return (
      <>
        <FeedProcessingCard />
        <FeedShortcuts reading />
      </>
    );
  };

  // The list's first item: the no-facts block, or the counts card.
  const cardItem = useStatsCardItem(emptyHere, hasRows);
  const headerNode = useMemo(() => (noFacts ? <FeedNoFacts view="continuous" /> : cardItem), [noFacts, cardItem]);

  return (
    // No backdrop and no header: the tab (TabPages) draws both.
    <Box className="flex-1" testID="feed-screen">
      <Animated.FlatList
        ref={listRef}
        testID="feed-list"
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        onScrollToIndexFailed={onScrollToIndexFailed}
        // Anchoring is now a HEIGHT-CHANGE guard, not an insertion guard: the
        // pinned prefix means nothing is ever inserted above the deepest row the
        // user has seen, but rows still CHANGE HEIGHT above the viewport (images
        // decoding, the TranslatableDynamic original→translated title swap
        // re-wrapping), and without an anchor each of those shifts content under
        // the reader. Removing it outright would trade a fixed jump for an
        // intermittent one, which is worse because it is unreproducible.
        //
        // `autoscrollToTopThreshold` is what fixes "the feed opens mid-list", and
        // the cause is NOT what it looks like. It is not the store's prepend —
        // measured on the resident device, the drop was still exactly 561px with
        // the pinned prefix already active and provably suppressing insertion.
        // It is the INITIAL LAYOUT: cell 0 changes height after it first mounts,
        // so the first *visible* row is really row 1; when row 0 then grows to
        // its true height, plain anchoring faithfully holds row 1 in place and
        // the content slides down by exactly one card. Hence the signature:
        // drop == one card height + the header padding, present in the very
        // first frame, identical on every launch. (The measurement blamed the
        // hero image decoding; the hero is a fixed `h-48` box now, so the
        // growth left is text: the title's translation swap and the reason
        // landing. The launch skeleton in use-feed-warmup also removes the
        // empty-to-populated swap that used to happen under this anchor.)
        //
        // This threshold says "if the adjustment happens while within 100px of
        // the top, go to the top instead of holding". The Feed omitted it before
        // because it would yank a reader of the very first card up to a new top —
        // but with the pin, nothing is inserted above the reader any more, so it
        // can now only fire at the top, which is precisely where we want it.
        // The two changes are a pair: this is unsafe without the pin.
        //
        // NEVER while the list has no rows (a new account: title row, empty
        // block, maybe headlines in the header only). With nothing to anchor,
        // iOS's MVCP adjust set the offset, the scroll worklet re-laid the
        // header, the next mount adjusted again: a main-thread loop at 100%
        // CPU with the list never drawn (captured, navx2).
        maintainVisibleContentPosition={
          listData.length > 0 ? { minIndexForVisible: 0, autoscrollToTopThreshold: 100 } : undefined
        }
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
        onContentSizeChange={active ? notifyScrollTick : undefined}
        refreshControl={
          <RefreshControl
            testID="feed-refresh"
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            // Push the spinner below the absolute collapsing header so it isn't
            // hidden behind it (Android).
            progressViewOffset={headerHeight}
          />
        }
        contentContainerStyle={{
          // `headerHeight` alone puts the first card flush against the header's
          // bottom edge — on a fresh launch the top card reads as if it is part
          // of the header. Interests (+12) and World (+8) carry the same
          // kind of gap; matching Interests keeps the Feed tab's pages
          // identical at the top.
          paddingTop: headerHeight + CONTENT_TOP_GAP,
          // Sides set separately, never with paddingHorizontal: the minimap
          // inset must not depend on which of the two Yoga lets win. The
          // minimap's left reserve applies only while the minimap is drawn
          // (setting on AND rows to show); otherwise both sides are equal.
          paddingLeft: minimapOn ? MINIMAP_LIST_INSET : PAGE_SIDE_INSET,
          paddingRight: PAGE_SIDE_INSET,
          // Clear of the Mera button (derived; see tab-bar.ts).
          paddingBottom: listEndClearance,
          flexGrow: 1,
        }}
        ListHeaderComponent={headerNode}
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={listFooter}
        initialNumToRender={4}
        // 7 → 5 (Area B). Feed cards are tall — roughly one per screen — so 7
        // screens of retained cells is far more than scrolling needs, and every
        // retained cell holds a decoded image. Tuned against the POST-divider
        // geometry deliberately: the sentinel rows changed both the row count and
        // the mix of row heights, so measuring this earlier would have tuned a
        // list that no longer exists.
        //
        // REVERT CONDITION (Area B's, kept verbatim in intent): if blank cells
        // appear during fast scrolling, or the anchored row shifts on ingest, put
        // this back to 7 rather than compensating with the other three props.
        // It is one line precisely so the revert is one line.
        windowSize={5}
        maxToRenderPerBatch={3}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={false}
      />
      {/* After the list, so the list stays the first child. */}
      <NewCardsGlow visible={glowOn} />
      {minimapOn ? (
        <FeedMinimap
          rows={minimapRows}
          newSince={newSince}
          first={minimapFirst}
          last={minimapLast}
          top={headerHeight + CONTENT_TOP_GAP}
          bottom={windowHeight - listEndClearance}
          onJump={jumpToRow}
        />
      ) : null}
    </Box>
  );
};

export default FeedScreen;
