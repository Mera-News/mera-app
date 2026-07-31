// feed-order-store — the PERSISTED order + card-lifecycle state for the "For
// you" vertical Feed tab. It turns the pure `FeedListItem[]` from
// `buildFeedList` into a STABLE scroll order the user reads top-to-bottom, and
// it survives app restarts.
//
// Design (static insert-only, NOTHING is ever evicted for being read; the SCREEN
// re-sorts this order for display — see components/custom/feed/feed-entries.ts):
//  • The list is built ONCE, the first time it is non-empty (first launch /
//    post-wipe), and is NEVER fully rebuilt afterwards — not on tab focus, not
//    on idle, not on pull-to-refresh. `order` (+ `builtAt`) is persisted as a
//    settings-KV JSON blob so the order is identical across restarts.
//  • As suggestions newly reach status Complete they are PREPENDED, never
//    reordered: a new batch is sorted among itself by the composite
//    `feedCompare` score and placed at the FRONT. Existing rows keep their
//    relative order and every index simply shifts down. Because the screen's
//    display sort tie-breaks on this index, a fresh arrival lands at the top of
//    its own relevance band rather than the top of the whole feed. Paired with
//    FlatList's `maintainVisibleContentPosition`, the card being read does not
//    move on screen.
//  • Every laid-out card carries a LIFECYCLE STATE: `unviewed` (the default,
//    represented by the ABSENCE of a `cardStates` entry) → `skipped` (dwelt on
//    in the viewport for DWELL_READ_SECONDS without being touched) or `viewed`
//    (interacted with — tapped open, thumbed, saved, or handed to Mera).
//    `viewed` never downgrades to `skipped`, and `skipped` is write-once. For
//    DISPLAY the two are one concept: "viewed".
//  • Card state is a DISPLAY input only. It decides which BLOCK a card sorts
//    into — unviewed above viewed, each banded by relevance (see
//    components/custom/feed/feed-entries.ts) — and never removes anything. Cards
//    leave the feed by exactly TWO routes: (1) `hydrate` dropping a persisted id
//    that no longer has a live candidate (publication-window ageing / retention
//    purge between sessions — see FEED_WINDOW_MS), and (2) `removeIds`, the
//    filter-scoped eviction the hard "not interested" purge calls with the exact
//    ids it just marked `excluded`. Route (2) infers nothing and remembers
//    nothing — it is deliberately NOT the eviction mechanism described below.
//
//    An earlier revision evicted seen cards after 10 minutes and left
//    "tombstones" so they could not be re-ingested. Those tombstones keyed on
//    every `memberIds` entry of the collapsed story group, and because story
//    groups are rebuilt and GROW on every sync, a brand-new article that later
//    joined a tombstoned group inherited a tombstoned id and was suppressed for
//    48h — unseen and unseeable. One eviction killed an entire ongoing story
//    stream. The whole mechanism is gone; do not reintroduce it without solving
//    that fan-out first.
//  • Card state lives under its OWN settings key, deliberately NOT inside the
//    order blob: `parsePersisted` zeroes `order` on any parse failure, so
//    sharing one key would let a corrupt state map wipe the feed.

import { create } from 'zustand';
import logger from '@/lib/logger';
import {
  getSetting,
  setSetting,
  deleteSetting,
} from '@/lib/database/services/setting-service';
import {
  feedCompare,
  resolveExistingOrderId,
  stableClusterIdOf,
  type FeedListItem,
} from './feed-list-selector';

export type Verdict = 'like' | 'dislike';

export interface VerdictRecord {
  verdict: Verdict;
  /** The inline-feedback-tree path taken (empty until the tree is used).
   *  Records NAVIGATION — a branch descent writes one too, so this is not a
   *  commit signal. See `committed`. */
  path: string[];
  /** Set once a TERMINAL leaf settled (or the user escalated to Mera). The only
   *  thing the filled-thumb treatment may read. Absent (not `false`) until then,
   *  so the record shape is unchanged for every uncommitted verdict. */
  committed?: boolean;
}

/** A feed card's lifecycle state. `unviewed` is the DEFAULT and is represented
 *  by the ABSENCE of a `cardStates` entry, so the persisted map stays
 *  proportional to what the user actually looked at. */
export type CardState = 'skipped' | 'viewed';

export interface CardStateRecord {
  state: CardState;
  /** `stateUpdatedAt` — epoch ms of the transition INTO this state. */
  at: number;
}

