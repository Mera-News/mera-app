// feed-entries — pure display-ORDER for the Feed tab (RN-free, unit-tested).
//
// The persisted `feed-order-store.order` is the insert-only source of truth for
// which stories exist and how new arrivals stack. At render the Feed sorts that
// list into ONE continuous run — there is no longer an "All Caught Up" divider,
// and no end-of-feed marker row; the feed simply flows to its end:
//
//   [ unviewed: high → medium → low ] then [ viewed: high → medium → low ]
//
// Nothing is ever removed. A viewed card SINKS, it does not disappear, so the
// user can always scroll on to re-read everything they have already been shown.
//
// "Viewed" is the card's own LIFECYCLE STATE (`skipped` = dwelt on for
// DWELL_READ_SECONDS in the viewport, `viewed` = interacted with — the two are
// one concept for display purposes), plus an exact-article open recorded on any
// surface. It is deliberately NOT the cluster-wide opened set: a
// `stableClusterId` identifies an ONGOING story, so a brand-new article would be
// pre-sunk merely because the user read a DIFFERENT article in the same story up
// to 30 days ago.
//
// STABILITY: the screen feeds this a SNAPSHOT of card state that is refreshed
// only at launch and on pull-to-refresh, so a card never migrates from unviewed
// to viewed under the reader mid-session. Within a band the incoming order wins
// (`idx` is the final tie-break), which is what keeps the store's insert-only
// prepend meaningful: a new arrival lands at the TOP of its own band.

import {
  countUnviewedBy,
  isViewedArticle,
  relevanceBandRank,
  seenTierOf,
  sortByPriority,
  type PriorityFacts,
  type SeenTier,
} from '@/lib/feed-ordering/priority-order';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

// The banding + ordering RULE lives in lib/feed-ordering/priority-order — the
// Dashboard applies the identical rule to its section content, and encoding it
// twice would guarantee silent divergence. This module is now just the Feed's
// projection onto that rule.
export { relevanceBandRank };

/** A rendered Feed row. Every row is a real story — the divider entry is gone. */
export type FeedEntry = FeedListItem;

/** How many rows are pinned before the user has scrolled at all. Expressed as a
 *  floor on the deepest-seen INDEX, so `+ 2` below yields 4 pinned rows: three
 *  are visible on a phone screen (one whole, two partial) and the fourth is the
 *  slack card. */
export const INITIAL_VISIBLE_FLOOR = 2;

/**
 * Extend the PINNED PREFIX — the static region the user has already read past.
 *
 * The rule: pin every story down to the deepest one the user has actually seen,
 * plus one card of slack. Three rows visible ⇒ four pinned ⇒ the fifth card is
 * the first dynamic slot.
 *
 * MONOTONIC: the prefix only ever grows within a session (a shorter `want`
 * returns `prev` by IDENTITY, so React skips the re-render). Scrolling back up
 * never shrinks it, which is what stops the boundary chasing the viewport and
 * turning the whole list static inside one scroll.
 *
 * `deepestSeenId` is an ID, never an index. An index would have to survive both
 * a re-sort and (once dividers exist) a sentinel-row splice into the rendered
 * array, and those are two different index spaces — the exact divergence that
 * killed the previous "deepest row" tracker (see use-visible-index's header).
 * Resolving the id against `sorted` in the same tick it is consumed means no
 * index ever crosses a boundary.
 *
 * `sorted` must be the STORY-only list, never a union array containing dividers:
 * a divider must never occupy a pin slot.
 *
 * An unresolvable id (row dropped by `hydrate` / `removeIds`) falls back to the
 * floor rather than collapsing the pin — combined with the monotonic guard, a
 * dropped row can never shrink the static region.
 */
export function extendPinnedIds(
  prev: readonly string[],
  sorted: readonly FeedListItem[],
  deepestSeenId: string | null,
): string[] {
  const found = deepestSeenId ? sorted.findIndex((it) => it.id === deepestSeenId) : -1;
  const want = Math.max(found, INITIAL_VISIBLE_FLOOR) + 2;
  const n = Math.min(Math.max(want, prev.length), sorted.length);
  if (n <= prev.length) return prev as string[];
  return sorted.slice(0, n).map((it) => it.id);
}

