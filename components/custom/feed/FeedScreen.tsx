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

import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import FeedProcessingCard from '@/components/custom/processing/FeedProcessingCard';
import {
  useFeedSyncRefresh,
  useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import { setEmptyWantsCard } from '@/components/custom/for-you/feed-status-card';
import { useStatsCardItem } from '@/components/custom/for-you/DashboardStatsCard';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useFeedModeAnnouncement } from '@/components/custom/for-you/use-feed-mode-announcement';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import FeedShortcuts from '@/components/custom/feed/FeedShortcuts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { useReasonWriting } from '@/components/custom/cards/use-reason-in-flight';
import {
  displayedSuggestionOf,
  newFeedRowSession,
  resolveFeedRowDisplay,
  type FeedRowSession,
} from '@/components/custom/feed/feed-row-display';
import FeedSkeleton from '@/components/custom/feed/FeedSkeleton';
import { useSessionGeoLanguageContext } from '@/components/custom/feed/use-session-geo-context';
import { useFeedWarmup } from '@/components/custom/feed/use-feed-warmup';
import { useVisibleIndex } from './use-visible-index';
import { useFeedFunnelLog } from './use-feed-funnel-log';
import {
  sortFeedEntries,
  countUnviewed,
  extendPinnedIds,
  isAwaitingNote,
  arrivedAtOf,
  deriveLastLeftAt,
  isNewCard,
  type FeedEntry,
} from './feed-entries';
import NewCardsGlow from './NewCardsGlow';
import FeedMinimap, { MINIMAP_LIST_INSET } from './FeedMinimap';
import { useFeedMinimap } from './feed-view-prefs';
import {
  useFeedbackSheet,
  type CardFeedbackHandlers,
  type VerdictStoreAdapter,
} from './use-feedback-sheet';
import { Box } from '@/components/ui/box';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import {
  buildFeedList,
  type FeedListItem,
} from '@/lib/stores/feed-list-selector';
import {
  useFeedOrderStore,
  type CardStateRecord,
  type Verdict,
} from '@/lib/stores/feed-order-store';
import { useForYouSuggestionsHydrated, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useDatabaseReady } from '@/lib/stores/database-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { useMotionAllowed } from '@/lib/motion-gate';
import {
  useForYouLastProcessingRunFinishedAt,
  useForYouSuggestions,
} from '@/lib/stores/selectors';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, AppState, RefreshControl, View, useWindowDimensions } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Animated, {
  FadeInDown,
  FadeOut,
  runOnJS,
  useAnimatedScrollHandler,
  useComposedEventHandler,
  useSharedValue,
} from 'react-native-reanimated';
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

// "New" cards (FinalFeed #10-11): arrived on this phone after the reader last
// left the Feed list, and not seen yet. Memory only, kept across a remount (a
// view switch, a session reset): stamped when the list stops being active,
// and derived from the newest seen-mark the first time (feed-entries).
let lastLeftAtMs: number | null = null;
/** "New stories below" is announced once per app session. */
let announcedNewBelow = false;
/** How long an id stays eligible after its commit. Comfortably past the last
 *  staggered start, and short enough that scrolling back to a row minutes later
 *  never re-animates it. */
const ARRIVAL_ELIGIBLE_MS = 600;

/** How long the app must be BACKGROUNDED before coming back counts as a new
 *  reading session (re-freeze the partition, drop the pinned prefix, return to
 *  the top). Protects a mid-read user: glancing at a notification, taking a
 *  call, or checking another app for a moment must not reshuffle the list and
 *  throw away where they were. Duration is the ONLY condition — deliberately not
 *  also gated on "new content arrived". */
const SESSION_RESUME_AFTER_MS = 5 * 60 * 1000;

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

export interface FeedScreenProps {
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

  const { isLoading, errorMessage } = useFeedBootstrap();

  // Reduce Motion, or the app's own "Static background", which already defaults
  // ON below 6 GB of RAM. Either one means an arriving card simply appears:
  // instant, no stagger, nothing to wait through. Same pair the processing
  // area and the tutorial heroes read, and the same one-liner
  // `AbstractGradientBackdrop` established.
  const arrivalMotion = useMotionAllowed();

