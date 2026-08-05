// priority-order — THE ordering rule for personalized story surfaces, shared by
// the Feed tab and the Dashboard so the two cannot drift.
//
//   unviewed (high → medium → low) … then viewed (high → medium → low)
//
// The Feed refines "viewed" into two tiers — seen-but-not-opened, then opened —
// and renders a divider at each boundary; see `SeenTier`. The tier is the
// OUTERMOST key, so relevance banding still applies WITHIN each tier. The
// Dashboard keeps the two-state projection and is unaffected.
//
// PURE and RN-free: no DB / expo / react-native imports, so it unit-tests
// without a device.
//
// This exists because the same rule now has two consumers with two different row
// shapes (`FeedListItem` on the Feed, `FactRowGroup` on the Dashboard). Encoding
// it twice would guarantee divergence — and the failure would be silent and
// user-visible: the same story ranked differently on two screens, or a "High"
// chip rendered below a "Medium" one.
//
// BAND-LADDER UNIFICATION (relevance v3, 2026-08-05): there used to be TWO
// independent band ladders — `bucketOf` (feed-select/ownership.ts, 0.4/0.6/0.8,
// Dashboard section viability only) and this module's own `relevanceBandRank`
// (0.53/0.77, re-hardcoded in lib/relevance-utils.ts + RelevanceChip.tsx for the
// card pill, feed ordering, and the importance filter). An article at 0.53–0.60
// was MEDIUM on the pill but LOW for Dashboard sections — the exact "medium
// falls in low" misclassification the ladders' drift guaranteed. `bandOf` /
// `bandRank` (feed-select/ownership.ts) are now the ONE source of truth for
// both; `relevanceBandRank` below is a thin adapter onto them, not a second
// ladder. An article's band must be IDENTICAL on every surface — card pill,
// feed ordering, importance filter, Dashboard sections — that is the entire
// point of this change.

// `bandOf`/`bandRank` are the unified band source of truth (see above).
// `feed-select/ownership` is itself a pure, RN-free module (no DB/expo/
// react-native imports), so importing it here does not break this module's own
// RN-free invariant.
import { bandOf, bandRank } from '@/lib/news-harness/feed-select/ownership';

/**
 * How far a story has got through the user's attention. LOWER sorts first.
 *
 *   0 UNSEEN            never in the viewport long enough, never touched
 *   1 SEEN_NOT_OPENED   dwelt past, thumbed, saved, or handed to Mera —
 *                       acknowledged, but not read
 *   2 OPENED            actually tapped through
 *
 * The Feed renders a divider at each of the two boundaries. The Dashboard has
 * no such split and stays on the two-state `viewed` projection below, which maps
 * onto 0/1 and is bit-identical to the old behaviour.
 */
export type SeenTier = 0 | 1 | 2;

/** What the ordering actually keys on, projected out of whatever row shape a
 *  caller has. */
export interface PriorityFacts {
  /** The scored relevance the worded chip displays (`suggestion.relevance`). */
  relevance: number;
  /** Opened (tap) OR dwelt on for DWELL_READ_SECONDS — see `isViewedArticle`.
   *  The two-state projection; ignored when `tier` is supplied. */
  viewed: boolean;
  /** The three-state projection. Optional so the Dashboard can keep passing
   *  `viewed` alone and get byte-identical output. */
  tier?: SeenTier;
  /** Pre-computed band, overriding `relevanceBandRank(relevance)`.
   *
   *  Exists so a SURFACE can apply its own band policy without that policy
   *  leaking into the shared rule: the Feed demotes stale unseen stories by a
   *  band or two (see `feed-entries`), which must not follow the Dashboard,
   *  whose chip order is a hard guarantee. This module stays the generic
   *  comparator; the policy lives in the caller's projection. */
  band?: number;
}

/**
 * Relevance band rank, LOWER sorts first: 0 emergency, 1 high, 2 medium, 3 low,
 * 4 irrelevant/unscored.
 *
 * A thin adapter onto the unified `bandOf`/`bandRank` (feed-select/ownership.ts,
 * the single source of truth as of relevance v3 — see the module header): those
 * export EMERGENCY=4 … SUB_GATE=0 (higher = more prominent), so this function
 * just flips the scale to the LOWER-sorts-first convention every caller here
 * already depends on. `getRelevanceColors` (lib/relevance-utils.ts) and
 * `RelevanceChip`'s icon selection read `bandOf` directly rather than
 * re-deriving cutoffs, so all three — pill, ordering, importance filter — are
 * now driven by the exact same cutoffs and can never disagree on a story's
 * band.
 *
 * Band off the scored relevance, NOT a composite score: the Feed's
 * `FeedListItem.score` folds in a recency decay the chip knows nothing about.
 */