/** What `sortFeedEntries` returns: the rendered story order plus the length of
 *  its pinned prefix. */
export interface SortedFeed {
  rows: FeedEntry[];
  /** How many leading entries of `rows` are the pinned prefix. Deliberately the
   *  count of SURVIVORS, not `pinnedIds.length` — the two diverge whenever
   *  `hydrate`/`removeIds` has dropped a pinned row, and consumers place things
   *  (dividers) relative to this boundary. One producer, one number. */
  pinnedCount: number;
}

/**
 * True when a laid-out card counts as VIEWED: it carries a lifecycle record
 * (opened, thumbed, saved, handed to Mera, or dwelt on for DWELL_READ_SECONDS),
 * or its exact article was opened on some surface.
 *
 * Exported so `FeedRow`'s read indicator and this sort are decided by ONE
 * predicate — otherwise a card could show the read state while sitting in the
 * unviewed block.
 */
export function isViewedEntry(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): boolean {
  // `item.id` is the feed-order row key (what `cardStates` is stamped under);
  // the opened set is keyed by ARTICLE id. In production they are the same
  // string, but they are different namespaces — pass them separately.
  return isViewedArticle(item.id, item.suggestion.articleId, cardStates, openedArticleIds);
}

/**
 * Which of the three attention tiers a laid-out card is in: 0 unseen, 1 seen but
 * not opened, 2 opened. The Feed renders a divider at each boundary.
 *
 * Same namespacing caveat as `isViewedEntry`: `item.id` is the feed-order row
 * key, the opened set is keyed by ARTICLE id.
 */
export function seenTierOfEntry(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): SeenTier {
  return seenTierOf(item.id, item.suggestion.articleId, cardStates, openedArticleIds);
}

/** Project a Feed row onto the shared ordering facts. */
function feedPriorityFacts(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): PriorityFacts {
  const tier = seenTierOfEntry(item, cardStates, openedArticleIds);
  return {
    relevance: item.suggestion.relevance ?? 0,
    // Both are supplied and cannot disagree — `isViewedEntry` IS `tier > 0`.
    viewed: tier > 0,
    tier,
  };
}

/**
 * Order the feed: a STATIC PINNED PREFIX (everything the user has already read
 * past this session, in the exact order they read it), then the DYNAMIC region —
 * unviewed first by relevance band high → low, then viewed. Ties inside a band
 * keep the incoming `data` order, i.e. the store's insert-only order, so
 * newly-prepended arrivals sit at the top of their band and nothing shuffles
 * between refreshes.
 *
 * The pinned prefix is what makes the store's `unshift` safe: a brand-new item
 * is never in `pinnedIds`, so it lands in the dynamic region and can only render
 * at an index >= `pinnedCount`. Nothing is ever inserted above the reader.
 *
 * `pinnedIds` ORDER drives the output — the rows are looked up by id rather than
 * filtered out of `data`, because filtering would silently re-derive the order
 * from `data` and lose the reading order, which is the entire point.
 *
 * Pure and total: returns NEW arrays, never mutates `data`, and returns an empty
 * result for an empty feed so the screen's empty-state chain renders. Omitting
 * `pinnedIds` reproduces the pre-pin ordering exactly.
 */
export function sortFeedEntries(
  data: FeedListItem[],
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
  pinnedIds: readonly string[] = [],
): SortedFeed {
  if (data.length === 0) return { rows: [], pinnedCount: 0 };
  const facts = (it: FeedListItem) => feedPriorityFacts(it, cardStates, openedArticleIds);
  if (pinnedIds.length === 0) {
    return { rows: sortByPriority(data, facts), pinnedCount: 0 };
  }
  const byId = new Map(data.map((it) => [it.id, it]));
  const pinned: FeedListItem[] = [];
  const pinnedSet = new Set<string>();
  for (const id of pinnedIds) {
    const it = byId.get(id);
    if (!it) continue; // dropped by hydrate / removeIds — skip, don't shift the rest
    pinned.push(it);
    pinnedSet.add(id);
  }
  const rest = data.filter((it) => !pinnedSet.has(it.id));
  return { rows: [...pinned, ...sortByPriority(rest, facts)], pinnedCount: pinned.length };
}