  // The tab's collapsing header (TabPages): this list drives it while active.
  const { scrollHandler, headerHeight, reveal, hidden: headerHidden } = header;

  // ── Live inputs ──
  const suggestions = useForYouSuggestions();
  const suggestionsHydrated = useForYouSuggestionsHydrated();

  // The user's geo/language context (home/other countries + app language) —
  // makes representative election tier-aware. Null while loading/on failure,
  // which `buildFeedList` treats as the legacy geo/language-blind pick.
  // Frozen per reading session (see use-session-geo-context): a publication
  // preference written from a card's ••• sheet must not regroup and re-sort
  // the stories under the reader. `sessionEpoch` is bumped by `resetSession`.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const userGeoLanguageCtx = useSessionGeoLanguageContext(useUserGeoLanguageContext(), sessionEpoch);

  // ONE subscription for "a run is really downloading, grouping and scoring"
  // (`isFeedProcessing`, NEVER `statusMode === 'processing'`, which also goes
  // true for every five-minute poll that finds nothing).
  const narrating = useIsFeedProcessing();
  const statusMode = useFeedStatusMode();
  // The screen announces entering the capped or error state (see the hook).
  useFeedModeAnnouncement(statusMode);
  // The end of a sync is said once, never as a live region (the header
  // narration that used to carry it is gone with the header).
  const wasNarrating = useRef(narrating);
  useEffect(() => {
    if (wasNarrating.current && !narrating && isFocused) {
      AccessibilityInfo.announceForAccessibility(t('feedStatus.syncDoneA11y'));
    }
    wasNarrating.current = narrating;
  }, [narrating, isFocused, t]);

  // Candidates keep opened items in (they back frozen rows + survive hydrate) —
  // no exclusion here; opened-filtering happens only for NEW ids in ingest.
  //
  // The Feed also admits scored rows whose note is still being written
  // (`includeReasonPending`): articles whose relevance arrived in the
  // background are readable at once, and the card says "Writing a note".
  const candidates = useMemo(
    () =>
      buildFeedList(suggestions, EMPTY_SET, Date.now(), userGeoLanguageCtx, {
        includeReasonPending: true,
      }),
    [suggestions, userGeoLanguageCtx],
  );
  // Live rows by suggestion id, for `resolveFeedRowDisplay` (see FeedRow).
  const liveById = useMemo(() => new Map(suggestions.map((s) => [s._id, s])), [suggestions]);

  // Per-session row display state: each row's frozen representative and
  // whether it has been pending (feed-row-display.ts). Replaced wholesale in
  // `resetSession`.
  const rowSessionRef = useRef<FeedRowSession>(newFeedRowSession());
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // ── Persisted order store (reactive) ──
  const order = useFeedOrderStore((s) => s.order);
  const itemsById = useFeedOrderStore((s) => s.itemsById);
  const orderHydrated = useFeedOrderStore((s) => s.hydrated);
  const openedHydrated = useOpenedStoriesStore((s) => s.hydrated);

  // ── Pinned prefix (the static region) ──
  // `pinnedIds` is the exact rendered prefix the user has already read past,
  // top-to-bottom. New arrivals are never in it, so they can only render below
  // it — that is what makes the store's `unshift` un-observable above the
  // reader, and why the feed no longer opens mid-list.
  //
  // SESSION-ONLY, deliberately not persisted: it resets on a session resume, and
  // a cold launch IS a resume, so a persisted value would be discarded on the
  // very next read. Persisting would buy nothing and add a corrupt-blob surface.
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>([]);
  // Live mirror of the rendered STORY order for the viewability tracker. Created
  // once (stable identity) because the tracker's callbacks are frozen at mount.
  const renderedIdsRef = useRef<readonly string[]>([]);
  // Live mirror of the rendered story rows, so the ingest effect can extend the
  // pin from the PRE-ingest list without depending on `listData` (which would
  // re-run the effect on every re-sort).
  const listDataRef = useRef<FeedListItem[]>([]);

