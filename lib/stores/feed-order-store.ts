// feed-order-store — the PERSISTED order + card-lifecycle state for the "For
// you" vertical Feed tab. It turns the pure `FeedListItem[]` from
// `buildFeedList` into a STABLE scroll order the user reads top-to-bottom, and
// it survives app restarts.
//
// Design (static insert-only order + lifecycle eviction):
//  • The list is built ONCE, the first time it is non-empty (first launch /
//    post-wipe), and is NEVER fully rebuilt afterwards — not on tab focus, not
//    on idle, not on pull-to-refresh. `order` (+ `builtAt`) is persisted as a
//    settings-KV JSON blob so the order is identical across restarts.
//  • As suggestions newly reach status Complete they are INSERTED, never
//    reordered: everything up through the freeze boundary (the deepest row the
//    user has scrolled to, + 2) is frozen; each genuinely-new item is
//    insertion-sorted into the tail beyond that boundary by the composite
//    `feedCompare` score. Cards in the frozen prefix never move.
//  • Every laid-out card carries a LIFECYCLE STATE: `unviewed` (the default,
//    represented by the ABSENCE of a `cardStates` entry) → `skipped` (dwelt on
//    in the viewport without being touched) or `viewed` (interacted with —
//    tapped open, thumbed, saved, or handed to Mera). `viewed` never downgrades
//    to `skipped`, and `skipped` is write-once so a card parked on screen can't
//    keep restarting its own eviction clock.
//  • Cards NEVER move or vanish on interaction. A `skipped`/`viewed` card stays
//    exactly where it is until `sweep()` evicts it — 10 minutes after its state
//    was stamped, or immediately on a force (pull-to-refresh) sweep. `unviewed`
//    cards are never evicted here; they leave only via `hydrate`'s
//    backing-item pass (retention purge / 24h-window ageing between sessions).
//  • Eviction leaves a TOMBSTONE keyed on every identity axis the story has
//    (order id ∪ representative articleId ∪ stableClusterId ∪ memberIds), which
//    `ingest` consults so an evicted story can't immediately walk back in — a
//    skipped card never called `markOpened`, so the opened-set gate does not
//    cover it. Tombstones expire after 48h (the `article_suggestions` DB TTL,
//    beyond which a story can no longer be a candidate) and are hard-capped.
//  • Card state + tombstones live under their OWN settings key, deliberately
//    NOT inside the order blob: `parsePersisted` zeroes `order` on any parse
//    failure, so sharing one key would let a corrupt state map wipe the feed.

import { create } from 'zustand';
import logger from '@/lib/logger';
import {
  getSetting,
  setSetting,
  deleteSetting,
} from '@/lib/database/services/setting-service';
import { feedCompare, type FeedListItem } from './feed-list-selector';
import { isSuggestionOpened } from './fact-rows-selector';

export type Verdict = 'like' | 'dislike';