/** What `hydrate` saw, kept for the funnel diagnostic. Without these a launch
 *  wipe is invisible: `ingest` refills the order and every other field reads
 *  healthy while the persisted READING ORDER — the whole premise of the
 *  insert-only store — has been silently thrown away. */
export interface HydrateStats {
  persistedOrderCount: number;
  candidateCountAtHydrate: number;
  survivorCount: number;
  /** True when hydrate ran against an empty candidate pool while a persisted
   *  order existed — the eviction pass is SKIPPED in that case (see below), so
   *  this is a diagnostic signal rather than a live failure. */
  emptyPoolGuardTripped: boolean;
}

/** Settings-KV key the persisted `{ order, builtAt }` blob lives under. */
export const FEED_ORDER_SETTING_KEY = 'feed_order_v1';

/** Settings-KV key the persisted `{ states }` blob lives under. Separate from
 *  the order key ON PURPOSE — a corrupt state blob must degrade to "everything
 *  is unviewed", never to "no feed". */
export const FEED_CARD_STATE_SETTING_KEY = 'feed_card_state_v1';

interface FeedOrderState {
  /** Laid-out list-item ids, top-to-bottom. PERSISTED. Insert-only within and
   *  across sessions; entries are removed only by `hydrate`'s backing pass. */
  order: string[];
  /** Full row for every live id in `order` (session-only, rebuilt on hydrate). */
  itemsById: Record<string, FeedListItem>;
  /** Epoch ms of the first non-empty build (persisted alongside `order`). */
  builtAt: number | null;
  /** True once the initial KV read has resolved. */
  hydrated: boolean;
  /** Recorded verdicts, keyed by list-item id (session-only). */
  verdicts: Record<string, VerdictRecord>;
  /** Lifecycle state per list-item id. PERSISTED. Absent ⇒ `unviewed`. */
  cardStates: Record<string, CardStateRecord>;
  /** Session-only provenance from the last `hydrate` (diagnostics). */
  hydrateStats: HydrateStats | null;

  // Actions
  hydrate: (items: FeedListItem[]) => Promise<void>;
  ingest: (items: FeedListItem[], openedArticleIds: Set<string>) => void;
  setVerdict: (id: string, verdict: Verdict) => void;
  /** Drop a verdict (+ its tree path) — the un-vote path. No-op if absent. */
  clearVerdict: (id: string) => void;
  setPath: (id: string, path: string[]) => void;
  /** Mark/unmark a verdict as COMMITTED (a terminal leaf settled). No-op if
   *  absent. Only ever stores `true`; unmarking deletes the key. */
  setCommitted: (id: string, committed: boolean) => void;
  /** FILTER-SCOPED eviction — see `removeIds` in the implementation. */
  removeIds: (ids: string[]) => void;
  /** Stamp `skipped` on cards the user dwelt on. Write-once per id. */
  markSkipped: (ids: string[], nowMs?: number) => void;
  /** Stamp `viewed` on an interacted-with card. Upgrades `skipped`. */
  markViewed: (id: string, nowMs?: number) => void;
  /** Write any debounced card-state persist immediately (app-background). */
  flushPersist: () => void;
  reset: () => void;
}

const initialState = {
  order: [] as string[],
  itemsById: {} as Record<string, FeedListItem>,
  builtAt: null as number | null,
  hydrated: false,
  verdicts: {} as Record<string, VerdictRecord>,
  cardStates: {} as Record<string, CardStateRecord>,
  hydrateStats: null as HydrateStats | null,
};

interface PersistedOrder {
  order: string[];
  builtAt: number | null;
}

function parsePersisted(raw: string | null): PersistedOrder {
  if (!raw) return { order: [], builtAt: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.order)) {
      return {
        order: parsed.order.filter((x: unknown): x is string => typeof x === 'string'),
        builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : null,
      };
    }
    return { order: [], builtAt: null };
  } catch {
    return { order: [], builtAt: null };
  }
}

/** Compact wire encoding for a state record: `['s' | 'v', epochMs]`. */
type WireState = ['s' | 'v', number];

/** Defensive parse. A device that has never written this key — or wrote a
 *  malformed one — returns an empty map ⇒ every card back at `unviewed`, which
 *  is the safe direction (shows more, hides nothing).
 *
 *  Older blobs also carry a `tombs` map from the removed eviction mechanism.
 *  It is deliberately ignored and never re-serialized, so it goes inert on the
 *  next write without needing a migration or a key bump. */