export function relevanceBandRank(relevance: number): number {
  return 4 - bandRank(bandOf(relevance));
}

/**
 * The single "has the user seen this?" predicate.
 *
 * Two signals, deliberately equivalent for display: an explicit OPEN (tap,
 * recorded on any surface) or a DWELL of `DWELL_READ_SECONDS` in the viewport
 * (stamped into `feed-order-store.cardStates`).
 *
 * The two keys are SEPARATE parameters on purpose. In production they are the
 * same string — a Feed row's id IS its representative's article id — but they
 * are different NAMESPACES: `cardStates` is keyed by the feed-order row id
 * (which survives a representative switch), while the opened set is keyed by
 * article id. Collapsing them into one argument silently changed which set each
 * lookup hit. The Dashboard has no row-id namespace and passes its
 * representative's article id for both.
 *
 * `openedArticleIds` must be the EXACT-article set, never the cluster-wide union:
 * a `stableClusterId` identifies an ONGOING story, so matching it would mark a
 * brand-new article as seen because a DIFFERENT article in the same story was
 * read up to 30 days ago.
 */
export function isViewedArticle(
  cardStateKey: string | null | undefined,
  articleId: string | null | undefined,
  cardStates: Record<string, unknown>,
  openedArticleIds: ReadonlySet<string>,
): boolean {
  return seenTierOf(cardStateKey, articleId, cardStates, openedArticleIds) > 0;
}

/**
 * The three-state refinement of `isViewedArticle`, and the SAME two signals —
 * they are just no longer collapsed. An explicit OPEN outranks a card state:
 * tapping a card stamps both, and "opened" is the stronger statement.
 *
 * Note what lands in tier 1 rather than tier 2: a thumbs-up, a save, or an
 * Ask-Mera stamps `cardStates` but deliberately records NO open (those must stay
 * out of the personalization seen-set), so an interacted-with-but-unread card
 * sits with the dwelt-past ones. That is the intended reading of "seen but not
 * opened".
 *
 * Every caveat on `isViewedArticle` above applies unchanged — in particular
 * `openedArticleIds` must be the EXACT-article set, never the cluster-wide union.
 */
export function seenTierOf(
  cardStateKey: string | null | undefined,
  articleId: string | null | undefined,
  cardStates: Record<string, unknown>,
  openedArticleIds: ReadonlySet<string>,
): SeenTier {
  if (articleId && openedArticleIds.has(articleId)) return 2;
  if (cardStateKey && cardStates[cardStateKey] !== undefined) return 1;
  return 0;
}

/**
 * Order a list by the shared rule. Returns a NEW array; never mutates `items`.
 *
 * Ties inside a band keep the INCOMING order (an explicit index tie-break rather
 * than leaning on sort stability, because that ordering is load-bearing): on the
 * Feed it preserves the store's insert-only prepend, so a fresh arrival lands at
 * the top of its own band rather than the top of the whole list.
 */
export function sortByPriority<T>(
  items: readonly T[],
  project: (item: T) => PriorityFacts,
): T[] {
  return items
    .map((item, idx) => {
      const f = project(item);
      // `tier` when the caller supplies it, else the two-state projection — so a
      // `viewed`-only caller (the Dashboard) gets exactly the previous ordering.
      const tier = f.tier ?? (f.viewed ? 1 : 0);
      return { item, idx, tier, band: f.band ?? relevanceBandRank(f.relevance) };
    })
    .sort((a, b) => a.tier - b.tier || a.band - b.band || a.idx - b.idx)
    .map((d) => d.item);
}

/** How many rows at the head of a priority-sorted list are unviewed. */
export function countUnviewedBy<T>(
  items: readonly T[],
  project: (item: T) => PriorityFacts,
): number {
  let n = 0;
  for (const item of items) {
    if (!project(item).viewed) n += 1;
  }
  return n;
}