export interface VerdictRecord {
  verdict: Verdict;
  /** The inline-feedback-tree path taken (empty until the tree is used). */
  path: string[];
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

/** Grace period a skipped/viewed card keeps its slot before a sweep evicts it. */
export const CARD_STATE_TTL_MS = 10 * 60 * 1000;

/** Tombstone lifetime. `data-cleanup-task` deletes `article_suggestions` older
 *  than 48h and the render gate is a 24h window on `firstPubDate`, so nothing
 *  can legitimately return as a candidate after this. */
export const TOMBSTONE_TTL_MS = 48 * 60 * 60 * 1000;

/** Hard cap so a pathological session can't grow the blob unbounded. Newest
 *  kept, oldest dropped. ~4 keys per evicted story ⇒ ~500 stories of headroom. */
const MAX_TOMBSTONES = 2000;

/** Settings-KV key the persisted `{ order, builtAt }` blob lives under. */
export const FEED_ORDER_SETTING_KEY = 'feed_order_v1';

/** Settings-KV key the persisted `{ states, tombs }` blob lives under. Separate
 *  from the order key ON PURPOSE — a corrupt state blob must degrade to
 *  "everything is unviewed", never to "no feed". */
export const FEED_CARD_STATE_SETTING_KEY = 'feed_card_state_v1';

interface FeedOrderState {
  /** Laid-out list-item ids, top-to-bottom. PERSISTED. Insert-only within and
   *  across sessions; entries are removed only by `hydrate` and `sweep`. */
  order: string[];
  /** Full row for every live id in `order` (session-only, rebuilt on hydrate). */
  itemsById: Record<string, FeedListItem>;
  /** Epoch ms of the first non-empty build (persisted alongside `order`). */
  builtAt: number | null;
  /** True once the initial KV read + eviction pass has resolved. */
  hydrated: boolean;
  /** Recorded verdicts, keyed by list-item id (session-only). */
  verdicts: Record<string, VerdictRecord>;
  /** Lifecycle state per list-item id. PERSISTED. Absent ⇒ `unviewed`. */
  cardStates: Record<string, CardStateRecord>;
  /** Evicted-story identity keys → eviction epoch ms. PERSISTED. */
  tombstones: Record<string, number>;