function parseCardState(raw: string | null): Record<string, CardStateRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const rawStates = (parsed as { states?: unknown }).states;
  if (!rawStates || typeof rawStates !== 'object') return {};

  const states: Record<string, CardStateRecord> = {};
  for (const [id, v] of Object.entries(rawStates as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    const [code, at] = v as WireState;
    if (code !== 's' && code !== 'v') continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    states[id] = { state: code === 'v' ? 'viewed' : 'skipped', at };
  }
  return states;
}

function persist(order: string[], builtAt: number | null): void {
  // NOTE: `order` must stay the FIRST serialized key — the store's persistence
  // test asserts on the raw substring.
  setSetting(FEED_ORDER_SETTING_KEY, JSON.stringify({ order, builtAt })).catch((err) =>
    logger.captureException(err, { tags: { store: 'feed-order-store' } }),
  );
}

function serializeCardState(cardStates: Record<string, CardStateRecord>): string {
  const states: Record<string, WireState> = {};
  for (const [id, r] of Object.entries(cardStates)) {
    states[id] = [r.state === 'viewed' ? 'v' : 's', r.at];
  }
  return JSON.stringify({ states });
}

// ── Card-state persist: coalesced ───────────────────────────────────────────
// `markSkipped` fires off a scroll flush and `markViewed` off the tap path,
// both of which already contend with feed-sync for `database.write()`. A
// NON-resetting trailing timer coalesces bursts without ever starving: a
// continuous stream of marks still lands within PERSIST_DEBOUNCE_MS.
const PERSIST_DEBOUNCE_MS = 1000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function cancelCardStatePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function persistCardStateNow(cardStates: Record<string, CardStateRecord>): void {
  cancelCardStatePersist();
  setSetting(FEED_CARD_STATE_SETTING_KEY, serializeCardState(cardStates)).catch((err) =>
    logger.captureException(err, { tags: { store: 'feed-order-store' } }),
  );
}

function scheduleCardStatePersist(get: () => FeedOrderState): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistCardStateNow(get().cardStates);
  }, PERSIST_DEBOUNCE_MS);
}

/** Module-level in-flight hydrate guard — the two feed tabs stay mounted under
 *  NativeTabs, so both can fire the hydrate effect; only one read runs. */
let hydrating: Promise<void> | null = null;