  // ── Freeze boundary + skip dwell (viewability → refs only; no store/DB
  //    writes mid-scroll). `FeedRow` subscribes to the opened set per row for
  //    its own eye indicator, so the screen deliberately does NOT — that used
  //    to re-render the entire list on every markOpened. ──
  // ux2 B2: a card is SEEN only while its bottom edge sits in this band (the
  // header's bottom edge .. the window height minus the tab bar clearance).
  // Read at tick time, so the collapsing header's live position counts.
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const seenBandRef = useRef(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
  seenBandRef.current = () => ({
    top: headerHeight * (1 - headerHidden.value),
    // The list ends above the Mera button; a card under it is not read.
    bottom: windowHeight - listEndClearance,
    left: 0,
    right: windowWidth,
  });
  // ── New cards (FinalFeed #10-11) ──
  // `newSince` is this visit's `lastLeftAt`: fixed while the list is active,
  // so a card stays new until it is seen. Stamped on leaving (blur, unmount).
  const orderHydratedForNew = useFeedOrderStore((s) => s.hydrated);
  const [newSince, setNewSince] = useState<number | null>(null);
  useEffect(() => {
    if (!isFocused || !orderHydratedForNew) return;
    if (lastLeftAtMs === null) {
      lastLeftAtMs = deriveLastLeftAt(useFeedOrderStore.getState().cardStates, Date.now());
    }
    setNewSince(lastLeftAtMs);
    return () => {
      lastLeftAtMs = Date.now();
    };
  }, [isFocused, orderHydratedForNew]);
  const newSinceRef = useRef(newSince);
  newSinceRef.current = newSince;

  // Is any new card still BELOW the screen? Re-read when the on-screen rows
  // change and when the list changes; the boolean is set only when it flips.
  // A card below the screen cannot become seen, so the store is read, not
  // subscribed (a seen-mark flush must not re-render the whole screen).
  const [newBelow, setNewBelow] = useState(false);
  const onScreenIdsRef = useRef<ReadonlySet<string>>(new Set());
  const recomputeNewBelowRef = useRef(() => {});
  recomputeNewBelowRef.current = () => {
    const since = newSinceRef.current;
    let found = false;
    if (since !== null) {
      const rows = listDataRef.current;
      const ids = renderedIdsRef.current;
      let deepest = -1;
      for (const id of onScreenIdsRef.current) deepest = Math.max(deepest, ids.indexOf(id));
      const { cardStates } = useFeedOrderStore.getState();
      const opened = useOpenedStoriesStore.getState().articleIds;
      for (let i = deepest + 1; i < rows.length && !found; i += 1) {
        const item = rows[i];
        // `item.suggestion`, not the session-frozen display row: resolving a
        // row that has not rendered yet would freeze its representative early.
        const shown = item.suggestion;
        const seen = !!cardStates[item.id] || (!!item.suggestion.articleId && opened.has(item.suggestion.articleId));
        found = isNewCard(arrivedAtOf(shown), seen, since);
      }
    }
    setNewBelow((prev) => (prev === found ? prev : found));
  };
  // The minimap's frame: the index range on screen, as shared values.
  const minimapFirst = useSharedValue(0);
  const minimapLast = useSharedValue(0);
  const onScreenChangedRef = useRef((ids: ReadonlySet<string>) => {
    onScreenIdsRef.current = ids;
    recomputeNewBelowRef.current();
    const order = renderedIdsRef.current;
    let lo = Infinity;
    let hi = -1;
    for (const id of ids) {
      const i = order.indexOf(id);
      if (i < 0) continue;
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
    if (hi >= 0) {
      minimapFirst.value = lo;
      minimapLast.value = hi;
    }
  });

  const { viewabilityConfigCallbackPairs, flushSkips, deepestSeenIdRef, resetDeepestSeen, registerRow } =
    useVisibleIndex(renderedIdsRef, seenBandRef, onScreenChangedRef);

  // The list ref forwards to the underlying FlatList, so the re-tap's
  // scroll-to-top and the refresh reset can reach it. The raw offset mirror
  // lets the re-tap tell "scrolled" from "at the top" without a re-render.
  const listRef = useRef<Animated.FlatList<FeedEntry>>(null);
  const lastOffsetShared = useSharedValue(0);

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
    /** Clock the staleness demotion is evaluated against, frozen with the rest
     *  of the snapshot. Without this the sort would re-rank on every render as
     *  wall-clock crossed a bucket edge — the same drift `FeedListItem.score` is
     *  frozen at build time to avoid. */
    at: number;
  }>(() => ({ cardStates: {}, openedArticleIds: new Set(), at: Date.now() }));

  const refreshPartitionSnapshot = useCallback(() => {
    setPartitionSnapshot({
      cardStates: useFeedOrderStore.getState().cardStates,
      openedArticleIds: useOpenedStoriesStore.getState().articleIds,
      at: Date.now(),
    });
  }, []);

  /**
   * Start a NEW reading session: re-freeze the partition AND drop the pinned
   * prefix + its anchor, so the whole list is free to re-sort and new arrivals
   * may land anywhere — including the top.
   *
   * These three must move together. The pin is the rendered prefix OF the
   * partition; re-sorting without clearing it would leave rows pinned by their
   * old positions, and clearing it without re-sorting would un-pin rows for no
   * reason. One function, so the two can never drift apart.
   */
  const resetSession = useCallback(() => {
    // Re-elect representatives and forget "was pending": the list returns to
    // the top on every reset, so nothing changes under a reader.
    rowSessionRef.current = newFeedRowSession();
    setSessionEpoch((e) => e + 1);
    refreshPartitionSnapshot();
    setPinnedIds([]);
    resetDeepestSeen();
  }, [refreshPartitionSnapshot, resetDeepestSeen]);

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

  // App background/foreground.
  //
  // Going to BACKGROUND: flush + persist, and stamp the moment. ('background'
  // only — iOS also fires 'inactive' for the app switcher, Control Centre and
  // permission dialogs, and none of those end a reading session.)
  //
  // Coming back to ACTIVE from background: if the app was away longer than
  // SESSION_RESUME_AFTER_MS, this is a NEW session — re-freeze the partition,
  // drop the pinned prefix, and return to the top. Below the threshold nothing
  // moves at all, which is the whole point of the gate: a re-sort with no scroll
  // compensation under a reader sitting mid-feed is the "where did my place go?"
  // jump, and it must cost a real absence, not a glance.
  //
  // The scroll reset deliberately goes through `pendingScrollResetRef` and the
  // post-commit effect below rather than calling `scrollToOffset` here — a
  // re-sort racing a scroll-to-top while anchoring is live is exactly how a
  // refresh from the top used to dump the user 1300–2000px down the feed.
  //
  // A COLD LAUNCH needs no special case and gets one for free: there is no
  // previous AppState and no recorded background stamp, so no gate is evaluated,
  // and both `pinnedIds` and `partitionSnapshot` start empty because neither is
  // persisted. It always re-partitions.
  const backgroundedAtRef = useRef<number | null>(null);
  const appStateRef = useRef<string>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'background') {
        backgroundedAtRef.current = Date.now();
        flushSkips();
        useFeedOrderStore.getState().flushPersist();
        return;
      }
      if (next !== 'active' || prev !== 'background') return;
      const since = backgroundedAtRef.current;
      backgroundedAtRef.current = null;
      if (since === null || Date.now() - since < SESSION_RESUME_AFTER_MS) return;
      pendingScrollResetRef.current = true;
      resetSession();
    });
    return () => sub.remove();
  }, [flushSkips, resetSession]);

  // Insert newly-Complete candidates while the tab is active. They are still
  // PREPENDED into `order` (see feed-order-store) — that is deliberate and
  // unchanged: `order` position is only a TIE-BREAK within a relevance band, and
  // the pinned prefix below decides where a row may actually render. A fresh
  // arrival therefore lands at the top of its band INSIDE the dynamic region,
  // never above the reader. `articleIds`, not the union set — see
  // opened-stories-store.
  //
  // The pin is extended HERE, immediately before the insert, rather than from
  // the scroll path: the anchor is a ref written by the viewability callback
  // (free), and this is the moment the list is about to change anyway. So
  // `setPinnedIds` fires on ingest, never on scroll — this file must not do
  // state updates mid-scroll (see use-visible-index's header, the scroll-lag
  // fix).
  // True once ingest has run with local candidates in hand: part of the
  // warm-up signal (see use-feed-warmup), so an order that ingests to zero rows
  // resolves to the empty-state chain instead of a skeleton forever.
  const [ingestedCandidates, setIngestedCandidates] = useState(false);
  useEffect(() => {
    if (!isFocused || !orderHydrated || !openedHydrated) return;
    setPinnedIds((prev) =>
      extendPinnedIds(prev, listDataRef.current, deepestSeenIdRef.current),
    );
    useFeedOrderStore
      .getState()
      .ingest(candidates, useOpenedStoriesStore.getState().articleIds);
    if (candidates.length > 0) setIngestedCandidates(true);
  }, [candidates, isFocused, orderHydrated, openedHydrated, deepestSeenIdRef]);

  const data = useMemo(
    () => order.map((id) => itemsById[id]).filter((it): it is FeedListItem => !!it),
    [order, itemsById],
  );

  // Display list: the STATIC pinned prefix (what the user has already read past,
  // in reading order), then the DYNAMIC region — unviewed (high → med → low),
  // then viewed (high → med → low). Nothing is ever removed; a viewed card sinks
  // below the boundary, it does not disappear. Empty when there are no stories,
  // so the empty-state chain renders.
  // `pinnedCount` is part of `sortFeedEntries`'s return but has no consumer
  // here any more — it used to tell `buildFeedRows` where the pinned prefix
  // ended so it could splice a divider just past it; that splicing is gone
  // (see the header comment), and the pinned rows are already in their final
  // rendered position within `listData` itself.
  //
  // A card still waiting for its note sinks to the end of the unseen cards,
  // judged on the article the card SHOWS (its session-frozen representative),
  // not the store's: the store fronts a story with a member that has a note,
  // while the card keeps its first article. `liveById` is a dep so a note
  // landing re-sorts the row up into its band.
  const { rows: listData } = useMemo(
    () =>
      sortFeedEntries(
        data,
        partitionSnapshot.cardStates,
        partitionSnapshot.openedArticleIds,
        pinnedIds,
        partitionSnapshot.at,
        (it) => isAwaitingNote(displayedSuggestionOf(it, liveById, rowSessionRef.current)),
        userGeoLanguageCtx,
      ),
    [data, partitionSnapshot, pinnedIds, liveById, userGeoLanguageCtx],
  );
  listDataRef.current = listData;
  renderedIdsRef.current = useMemo(() => listData.map((it) => it.id), [listData]);

  // ── Which cards just arrived ──────────────────────────────────────────────
  //
  // Derived DURING render, because Reanimated's `entering` runs when a cell
  // MOUNTS: an effect would fire after the mount it needs to describe and the
  // card would paint plain and then animate, which is a flash rather than an
  // arrival.
  //
  // The whole computation is keyed on `listData`'s IDENTITY, so a re-render
  // with the same list is a no-op and a double render under StrictMode cannot
  // consume the set twice. `listData` is memoised above, so the identity is the
  // honest signal of "the list changed".
  //
  // The first commit deliberately animates NOTHING: on a cold start every row
  // is technically new, and flying the whole first screen in reads as a loading
  // screen rather than as news arriving.
  const seenRowIdsRef = useRef<Set<string> | null>(null);
  const lastListRef = useRef<FeedListItem[] | null>(null);
  const arrivingIdsRef = useRef<Set<string>>(new Set());
  if (lastListRef.current !== listData) {
    lastListRef.current = listData;
    const previous = seenRowIdsRef.current;
    const ids = listData.map((it) => it.id);
    arrivingIdsRef.current =
      previous === null ? new Set() : new Set(ids.filter((id) => !previous.has(id)));
    seenRowIdsRef.current = new Set(ids);
  }

  // Eligibility expires. Without this, a row that arrived while the reader was
  // at the top animates again the first time they scroll far enough down for
  // the windowing to mount it, minutes later, which looks like a glitch rather
  // than an arrival. No cleanup cancellation on purpose, matching the
  // scroll-reset effect below: clearing the set twice is harmless and the timer
  // must not be cancelled by the next ingest.
  useEffect(() => {
    const timer = setTimeout(() => {
      arrivingIdsRef.current = new Set();
    }, ARRIVAL_ELIGIBLE_MS);
    return () => clearTimeout(timer);
  }, [listData]);

  // The glow re-reads when the list or the visit's `newSince` changes.
  useEffect(() => {
    recomputeNewBelowRef.current();
  }, [listData, newSince]);
  const minimapSetting = useFeedMinimap();
  // Drawn only with rows to map: an empty Feed keeps equal side margins.
  const minimapOn = minimapSetting && listData.length > 0;
  const minimapRows = useMemo(
    () => (minimapOn ? listData.map((it) => ({ id: it.id, suggestion: it.suggestion })) : []),
    [minimapOn, listData],
  );
  const jumpToRow = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }, []);
  // Rows far off screen have no measured layout yet: land near by the average
  // row height, then retry once the window renders there.
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({ offset: info.index * info.averageItemLength, animated: false });
      requestAnimationFrame(() => listRef.current?.scrollToIndex({ index: info.index, animated: false }));
    },
    [],
  );
  const glowOn = isFocused && newBelow && !minimapOn;
  useEffect(() => {
    if (!glowOn || announcedNewBelow) return;
    announcedNewBelow = true;
    AccessibilityInfo.announceForAccessibility(t('feed.newStoriesBelowA11y'));
  }, [glowOn, t]);

  // Seed the pin the first time the list is non-empty. This is NOT redundant
  // with the extend inside the ingest effect: on a cold launch the first ingest
  // fires while `listData` is still empty (order empty, candidates just landed),
  // so it would seed nothing — and the NEXT ingest, seconds later, would prepend
  // against an empty pin and reproduce the mid-list-open jump this phase exists
  // to remove.
  useEffect(() => {
    if (listData.length === 0 || pinnedIds.length > 0) return;
    setPinnedIds(extendPinnedIds([], listData, deepestSeenIdRef.current));
  }, [listData, pinnedIds.length, deepestSeenIdRef]);

  // DEV-only: the FIRST commit at which this screen actually has cards. A
  // useEFFECT, not the memo body above — the memo runs during render, BEFORE
  // commit, so measuring there measures memo evaluation rather than paint.
  // Deliberately not routed through useFeedFunnelLog: its 2500ms trailing
  // debounce would misreport this by 2.5s, in exactly the direction that
  // matters. `mark` is once-per-run, so the dep churn costs nothing.
  useEffect(() => {
    if (listData.length > 0) {
      coldstartTimeline.mark('feed-first-paint', `rows=${listData.length}`);
    }
  }, [listData.length]);

  // How many rows sit in the unviewed block — no longer a rendered boundary
  // (see the header comment), but the funnel diagnostic still reports it as
  // its `dividerIdx`.
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
    const key = rowSessionRef.current.rowBySuggestion.get(s._id) ?? suggestionToItemIdRef.current.get(s._id);
    if (key) useFeedOrderStore.getState().markViewed(key);
  }, []);

  // Tap-open. Wrapped HERE rather than inside `useOpenSuggestion`: that hook is
  // shared with Interests, which has no card lifecycle.
  const openSuggestion = useCallback(
    (s: ForYouSuggestion) => {
      markViewedFor(s);
      openSuggestionBase(s);
    },
    [markViewedFor, openSuggestionBase],
  );

  const feedAdapter: VerdictStoreAdapter = {
    // The frozen representative first: it is what the card shows, and the
    // store's own representative may have moved on (feed-row-display.ts).
    keyFor: (s) => rowSessionRef.current.rowBySuggestion.get(s._id) ?? suggestionToItemIdRef.current.get(s._id) ?? null,
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
  // The 'browse_related' nudge ("Show related coverage" on the paywall branch)
  // opens the story's detail screen, whose footer IS the related-articles list.
  // Deliberately `openSuggestion`, not `openSuggestionBase` — a nudge that opens
  // a card must stamp that card's lifecycle exactly like a tap does.
  const {
    onVerdict,
    onAskMera: askMeraBase,
    feedbackHandlers,
  } = useFeedbackSheet(feedAdapter, { onOpenSuggestion: openSuggestion });

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
    resetSession();
    onRefreshSync();
  }, [flushSkips, resetSession, onRefreshSync]);

  // Re-tap the Feed tab icon → scroll to top; tap again at the top → refresh.
  // Deliberately the SAME `onRefresh` the RefreshControl below calls, not
  // `onRefreshSync` and not the scheduler: routing around it would skip
  // flushSkips + the partition-snapshot refresh, and a scheduler-level call can
  // be swallowed by conditions that only gate the SCHEDULED path.
  usePageScrollTarget(listRef, {
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
      // F27: re-seed the pin in the same frame. `resetSession` cleared it, so
      // until the next ingest nothing stopped a sync's arrivals from sorting
      // in above the cards the reader is now looking at, which read as a
      // second jump right after the refresh. Floor-sized (the reader is at the
      // top), and still monotonic from here.
      setPinnedIds((prev) => extendPinnedIds(prev, listDataRef.current, null));
    });
  }, [partitionSnapshot, listData]);

  // Compose the collapsible-header handler with a scroll-tick notifier (drives
  // deferred TranslatableDynamic translation as items enter the viewport) —
  // mirrors DashboardSectionsFeed's composition.
  const tickHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      // Only a real offset change ticks: a programmatic setContentOffset to
      // the same place must not feed a layout loop.
      if (e.contentOffset.y === lastOffsetShared.value) return;
      runOnJS(notifyScrollTick)();
      // Mirror the raw offset every frame (UI thread, no bridge crossing, no
      // re-render) for the re-tap's "am I at the top" read.
      lastOffsetShared.value = e.contentOffset.y;
    },
  });
  const onScroll = useComposedEventHandler([scrollHandler, tickHandler]);

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

  // ── Empty-state chain (the same priority as the Interests page's) ──
  const hasFacts = useHasFacts();
  const noFacts = hasFacts === false;
  const lastProcessingRunFinishedAt = useForYouLastProcessingRunFinishedAt();
  // Shared derivation (see components/custom/FeedSyncIndicator) — used here only
  // for the empty-state chain and the header auto-reveal. The header indicator
  // OR-s in the scheduler flag on its own.
  // Same subscription as `narrating` above, named for its other readers
  // (the empty-state chain and the header auto-reveal). One hook call, so the
  // two can never disagree about whether a run is in flight.
  const isFeedProcessing = narrating;

  // Auto-reveal the header on an error state or while the list is empty
  // (preparing / no interests yet) so the header chrome is never hidden
  // under a collapsed header when the user most needs it.
  useEffect(() => {
    const isEmptyState =
      data.length === 0 &&
      (noFacts || isFeedProcessing || lastProcessingRunFinishedAt === null);
    if (errorMessage || isEmptyState) {
      reveal();
    }
  }, [errorMessage, data.length, noFacts, isFeedProcessing, lastProcessingRunFinishedAt, reveal]);

  // F2: while the local cache is still loading on launch, the list is empty for
  // a reason that is NOT "nothing to show". Draw nothing for 200ms, then a
  // static skeleton, and never the "preparing your feed" or "caught up" cards.
  const warmup = useFeedWarmup({
    orderHydrated,
    openedHydrated,
    candidateCount: candidates.length,
    renderedCount: listData.length,
    ingested: ingestedCandidates,
    suggestionsHydrated,
    announcement: t('feed.loadingA11y'),
  });

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
    // card (the list's first item, open: `emptyHere` below) says which state
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

  // An empty Feed past its first run opens the counts card (the same branch
  // of the empty chain that shows the shortcuts). Without `active`, so the
  // card is already there as the page slides in.
  const emptyHere =
    listData.length === 0 &&
    warmup !== 'blank' &&
    warmup !== 'skeleton' &&
    !isLoading &&
    !errorMessage &&
    !noFacts &&
    lastProcessingRunFinishedAt !== null;
  const emptyWantsCard = active && emptyHere;
  const hasRows = listData.length > 0;
  // The list's first item: the no-facts block, or the counts card.
  const cardItem = useStatsCardItem(emptyHere, hasRows);
  const headerNode = useMemo(() => (noFacts ? <FeedNoFacts view="continuous" /> : cardItem), [noFacts, cardItem]);
  useEffect(() => {
    if (active) setEmptyWantsCard(emptyWantsCard);
  }, [active, emptyWantsCard]);

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