  // Actions
  hydrate: (items: FeedListItem[]) => Promise<void>;
  ingest: (
    items: FeedListItem[],
    openedIds: Set<string>,
    frozenThroughIndex: number,
  ) => void;
  setVerdict: (id: string, verdict: Verdict) => void;
  /** Drop a verdict (+ its tree path) — the un-vote path. No-op if absent. */
  clearVerdict: (id: string) => void;
  setPath: (id: string, path: string[]) => void;
  /** Stamp `skipped` on cards the user dwelt on. Write-once per id. */
  markSkipped: (ids: string[], nowMs?: number) => void;
  /** Stamp `viewed` on an interacted-with card. Upgrades `skipped`. */
  markViewed: (id: string, nowMs?: number) => void;
  /** Evict skipped/viewed cards past the grace period (or all of them, when
   *  `force`). Returns how many rows were removed. */
  sweep: (opts: {
    force: boolean;
    nowMs?: number;
    /** Opened-story ids (article ∪ stable cluster). A laid-out row that was
     *  opened on ANOTHER surface carries no card state of its own, so it is
     *  stamped `viewed` here rather than lingering forever. */
    openedIds?: Set<string>;
  }) => number;
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
  tombstones: {} as Record<string, number>,
};

interface PersistedOrder {
  order: string[];
  builtAt: number | null;
}

interface PersistedCardState {
  states: Record<string, CardStateRecord>;
  tombstones: Record<string, number>;
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

/** Per-field defensive parse: a malformed `tombs` must not discard `states`,
 *  and neither may affect `order` (different key entirely). A device that has
 *  never written this key returns empty maps ⇒ every card back at `unviewed`. */
function parseCardState(raw: string | null): PersistedCardState {
  const empty: PersistedCardState = { states: {}, tombstones: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const obj = parsed as { states?: unknown; tombs?: unknown };

  const states: Record<string, CardStateRecord> = {};
  if (obj.states && typeof obj.states === 'object') {
    for (const [id, v] of Object.entries(obj.states as Record<string, unknown>)) {
      if (!Array.isArray(v) || v.length !== 2) continue;
      const [code, at] = v as WireState;
      if (code !== 's' && code !== 'v') continue;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      states[id] = { state: code === 'v' ? 'viewed' : 'skipped', at };
    }
  }

  const tombstones: Record<string, number> = {};
  if (obj.tombs && typeof obj.tombs === 'object') {
    for (const [k, v] of Object.entries(obj.tombs as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) tombstones[k] = v;
    }
  }

  return { states, tombstones };
}

function persist(order: string[], builtAt: number | null): void {
  // NOTE: `order` must stay the FIRST serialized key — the store's persistence
  // test asserts on the raw substring.
  setSetting(FEED_ORDER_SETTING_KEY, JSON.stringify({ order, builtAt })).catch((err) =>
    logger.captureException(err, { tags: { store: 'feed-order-store' } }),
  );
}

function serializeCardState(
  cardStates: Record<string, CardStateRecord>,
  tombstones: Record<string, number>,
): string {
  const states: Record<string, WireState> = {};
  for (const [id, r] of Object.entries(cardStates)) {
    states[id] = [r.state === 'viewed' ? 'v' : 's', r.at];
  }
  return JSON.stringify({ states, tombs: tombstones });
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

function persistCardStateNow(
  cardStates: Record<string, CardStateRecord>,
  tombstones: Record<string, number>,
): void {
  cancelCardStatePersist();
  setSetting(FEED_CARD_STATE_SETTING_KEY, serializeCardState(cardStates, tombstones)).catch(
    (err) => logger.captureException(err, { tags: { store: 'feed-order-store' } }),
  );
}

function scheduleCardStatePersist(get: () => FeedOrderState): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const s = get();
    persistCardStateNow(s.cardStates, s.tombstones);
  }, PERSIST_DEBOUNCE_MS);
}

/** The representative's top stable cluster id (the rep-switch dedupe key), or
 *  null when the story has no stable cluster. */
function stableClusterIdOf(item: FeedListItem): string | null {
  return item.suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
}

/** Every identity a story can reappear under. All four axes are load-bearing:
 *  after a rep-switch `ingest` stores the fresh row under the OLD order id, so
 *  `item.id` and the representative's `articleId` diverge; the stable cluster
 *  id catches a rep-switch across a restart; and `memberIds` catches
 *  title-Jaccard groups that have no stable cluster id at all — those re-elect
 *  their representative whenever a fresher member lands, which without this
 *  axis would let an evicted story oscillate back in indefinitely. */
function identityKeysOf(item: FeedListItem): string[] {
  const keys = [item.id];
  const articleId = item.suggestion.articleId;
  if (articleId) keys.push(articleId);
  const scid = stableClusterIdOf(item);
  if (scid) keys.push(scid);
  if (item.memberIds) keys.push(...item.memberIds);
  return keys;
}

function isTombstoned(item: FeedListItem, tombstones: Record<string, number>): boolean {
  for (const k of identityKeysOf(item)) {
    if (tombstones[k] !== undefined) return true;
  }
  return false;
}

function pruneTombstones(
  tombstones: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const cutoff = nowMs - TOMBSTONE_TTL_MS;
  let out: Record<string, number> = {};
  for (const [k, t] of Object.entries(tombstones)) {
    if (t > cutoff) out[k] = t;
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_TOMBSTONES) {
    keys.sort((a, b) => out[b] - out[a]); // newest first
    const kept: Record<string, number> = {};
    for (const k of keys.slice(0, MAX_TOMBSTONES)) kept[k] = out[k];
    out = kept;
  }
  return out;
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
        const persistedState = parseCardState(rawState);
        const now = Date.now();

        // PASS 1 — keep a persisted id only if it still has a backing item in
        // the live candidate pool (a purged / aged-out story is dropped here).
        // Survivors keep their persisted order + fresh row data.
        //
        // *** DELIBERATELY NO TOMBSTONES IN THIS PASS. *** FeedScreen fires
        // hydrate on `dbReady` with whatever candidates exist at that instant,
        // which is often [] before the suggestion store has loaded. Tombstoning
        // here would brick the whole feed for 48h on that race.
        const backing = new Map(items.map((it) => [it.id, it]));
        const alive: string[] = [];
        const itemsById: Record<string, FeedListItem> = {};
        for (const id of parsed.order) {
          const item = backing.get(id);
          if (!item) continue;
          alive.push(id);
          itemsById[id] = item;
        }

        // PASS 2 — the launch sweep. Same predicate as `sweep({force:false})`,
        // over ids that DO have a live backing item, so these tombstone
        // normally. In practice every previous-session skipped/viewed card is
        // well past the 10-minute grace period by now.
        const tombstones = pruneTombstones(persistedState.tombstones, now);
        const cutoff = now - CARD_STATE_TTL_MS;
        const survivors: string[] = [];
        const cardStates: Record<string, CardStateRecord> = {};
        for (const id of alive) {
          const rec = persistedState.states[id];
          if (rec && rec.at <= cutoff) {
            for (const k of identityKeysOf(itemsById[id])) tombstones[k] = now;
            delete itemsById[id];
            continue;
          }
          survivors.push(id);
          // States for evicted ids are pruned by omission.
          if (rec) cardStates[id] = rec;
        }

        set({
          order: survivors,
          itemsById,
          cardStates,
          tombstones,
          builtAt: parsed.builtAt,
          hydrated: true,
        });

        if (survivors.length !== parsed.order.length) persist(survivors, parsed.builtAt);
        if (
          Object.keys(cardStates).length !== Object.keys(persistedState.states).length ||
          Object.keys(tombstones).length !== Object.keys(persistedState.tombstones).length
        ) {
          persistCardStateNow(cardStates, tombstones);
        }
      } catch (err) {
        logger.captureException(err, { tags: { store: 'feed-order-store' } });
        set({ hydrated: true });
      } finally {
        hydrating = null;
      }
    })();
    return hydrating;
  },

  ingest: (items, openedIds, frozenThroughIndex) => {
    const state = get();
    if (!state.hydrated) return; // no-op until the persisted order is loaded

    const order = [...state.order];
    const itemsById = { ...state.itemsById };
    const inOrder = new Set(order);
    const tombstones = state.tombstones ?? {};

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

    // PASS B — resolve rep-switches in place; collect the genuinely-new,
    // not-tombstoned, not-opened items.
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
      // Evicted by a lifecycle sweep — must not come back. This is what breaks
      // the sweep → ingest → skip → sweep loop. Load-bearing for `skipped`
      // cards especially: they never called `markOpened`, so the opened gate
      // below does not cover them (nor does it cover save-only / Ask-Mera-only
      // `viewed` cards, which deliberately do not record an open).
      if (isTombstoned(it, tombstones)) continue;
      // Genuinely new. Opened stories are never inserted (read = tapped, and a
      // read story should not resurface as a fresh card).
      if (isSuggestionOpened(it.suggestion, openedIds)) continue;
      if (seenNew.has(it.id)) continue;
      seenNew.add(it.id);
      newOnes.push(it);
    }

    // Insertion-sort each new item (best-first) into the unfrozen tail. Existing
    // entries never move relative to each other; indices ≤ frozenThroughIndex
    // never shift. An order id with no backing item ranks lowest (insert before).
    newOnes.sort(feedCompare);
    for (const it of newOnes) {
      itemsById[it.id] = it;
      const start = Math.min(Math.max(frozenThroughIndex + 1, 0), order.length);
      let insertAt = order.length;
      for (let i = start; i < order.length; i++) {
        const existing = itemsById[order[i]];
        if (!existing || feedCompare(it, existing) < 0) {
          insertAt = i;
          break;
        }
      }
      order.splice(insertAt, 0, it.id);
    }

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

  markSkipped: (ids, nowMs = Date.now()) => {
    const s = get();
    if (!s.hydrated || ids.length === 0) return;
    const current = s.cardStates ?? {};
    const inOrder = new Set(s.order);
    let next: Record<string, CardStateRecord> | null = null;
    for (const id of ids) {
      // Ignore ids no longer laid out — a debounced flush can land AFTER a
      // sweep evicted the row. Membership kills that whole class of leak.
      if (!inOrder.has(id)) continue;
      // WRITE-ONCE. Never downgrade `viewed`, and never re-stamp an existing
      // `skipped`: if re-entering the viewport refreshed `stateUpdatedAt`, a
      // card near the top that the user scrolls past every session would never
      // become evictable, defeating the whole feature.
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

  sweep: ({ force, nowMs = Date.now(), openedIds }) => {
    const s = get();
    // Hard gate: an unhydrated sweep would see an empty order and persist it
    // over the real one. Every launch. This must never be reachable.
    if (!s.hydrated) return 0;

    const prevStates = s.cardStates ?? {};
    const prevTombs = s.tombstones ?? {};
    const cutoff = nowMs - CARD_STATE_TTL_MS;

    const survivors: string[] = [];
    const itemsById = { ...s.itemsById };
    const cardStates: Record<string, CardStateRecord> = {};
    const tombstones = { ...prevTombs };
    let evicted = 0;

    for (const id of s.order) {
      let rec = prevStates[id];
      // A row opened on ANOTHER surface (the Dashboard) carries no card state
      // of its own. Stamp it `viewed` now so it joins the normal grace period
      // instead of sitting in the feed forever.
      if (!rec && openedIds && openedIds.size > 0) {
        const item = itemsById[id];
        if (item && isSuggestionOpened(item.suggestion, openedIds)) {
          rec = { state: 'viewed', at: nowMs };
        }
      }
      // `unviewed` (no record) is NEVER evicted here.
      if (!rec || (!force && rec.at > cutoff)) {
        survivors.push(id);
        if (rec) cardStates[id] = rec;
        continue;
      }
      evicted++;
      const item = itemsById[id];
      if (item) {
        for (const k of identityKeysOf(item)) tombstones[k] = nowMs;
      }
      delete itemsById[id];
      // rec is intentionally not carried over ⇒ cardStates prunes in this pass.
    }

    const nextTombs = pruneTombstones(tombstones, nowMs);
    const statesChanged =
      Object.keys(cardStates).length !== Object.keys(prevStates).length ||
      Object.keys(cardStates).some((id) => prevStates[id] !== cardStates[id]);
    const tombsChanged =
      Object.keys(nextTombs).length !== Object.keys(prevTombs).length;
    if (evicted === 0 && !statesChanged && !tombsChanged) return 0;

    set({ order: survivors, itemsById, cardStates, tombstones: nextTombs });
    // `builtAt` is deliberately untouched even when `order` empties — it means
    // "epoch of the first non-empty build", and keeping it set both stops
    // `ingest` re-stamping it and lets the empty-state chain tell "swept clean"
    // apart from "first run, still preparing".
    if (evicted > 0) persist(survivors, s.builtAt);
    persistCardStateNow(cardStates, nextTombs);
    return evicted;
  },

  flushPersist: () => {
    if (!persistTimer) return;
    const s = get();
    persistCardStateNow(s.cardStates, s.tombstones);
  },

  reset: () => {
    // Cancel first: a timer armed just before logout would otherwise re-write
    // the blob moments after `deleteSetting` cleared it, leaking one user's
    // tombstones into the next user's feed.
    cancelCardStatePersist();
    set({ ...initialState, itemsById: {}, verdicts: {}, cardStates: {}, tombstones: {} });
    deleteSetting(FEED_ORDER_SETTING_KEY).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-order-store' } }),
    );
    deleteSetting(FEED_CARD_STATE_SETTING_KEY).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-order-store' } }),
    );
  },
}));

/** Resolve an incoming item to an EXISTING order id when it is the same story
 *  under a new representative. Checks the stable cluster id first (the strong
 *  signal), then any member article id. */
function resolveExistingOrderId(
  it: FeedListItem,
  identityToOrderId: Map<string, string>,
): string | null {
  const scid = stableClusterIdOf(it);
  if (scid) {
    const hit = identityToOrderId.get(scid);
    if (hit) return hit;
  }
  for (const mid of it.memberIds ?? []) {
    const hit = identityToOrderId.get(mid);
    if (hit) return hit;
  }
  return null;
}