export const useFeedOrderStore = create<FeedOrderState>()((set, get) => ({
  ...initialState,

  hydrate: async (items) => {
    if (get().hydrated) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        const [rawOrder, rawState] = await Promise.all([
          getSetting(FEED_ORDER_SETTING_KEY),
          getSetting(FEED_CARD_STATE_SETTING_KEY),
        ]);
        const parsed = parsePersisted(rawOrder);
        const cardStates = parseCardState(rawState);

        // Keep a persisted id only if it still has a backing item in the live
        // candidate pool (a purged / aged-out story is dropped here). Survivors
        // keep their persisted order + fresh row data.
        //
        // EMPTY-POOL GUARD: FeedScreen calls hydrate the instant `dbReady`
        // flips, which can be before the suggestion store has loaded. An empty
        // pool carries NO information about which persisted ids are dead, so
        // dropping all of them is never a correct inference — skip the pass
        // entirely and let `ingest` reconcile once candidates exist.
        const emptyPoolGuardTripped = items.length === 0 && parsed.order.length > 0;
        const survivors: string[] = [];
        const itemsById: Record<string, FeedListItem> = {};
        if (items.length === 0) {
          survivors.push(...parsed.order);
        } else {
          const backing = new Map(items.map((it) => [it.id, it]));
          for (const id of parsed.order) {
            const item = backing.get(id);
            if (!item) continue;
            survivors.push(id);
            itemsById[id] = item;
          }
        }

        set({
          order: survivors,
          itemsById,
          cardStates,
          builtAt: parsed.builtAt,
          hydrated: true,
          hydrateStats: {
            persistedOrderCount: parsed.order.length,
            candidateCountAtHydrate: items.length,
            survivorCount: survivors.length,
            emptyPoolGuardTripped,
          },
        });

        if (survivors.length !== parsed.order.length) persist(survivors, parsed.builtAt);
      } catch (err) {
        logger.captureException(err, { tags: { store: 'feed-order-store' } });
        set({ hydrated: true });
      } finally {
        hydrating = null;
      }
    })();
    return hydrating;
  },

  ingest: (items, openedArticleIds) => {
    const state = get();
    if (!state.hydrated) return; // no-op until the persisted order is loaded

    const order = [...state.order];
    const itemsById = { ...state.itemsById };
    const inOrder = new Set(order);

    // PASS A — exact id matches. These are the strongest identity signal and
    // are resolved FIRST so a weaker `memberIds` match below can never steal a
    // row out from under the item that literally owns it.
    const claimed = new Set<string>();
    const pending: FeedListItem[] = [];
    for (const it of items) {
      if (inOrder.has(it.id)) {
        // Known row — refresh its data, never reorder.
        itemsById[it.id] = it;
        claimed.add(it.id);
      } else {
        pending.push(it);
      }
    }

    // Map each still-UNCLAIMED story's identity keys → its order id, so a grown
    // cluster (or a title-Jaccard group) fronting a NEW representative article
    // updates the existing entry in place instead of appearing as a duplicate
    // card. `memberIds` is what makes this work for groups with no stable
    // cluster id — those previously rendered the same story twice, one copy
    // stale, until the next hydrate.
    //
    // Claimed rows are EXCLUDED, and each row can be claimed only once. Story
    // groups are rebuilt from cluster memberships on every sync, so they SPLIT
    // as well as merge: without both guards, a row whose stale `memberIds` still
    // listed article B would let candidate B overwrite it, and the row's own
    // story would vanish while B never got a card of its own either.
    const identityToOrderId = new Map<string, string>();
    for (const id of order) {
      if (claimed.has(id)) continue;
      const existing = itemsById[id];
      if (!existing) continue;
      const scid = stableClusterIdOf(existing);
      if (scid) identityToOrderId.set(scid, id);
      for (const mid of existing.memberIds ?? []) identityToOrderId.set(mid, id);
    }

    // PASS B — resolve rep-switches in place; collect the genuinely-new items.
    const newOnes: FeedListItem[] = [];
    const seenNew = new Set<string>();
    for (const it of pending) {
      const oldId = resolveExistingOrderId(it, identityToOrderId);
      if (oldId && !claimed.has(oldId)) {
        // Rep-switch: same story, new representative article. Keep the OLD order
        // id (position frozen) but store the fresh row under it, overriding the
        // item's id so the order array + verdict/state keying stay stable.
        claimed.add(oldId);
        itemsById[oldId] = { ...it, id: oldId };
        continue;
      }
      // A split-off sibling whose row was already claimed falls through here and
      // becomes its own card, which is exactly right.
      //
      // Don't re-insert the EXACT article the user already opened. Deliberately
      // matched on article id alone, NOT the cluster-wide opened set: that set
      // also contains stable cluster ids with a 30-day TTL, so matching it here
      // meant reading one article suppressed every FUTURE article in that
      // ongoing story for a month. A genuinely-viewed card sinks into the viewed
      // block at render time instead of being withheld.
      if (it.suggestion.articleId && openedArticleIds.has(it.suggestion.articleId)) continue;
      if (seenNew.has(it.id)) continue;
      seenNew.add(it.id);
      newOnes.push(it);
    }

    // PREPEND, best-first among themselves. Existing entries never move relative
    // to each other and never change their relative order; every one of them
    // simply shifts down by `newOnes.length`. The screen pairs this with
    // FlatList's `maintainVisibleContentPosition`, so the list grows without
    // moving the card being read.
    //
    // What this position BUYS, given the screen re-sorts `order` for display
    // (`sortFeedEntries`: unviewed → viewed, each banded by relevance): a
    // brand-new item has no card state, so it is UNVIEWED, and within its
    // relevance band the sort's final tie-break is the incoming `order` index.
    // Prepending therefore puts an arrival at the TOP OF ITS BAND rather than the
    // top of the list. `order` position and rendered position are NOT the same
    // thing — `order` interleaves viewed and unviewed rows (hydrate drops ids
    // from arbitrary positions, and a rep-switch rewrites a row under an older
    // id) — so this and `sortFeedEntries`' tie-break are a PAIRED EDIT: drop the
    // index tie-break there and prepending stops meaning anything here.
    //
    // This also replaced an insertion sort whose scan broke on the first order
    // id with no backing item, making any such id a permanent insert magnet for
    // every later ingest.
    newOnes.sort(feedCompare);
    for (const it of newOnes) itemsById[it.id] = it;
    if (newOnes.length > 0) order.unshift(...newOnes.map((it) => it.id));

    const orderChanged =
      order.length !== state.order.length ||
      order.some((id, i) => id !== state.order[i]);
    let builtAt = state.builtAt;
    if (builtAt === null && order.length > 0) builtAt = Date.now();

    set({ order, itemsById, builtAt });
    if (orderChanged || builtAt !== state.builtAt) persist(order, builtAt);
  },

  setVerdict: (id, verdict) =>
    set((s) => ({
      verdicts: {
        ...s.verdicts,
        [id]: { verdict, path: s.verdicts[id]?.path ?? [] },
      },
    })),

  clearVerdict: (id) =>
    set((s) => {
      if (!s.verdicts[id]) return {} as Partial<FeedOrderState>;
      const next = { ...s.verdicts };
      delete next[id];
      return { verdicts: next };
    }),

  setPath: (id, path) =>
    set((s) => {
      const current = s.verdicts[id];
      if (!current) return {} as Partial<FeedOrderState>;
      return { verdicts: { ...s.verdicts, [id]: { ...current, path } } };
    }),

  setCommitted: (id, committed) =>
    set((s) => {
      const current = s.verdicts[id];
      if (!current) return {} as Partial<FeedOrderState>;
      if (!committed) {
        if (current.committed === undefined) return {} as Partial<FeedOrderState>;
        // Delete rather than store `false`, so an uncommitted record keeps the
        // exact shape it had before this field existed.
        const { committed: _dropped, ...rest } = current;
        return { verdicts: { ...s.verdicts, [id]: rest } };
      }
      if (current.committed === true) return {} as Partial<FeedOrderState>;
      return { verdicts: { ...s.verdicts, [id]: { ...current, committed: true } } };
    }),

  /**
   * FILTER-SCOPED eviction. Removes EXACTLY the ids passed in — the ids a hard
   * "not interested" purge just marked `excluded` — from `order` and
   * `itemsById`, and persists.
   *
   * This is NOT the general eviction mechanism that was removed (see the header
   * note on tombstone contagion). It infers NOTHING: no memberIds fan-out, no
   * stable-cluster expansion, no tombstones, no "drop rows failing a gate".
   * Nothing is remembered, so a row that stops being excluded (the un-exclude
   * sweep) is simply re-ingested on the next `ingest`. Do not generalize it.
   *
   * If the removed id was a story group's REPRESENTATIVE, the whole card goes;
   * its surviving siblings re-form under a new representative on the next
   * ingest. That is the correct outcome — the user asked not to see that story.
   */
  removeIds: (ids) => {
    const s = get();
    if (!s.hydrated || ids.length === 0) return;
    const drop = new Set(ids);
    const order = s.order.filter((id) => !drop.has(id));
    if (order.length === s.order.length) return; // nothing was laid out
    const itemsById = { ...s.itemsById };
    for (const id of drop) delete itemsById[id];
    set({ order, itemsById });
    persist(order, s.builtAt);
  },

  markSkipped: (ids, nowMs = Date.now()) => {
    const s = get();
    if (!s.hydrated || ids.length === 0) return;
    const current = s.cardStates ?? {};
    const inOrder = new Set(s.order);
    let next: Record<string, CardStateRecord> | null = null;
    for (const id of ids) {
      // Ignore ids no longer laid out — a debounced flush can land after the
      // row left the order. Membership kills that whole class of leak.
      if (!inOrder.has(id)) continue;
      // WRITE-ONCE. Never downgrade `viewed`, and never re-stamp an existing
      // `skipped` — `at` is the first-seen moment, not the last.
      if (current[id]) continue;
      if (!next) next = { ...current };
      next[id] = { state: 'skipped', at: nowMs };
    }
    // No `set()` when nothing changed — a no-op set still notifies every
    // subscriber, and this runs off the scroll path.
    if (!next) return;
    set({ cardStates: next });
    scheduleCardStatePersist(get);
  },

  markViewed: (id, nowMs = Date.now()) => {
    const s = get();
    if (!s.hydrated) return;
    const current = s.cardStates ?? {};
    if (current[id]?.state === 'viewed') return; // idempotent; keeps the first stamp
    if (!s.order.includes(id)) return;
    set({ cardStates: { ...current, [id]: { state: 'viewed', at: nowMs } } });
    scheduleCardStatePersist(get);
  },

  flushPersist: () => {
    if (!persistTimer) return;
    persistCardStateNow(get().cardStates);
  },

  reset: () => {
    // Cancel first: a timer armed just before logout would otherwise re-write
    // the blob moments after `deleteSetting` cleared it, leaking one user's
    // card states into the next user's feed.
    cancelCardStatePersist();
    set({ ...initialState, itemsById: {}, verdicts: {}, cardStates: {}, hydrateStats: null });
    deleteSetting(FEED_ORDER_SETTING_KEY).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-order-store' } }),
    );
    deleteSetting(FEED_CARD_STATE_SETTING_KEY).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-order-store' } }),
    );
  },
}));
