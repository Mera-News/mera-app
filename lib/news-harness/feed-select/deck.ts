// feed-select — swipe-deck insertion contract (Wave 7b-core M-P5b).
//
// PURE, RN-free. No imports of lib/database, lib/stores, expo, react-native, or
// watermelondb. The scoring pipeline releases whole chunks in batchId order and
// the swipe-deck store applies `insertChunkIntoDeck` verbatim (see SUB-PLAN M
// addendum §A3.3). The store owns the release event wiring + seen/current
// bookkeeping; this module owns ONLY the deterministic ordering.

import { bucketRank, type FeedBucket } from './sections';

/** Where a card sits in the deck. `seen` + `current` are FROZEN — never
 *  repositioned or preempted by newcomers. `unread` cards form the re-orderable
 *  tail. Newcomers are inserted as `unread`. */
export type DeckCardState = 'seen' | 'current' | 'unread';

export interface DeckCard {
  id: string;
  bucket: FeedBucket;
  rawScore: number;
  /** first_pub_date in epoch ms. */
  pubDateMs: number;
  /** Omitted on freshly-released chunk cards → treated as `unread`. */
  state?: DeckCardState;
}

/**
 * Plain signature note for the pipeline→store wiring. The pipeline emits this on
 * each in-order chunk release; the store maps the ids to DeckCards and calls
 * `insertChunkIntoDeck`. Declared here for reference only — the event wiring
 * lives in the (RN-coupled) pipeline/store, NOT in this pure module.
 */
export type ChunkReleaseHandler = (chunkCardIds: readonly string[]) => void;

/** True for frozen (never-repositioned) cards. */
function isFrozen(c: DeckCard): boolean {
  return c.state === 'seen' || c.state === 'current';
}

/**
 * Deck insertion order (A3.3): bucket desc → rawScore desc → first_pub_date desc
 * → id asc. The trailing `id` makes it a TOTAL order (fully deterministic);
 * because ids are unique the stable-sort tiebreak below never actually fires,
 * so it doubles as the "ties keep chunk-internal order" guarantee.
 */
function deckCompare(a: DeckCard, b: DeckCard): number {
  const br = bucketRank(b.bucket) - bucketRank(a.bucket);
  if (br !== 0) return br;
  if (a.rawScore !== b.rawScore) return b.rawScore - a.rawScore;
  if (a.pubDateMs !== b.pubDateMs) return b.pubDateMs - a.pubDateMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Stable sort (decorate-with-index) so equal comparator results preserve the
 *  input order — belt-and-suspenders for the "chunk-internal order" contract. */
function stableSort(cards: DeckCard[]): DeckCard[] {
  return cards
    .map((card, index) => ({ card, index }))
    .sort((x, y) => {
      const c = deckCompare(x.card, y.card);
      return c !== 0 ? c : x.index - y.index;
    })
    .map((d) => d.card);
}

/**
 * Insert a freshly-released chunk into the swipe deck.
 *
 * Invariants (unit-tested):
 *  - Seen cards and the current card are NEVER repositioned or preempted: they
 *    stay at the FRONT, in their existing relative order.
 *  - Each newcomer joins the UNREAD region only, ordered by `deckCompare`. An
 *    EMERGENCY/HIGH newcomer therefore lands directly after the current card
 *    (top of unread) but never above anything seen/current.
 *  - Chunk cards already present in the deck (by id) are dropped (dedup).
 *  - Ties within a release keep chunk-internal order (stable sort).
 *
 * Pure: neither `deck` nor `chunkCards` is mutated; a new array is returned.
 */
export function insertChunkIntoDeck(
  deck: readonly DeckCard[],
  chunkCards: readonly DeckCard[],
): DeckCard[] {
  const existingIds = new Set(deck.map((c) => c.id));

  const frozen: DeckCard[] = [];
  const unread: DeckCard[] = [];
  for (const c of deck) {
    if (isFrozen(c)) frozen.push(c);
    else unread.push(c);
  }

  const newcomers: DeckCard[] = [];
  const seenInChunk = new Set<string>();
  for (const c of chunkCards) {
    if (existingIds.has(c.id) || seenInChunk.has(c.id)) continue;
    seenInChunk.add(c.id);
    newcomers.push(c.state === 'unread' ? c : { ...c, state: 'unread' });
  }

  // Existing unread first so, for any residual tie, prior-deck cards precede
  // newcomers and newcomers keep chunk-internal order.
  const mergedUnread = stableSort([...unread, ...newcomers]);
  return [...frozen, ...mergedUnread];
}