/** Stable keys for the two divider sentinels. Constants, so `keyExtractor` stays
 *  unique and stable and the rows never remount. */
export const DIVIDER_CAUGHT_UP = 'feed-divider-caught-up';
export const DIVIDER_OPENED = 'feed-divider-opened';

/** One rendered row: a story, or one of the two dividers. */
export type FeedRowEntry =
  | { kind: 'story'; id: string; item: FeedListItem }
  | { kind: 'divider'; id: typeof DIVIDER_CAUGHT_UP | typeof DIVIDER_OPENED };

export interface FeedRows {
  rows: FeedRowEntry[];
  /** True when the caught-up divider has nothing below it and should render as
   *  the list FOOTER instead of in-list — so exactly one instance exists. */
  caughtUpIsFooter: boolean;
}

/**
 * Wrap the sorted stories as render rows and splice in the two dividers.
 *
 *   [ pinned prefix — the user's timeline, mixed tiers, static ]
 *   [ tier 0 — the DYNAMIC sublist; new arrivals land here by priority ]
 *   ── divider #1 "You're all caught up" ──
 *   [ tier 1 — seen, not opened ]
 *   ── divider #2 "Stories you opened" ──
 *   [ tier 2 — opened ]
 *
 * Dividers are placed by scanning the DYNAMIC region only, never the pinned
 * prefix. Two consequences, both deliberate:
 *
 *  - The pinned prefix keeps the order the user actually read in, so it may hold
 *    a mix of tiers. Slicing a divider into it would contradict that.
 *  - When the user has scrolled to the very bottom, everything is pinned and the
 *    dynamic region is empty — so the caught-up divider degrades to the footer,
 *    and the NEXT arrival appears in tier 0, i.e. ABOVE it. That only works
 *    because divider position is derived from the region's composition rather
 *    than from a fixed index.
 */
export function buildFeedRows(
  sorted: readonly FeedListItem[],
  pinnedCount: number,
  tierOf: (it: FeedListItem) => SeenTier,
): FeedRows {
  const rows: FeedRowEntry[] = [];
  const story = (item: FeedListItem): FeedRowEntry => ({ kind: 'story', id: item.id, item });

  // `pinnedCount` must come from `sortFeedEntries` — it counts SURVIVORS, so it
  // cannot run past the end even when pinned ids were dropped.
  const boundary = Math.min(Math.max(pinnedCount, 0), sorted.length);
  for (let i = 0; i < boundary; i += 1) rows.push(story(sorted[i]));

  const dynamic = sorted.slice(boundary);
  let seenDivider = false;
  let openedDivider = false;
  for (const item of dynamic) {
    const tier = tierOf(item);
    if (tier >= 1 && !seenDivider) {
      seenDivider = true;
      rows.push({ kind: 'divider', id: DIVIDER_CAUGHT_UP });
    }
    if (tier >= 2 && !openedDivider) {
      openedDivider = true;
      // Only meaningful once the caught-up divider exists above it; a feed whose
      // dynamic region is ALL opened rows still gets both, in order.
      rows.push({ kind: 'divider', id: DIVIDER_OPENED });
    }
    rows.push(story(item));
  }

  // Nothing below the boundary is seen ⇒ the caught-up marker belongs at the very
  // end, which is the footer's job. Never both.
  return { rows, caughtUpIsFooter: !seenDivider };
}

/** How many rows at the head of a sorted list are unviewed. The boundary is no
 *  longer rendered, but the funnel diagnostic still reports the split. */
export function countUnviewed(
  data: FeedListItem[],
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): number {
  return countUnviewedBy(data, (it) => feedPriorityFacts(it, cardStates, openedArticleIds));
}
