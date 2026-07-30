// feed-order-store — persisted static insert-only order tests. setting-service +
// logger are mocked so importing the store never touches a real WatermelonDB.
//
// Covers: hydrate (KV load + eviction of ids with no backing item + builtAt
// restore + the empty-pool guard + hydrateStats), ingest's PREPEND behaviour
// (a new batch sorted among itself by feedCompare and unshifted onto `order`,
// existing rows keeping their relative order and shifting by the batch size,
// no insert-magnet effect from an unbacked "ghost" order id, newest-batch-first
// across successive ingests, and no persisted write on a no-op ingest), the
// narrowed (exact-articleId-only) opened-new-id skip, rep-switch dedupe
// (position kept, no duplicate, fresh rep data), the verdict mirror, and reset
// (clears KV).
//
// Plus the card lifecycle: the separate `feed_card_state_v1` blob (defensive
// per-field parse + debounced round-trip, with legacy `tombs` back-compat)
// and the markSkipped/markViewed transitions. There is no eviction sweep any
// more — a card's lifecycle state is a pure display input (which side of the
// display block it sorts into); it never removes a row from `order`.
//
// The whole file runs on FAKE timers with a pinned system clock: the store
// coalesces card-state writes behind a 1s trailing timer and `hydrate` reads
// `Date.now()` directly, so neither may depend on the wall clock. `afterEach`
// calls `reset()` — the only public way to cancel the module-level persist
// timer, without which a timer armed in one test fires inside the next one's
// `advanceTimersByTime`.

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: (key: string) => mockDeleteSetting(key),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import {
  FEED_CARD_STATE_SETTING_KEY,
  FEED_ORDER_SETTING_KEY,
  useFeedOrderStore,
} from '../feed-order-store';
// eslint-disable-next-line import/first
import type { FeedListItem } from '../feed-list-selector';
// eslint-disable-next-line import/first
import type { ForYouSuggestion } from '../for-you-store';

/** Pinned system clock. Every assertion that cares about time passes an
 *  explicit `nowMs`; `hydrate` (which has no injectable clock) reads this. */
const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** Mirrors the store's module-private `PERSIST_DEBOUNCE_MS`. */
const PERSIST_DEBOUNCE_MS = 1000;

function item(
  id: string,
  over: {
    score?: number;
    pubMs?: number;
    cluster?: string | null;
    articleId?: string;
    memberIds?: string[];
  } = {},
): FeedListItem {
  const clusters = over.cluster ? [{ stableClusterId: over.cluster }] : [];
  const suggestion = {
    _id: id,
    articleId: over.articleId ?? id,
    firstPubDate: new Date(over.pubMs ?? 1_000).toISOString(),
    clusters,
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: over.memberIds?.length ?? 1,
    // Every member's articleId, rep included. Defaults to the singleton group.
    memberIds: over.memberIds ?? [over.articleId ?? id],
    breaking: false,
    score: over.score ?? 0.5,
  };
}

const store = () => useFeedOrderStore.getState();

/** Backing store for `getSetting`, so a test can stage BOTH persisted keys.
 *  (`hydrate` reads them together via `Promise.all`, so the older
 *  `mockResolvedValueOnce` style can only ever stage the order key.) */
let kv: Record<string, string> = {};

/** `setSetting` writes are asserted per KEY — `ingest` can write the order
 *  blob in the same tick as a card-state write, so a bare call count lies. */
const cardWrites = () =>
  mockSetSetting.mock.calls.filter(([key]) => key === FEED_CARD_STATE_SETTING_KEY);
const lastCardBlob = () => {
  const calls = cardWrites();
  return calls.length > 0 ? (calls[calls.length - 1][1] as string) : null;
};
const orderWrites = () =>
  mockSetSetting.mock.calls.filter(([key]) => key === FEED_ORDER_SETTING_KEY);

/** Force the store into a hydrated state with a given order/itemsById.
 *  NOTE: zustand MERGES, so every field this file mutates must be listed
 *  explicitly here (and in `beforeEach`) or it leaks across tests. */
function seed(items: FeedListItem[], builtAt: number | null = 1) {
  const itemsById: Record<string, FeedListItem> = {};
  for (const it of items) itemsById[it.id] = it;
  useFeedOrderStore.setState({
    order: items.map((it) => it.id),
    itemsById,
    builtAt,
    hydrated: true,
    verdicts: {},
    cardStates: {},
    hydrateStats: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  kv = {};
  // `clearAllMocks` clears calls but NOT implementations, so re-install the
  // default here. Individual `mockResolvedValueOnce`s still take precedence.
  mockGetSetting.mockImplementation((key: string) => Promise.resolve(kv[key] ?? null));
  useFeedOrderStore.setState({
    order: [],
    itemsById: {},
    builtAt: null,
    hydrated: false,
    verdicts: {},
    cardStates: {},
    hydrateStats: null,
  });
});

afterEach(() => {
  // `reset()` is the only public way to cancel the module-level persist timer.
  store().reset();
});

afterAll(() => {
  jest.useRealTimers();
});

describe('hydrate', () => {
  it('loads the persisted order, evicts ids with no backing item, restores builtAt, and reports hydrateStats', async () => {
    mockGetSetting.mockResolvedValueOnce(
      JSON.stringify({ order: ['a', 'b', 'c'], builtAt: 123 }),
    );
    // b has aged out of the live pool — only a + c back the persisted order.
    await store().hydrate([item('a'), item('c')]);
    const s = store();
    expect(s.order).toEqual(['a', 'c']);
    expect(Object.keys(s.itemsById).sort()).toEqual(['a', 'c']);
    expect(s.builtAt).toBe(123);
    expect(s.hydrated).toBe(true);
    expect(s.hydrateStats).toEqual({
      persistedOrderCount: 3,
      candidateCountAtHydrate: 2,
      survivorCount: 2,
      emptyPoolGuardTripped: false,
    });
    expect(mockGetSetting).toHaveBeenCalledWith(FEED_ORDER_SETTING_KEY);
  });

  it('flips hydrated even when the KV read throws', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('db crash'));
    await store().hydrate([item('a')]);
    expect(store().hydrated).toBe(true);
  });

  it('null / corrupt KV → empty order, hydrated', async () => {
    mockGetSetting.mockResolvedValueOnce('{not json');
    await store().hydrate([item('a')]);
    expect(store().order).toEqual([]);
    expect(store().hydrated).toBe(true);
  });

  it('EMPTY-POOL GUARD: hydrate([]) against a persisted order skips the eviction pass entirely, so the persisted reading order survives a hydrate that races the suggestion store', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b', 'c'], builtAt: 7 });
    await store().hydrate([]);
    const s = store();
    expect(s.order).toEqual(['a', 'b', 'c']);
    // The guard skips the backing pass entirely, so `itemsById` stays empty
    // until the follow-up `ingest` below heals it — a deliberate ghost state.
    expect(s.itemsById).toEqual({});
    expect(s.hydrateStats).toEqual({
      persistedOrderCount: 3,
      candidateCountAtHydrate: 0,
      survivorCount: 3,
      emptyPoolGuardTripped: true,
    });
    // Survivor count matches the persisted count exactly, so hydrate must not
    // re-persist the order key (or write anything at all).
    expect(mockSetSetting).not.toHaveBeenCalled();

    // …the suggestion store lands a moment later and `ingest` reconciles
    // normally — nothing was lost by skipping the eviction pass.
    store().ingest(
      [item('a', { score: 0.9 }), item('b', { score: 0.8 }), item('c', { score: 0.7 })],
      new Set(),
    );
    expect(store().order).toEqual(['a', 'b', 'c']);
  });
});

describe('ingest — no-op until hydrated', () => {
  it('does nothing before hydrate', () => {
    // store starts unhydrated (beforeEach)
    store().ingest([item('a')], new Set());
    expect(store().order).toEqual([]);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

describe('ingest — initial build (empty order)', () => {
  it('inserts into the empty order in pure feedCompare order and persists + stamps builtAt', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest(
      [item('a', { score: 0.8 }), item('b', { score: 1.0 }), item('c', { score: 0.5 })],
      new Set(),
    );
    // feedCompare = score desc → b, a, c.
    expect(store().order).toEqual(['b', 'a', 'c']);
    expect(store().builtAt).not.toBeNull();
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEED_ORDER_SETTING_KEY,
      expect.stringContaining('"order":["b","a","c"]'),
    );
  });

  it('skips genuinely-new ids whose exact articleId is already opened', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest([item('a'), item('b')], new Set(['a']));
    expect(store().order).toEqual(['b']);
  });
});

describe('ingest — narrowed opened gate (exact articleId only)', () => {
  // The gate used to match against the cluster-wide opened set (article ids
  // ∪ stableClusterIds with a 30-day TTL), so reading one article suppressed
  // every FUTURE article in that ongoing story for a month. It is now an
  // EXACT articleId match only — a viewed card sinks into the viewed block at
  // render time instead of being withheld from ingest at all.
  it('excludes a candidate whose own articleId is in openedArticleIds', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest([item('a', { articleId: 'art-a' })], new Set(['art-a']));
    expect(store().order).toEqual([]);
  });

  it('does NOT exclude a candidate merely because its stableClusterId is in the opened set — a brand-new article in a previously-read ongoing story must still reach the feed', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest(
      [item('a', { articleId: 'art-a', cluster: 'C1' })],
      new Set(['C1']), // a stableClusterId, not this article's own id
    );
    expect(store().order).toEqual(['a']);
  });

  // The opened gate sits in PASS B, which only ever considers ids not already
  // in `order` — PASS A (the known-row check) claims an existing row before
  // the gate is ever reached. This must stay true: tapping a card open is
  // exactly what puts its articleId into `openedArticleIds` AND marks it
  // `viewed`, so if the gate were ever hoisted ahead of the known-row check,
  // every read card would vanish from the feed on its very next refresh.
  it('never removes an already-laid-out row, even when its own articleId is in the opened set on the next sync', () => {
    seed([item('a', { score: 0.9 })]);
    store().markViewed('a', NOW); // the user tapped it open…
    // …so its articleId is in the opened set on the next sync.
    store().ingest([item('a', { score: 0.2 })], new Set(['a']));
    expect(store().order).toEqual(['a']); // still laid out
    expect(store().itemsById.a.score).toBe(0.2); // and refreshed in place
  });
});

describe('ingest — prepend', () => {
  it('lands a new batch at the FRONT, sorted among itself by feedCompare', () => {
    seed([item('a', { score: 0.9 })]);
    store().ingest(
      [
        item('a', { score: 0.9 }),
        item('x', { score: 0.5 }),
        item('y', { score: 0.8 }),
        item('z', { score: 0.5, pubMs: 2_000 }), // ties x on score, wins on pubDate
      ],
      new Set(),
    );
    // feedCompare among the new batch: y (0.8) > z (0.5, newer pub) > x (0.5, older pub).
    expect(store().order).toEqual(['y', 'z', 'x', 'a']);
  });

  it('keeps existing rows in their relative order, each shifted by exactly newOnes.length', () => {
    seed([item('a', { score: 0.9 }), item('b', { score: 0.7 }), item('c', { score: 0.3 })]);
    store().ingest(
      [
        item('a', { score: 0.9 }),
        item('b', { score: 0.7 }),
        item('c', { score: 0.3 }),
        item('x', { score: 1.0 }),
        item('y', { score: 0.95 }),
      ],
      new Set(),
    );
    expect(store().order).toEqual(['x', 'y', 'a', 'b', 'c']);
  });

  it('the first build into an empty order produces a fully feedCompare-sorted list (one sorted batch prepended onto [])', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest(
      [item('a', { score: 0.3 }), item('b', { score: 0.9 }), item('c', { score: 0.6 })],
      new Set(),
    );
    expect(store().order).toEqual(['b', 'c', 'a']);
  });

  // Regression: the OLD insertion-sort scan broke on the first order id with
  // no backing item, making that id a permanent insert magnet for every later
  // ingest. Prepend never scans `order` at all, so a ghost id just sits where
  // it was — it neither attracts nor repels new inserts.
  it('an order id with no backing itemsById entry no longer attracts inserts', () => {
    useFeedOrderStore.setState({
      order: ['a', 'ghost'],
      itemsById: { a: item('a', { score: 1.0 }) },
      builtAt: 1,
      hydrated: true,
      verdicts: {},
      cardStates: {},
      hydrateStats: null,
    });
    store().ingest([item('a', { score: 1.0 }), item('z', { score: 0.1 })], new Set());
    // z is new (unclaimed — 'ghost' has no itemsById row to match against), so
    // it goes to the FRONT, not slotted in near the ghost by score.
    expect(store().order).toEqual(['z', 'a', 'ghost']);
  });

  it('two successive ingests: the SECOND batch ends up above the first (newest-batch-first)', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest([item('a', { score: 0.5 }), item('b', { score: 0.4 })], new Set());
    expect(store().order).toEqual(['a', 'b']);
    store().ingest(
      [
        item('a', { score: 0.5 }),
        item('b', { score: 0.4 }),
        item('c', { score: 0.2 }),
        item('d', { score: 0.1 }),
      ],
      new Set(),
    );
    expect(store().order).toEqual(['c', 'd', 'a', 'b']);
  });

  it('a no-op ingest (no genuinely-new items) does not change order or write the order key', () => {
    seed([item('a', { score: 0.9 }), item('b', { score: 0.5 })]);
    mockSetSetting.mockClear();
    store().ingest([item('a', { score: 0.9 }), item('b', { score: 0.5 })], new Set());
    expect(store().order).toEqual(['a', 'b']);
    expect(orderWrites()).toHaveLength(0);
  });
});

describe('ingest — rep-switch dedupe', () => {
  it('updates the existing entry in place under its old id — no duplicate, position kept, fresh rep data', () => {
    seed([item('x', { score: 0.5, cluster: 'C1' })]);
    // New rep article y for the SAME stable cluster C1 (group grew).
    store().ingest([item('y', { score: 0.9, cluster: 'C1' })], new Set());
    expect(store().order).toEqual(['x']); // position kept, no duplicate
    expect(store().itemsById.y).toBeUndefined();
    // Fresh rep data stored under the old order id.
    expect(store().itemsById.x.suggestion.articleId).toBe('y');
    expect(store().itemsById.x.score).toBe(0.9);
    expect(store().itemsById.x.id).toBe('x');
  });

  it('resolves a rep-switch via memberIds when the group has no stable cluster', () => {
    // Title-Jaccard group (no cluster id): row 'x' knows member 'y'.
    seed([item('x', { score: 0.5, memberIds: ['x', 'y'] })]);
    // 'y' now fronts the same group.
    store().ingest([item('y', { score: 0.9, memberIds: ['x', 'y'] })], new Set());
    expect(store().order).toEqual(['x']);
    expect(store().itemsById.x.suggestion.articleId).toBe('y');
  });

  // Regression: story groups are rebuilt from cluster memberships on every
  // sync, so they SPLIT as well as merge. Before the claim guard, the split-off
  // sibling matched the surviving row via its STALE memberIds and overwrote it
  // — the row's own story vanished from the feed and the sibling never got a
  // card either. Both orderings of `items` must be safe.
  describe('group SPLIT — a sibling must never steal a claimed row', () => {
    it('keeps the exact-id row and gives the split-off sibling its own card', () => {
      seed([item('x', { score: 0.9, memberIds: ['x', 'y'] })]);
      store().ingest(
        [
          item('x', { score: 0.9, memberIds: ['x'] }),
          item('y', { score: 0.4, memberIds: ['y'] }),
        ],
        new Set(),
      );
      expect(store().order).toEqual(['y', 'x']);
      expect(store().itemsById.x.suggestion.articleId).toBe('x');
      expect(store().itemsById.y.suggestion.articleId).toBe('y');
    });

    it('is order-independent — the sibling arriving FIRST still cannot claim the row', () => {
      seed([item('x', { score: 0.9, memberIds: ['x', 'y'] })]);
      store().ingest(
        [
          item('y', { score: 0.4, memberIds: ['y'] }),
          item('x', { score: 0.9, memberIds: ['x'] }),
        ],
        new Set(),
      );
      expect(store().order).toEqual(['y', 'x']);
      expect(store().itemsById.x.suggestion.articleId).toBe('x');
      expect(store().itemsById.y.suggestion.articleId).toBe('y');
    });

    it('two unclaimed candidates matching one row: only the first claims it', () => {
      seed([item('x', { score: 0.9, memberIds: ['x', 'p', 'q'] })]);
      // Neither p nor q is an exact-id match, so both resolve to row x.
      store().ingest(
        [
          item('p', { score: 0.8, memberIds: ['p'] }),
          item('q', { score: 0.3, memberIds: ['q'] }),
        ],
        new Set(),
      );
      // p takes the row in place; q becomes its own card (prepended — it's new).
      expect(store().itemsById.x.suggestion.articleId).toBe('p');
      expect(store().order).toEqual(['q', 'x']);
    });
  });
});

describe('verdict mirror', () => {
  it('sets and paths verdicts; flip keeps the existing path', () => {
    seed([item('a')]);
    store().setVerdict('a', 'like');
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
    store().setPath('a', ['too-much']);
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: ['too-much'] });
    store().setVerdict('a', 'dislike');
    expect(store().verdicts.a).toEqual({ verdict: 'dislike', path: ['too-much'] });
  });

  it('setPath is a no-op when no verdict exists', () => {
    store().setPath('ghost', ['x']);
    expect(store().verdicts.ghost).toBeUndefined();
  });

  it('clearVerdict drops the verdict + its path (the un-vote path)', () => {
    seed([item('a')]);
    store().setVerdict('a', 'like');
    store().setPath('a', ['too-much']);
    store().clearVerdict('a');
    expect(store().verdicts.a).toBeUndefined();
  });

  it('clearVerdict is a no-op when no verdict exists', () => {
    const before = store().verdicts;
    store().clearVerdict('ghost');
    expect(store().verdicts).toBe(before);
  });
});

describe('card state — parse / persistence', () => {
  it('a device with no card-state key hydrates to an empty map and keeps the whole order (back-compat)', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b', 'c'], builtAt: 123 });
    // No FEED_CARD_STATE_SETTING_KEY at all — the pre-lifecycle device.
    await store().hydrate([item('a'), item('b'), item('c')]);
    const s = store();
    expect(s.order).toEqual(['a', 'b', 'c']); // no wipe
    expect(s.cardStates).toEqual({});
    expect(mockGetSetting).toHaveBeenCalledWith(FEED_CARD_STATE_SETTING_KEY);
  });

  it('drops malformed state entries but keeps the valid ones, and a malformed `tombs` does not crash or affect `states`', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({
      order: ['ok', 'short', 'badcode', 'nullat', 'inf'],
      builtAt: 1,
    });
    // Raw literal on purpose: JSON.stringify turns Infinity/NaN into null, so a
    // genuinely non-finite `at` can only be written by hand (`1e999` parses
    // back as Infinity). `tombs` here is a leftover shape from the removed
    // eviction mechanism — it must be ignored, not crash the parse.
    kv[FEED_CARD_STATE_SETTING_KEY] =
      `{"states":{"ok":["s",${NOW}],"short":["s"],"badcode":["x",${NOW}],` +
      `"nullat":["v",null],"inf":["s",1e999]},"tombs":"not-an-object"}`;
    await store().hydrate([
      item('ok'),
      item('short'),
      item('badcode'),
      item('nullat'),
      item('inf'),
    ]);
    const s = store();
    expect(s.cardStates).toEqual({ ok: { state: 'skipped', at: NOW } });
    // The order blob lives under a DIFFERENT key, so it is untouched.
    expect(s.order).toEqual(['ok', 'short', 'badcode', 'nullat', 'inf']);
  });

  it('legacy blob back-compat: an old `{ states, tombs }` blob parses `states` fine, ignores `tombs`, and has no effect on ingest', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a'], builtAt: 1 });
    kv[FEED_CARD_STATE_SETTING_KEY] = JSON.stringify({
      states: { a: ['s', NOW] },
      tombs: { z: NOW }, // from the removed eviction mechanism
    });
    await store().hydrate([item('a')]);
    expect(store().cardStates).toEqual({ a: { state: 'skipped', at: NOW } });

    // A legacy tombstone entry for 'z' must not suppress 'z' on ingest — the
    // whole tombstone mechanism is gone, `tombs` is inert dead weight now.
    // 'z' is genuinely new, so it prepends to the FRONT of order.
    store().ingest([item('z')], new Set());
    expect(store().order).toEqual(['z', 'a']);
  });

  it('round-trips: states serialize as [code, ms] under `states`, with no `tombs` key', async () => {
    seed([item('a'), item('b')]);
    store().markSkipped(['a'], NOW);
    store().markViewed('b', NOW);
    jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);

    const blob = lastCardBlob();
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob as string)).toEqual({
      states: { a: ['s', NOW], b: ['v', NOW] },
    });
    expect(blob as string).not.toContain('tombs');

    // Feed the exact bytes back through hydrate — must re-parse identically.
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b'], builtAt: 1 });
    kv[FEED_CARD_STATE_SETTING_KEY] = blob as string;
    useFeedOrderStore.setState({
      order: [],
      itemsById: {},
      hydrated: false,
      cardStates: {},
      hydrateStats: null,
    });
    await store().hydrate([item('a'), item('b')]);
    expect(store().cardStates).toEqual({
      a: { state: 'skipped', at: NOW },
      b: { state: 'viewed', at: NOW },
    });
  });

  it('markSkipped/markViewed do not write synchronously; exactly one write lands after the debounce', () => {
    seed([item('a'), item('b')]);
    store().markSkipped(['a'], NOW);
    store().markViewed('b', NOW);
    expect(cardWrites()).toHaveLength(0);
    jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 1);
    expect(cardWrites()).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(cardWrites()).toHaveLength(1); // the burst coalesced into one write
    jest.advanceTimersByTime(10 * PERSIST_DEBOUNCE_MS);
    expect(cardWrites()).toHaveLength(1); // trailing timer does not re-arm
  });
});

describe('flushPersist', () => {
  it('writes a pending debounced blob immediately (the app-background path)', () => {
    seed([item('a')]);
    store().markViewed('a', NOW);
    expect(cardWrites()).toHaveLength(0);
    store().flushPersist();
    expect(cardWrites()).toHaveLength(1);
    jest.advanceTimersByTime(10 * PERSIST_DEBOUNCE_MS);
    expect(cardWrites()).toHaveLength(1); // the timer was cancelled, not left armed
  });

  it('is a no-op when no write is pending', () => {
    seed([item('a')]);
    mockSetSetting.mockClear();
    store().flushPersist();
    expect(cardWrites()).toHaveLength(0);
  });
});

describe('markSkipped', () => {
  it('stamps `skipped` at the injected clock', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    expect(store().cardStates.a).toEqual({ state: 'skipped', at: NOW });
  });

  it('is WRITE-ONCE — a second pass does not restamp `at`', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    store().markSkipped(['a'], NOW + 5 * MIN);
    expect(store().cardStates.a).toEqual({ state: 'skipped', at: NOW });
  });

  it('never downgrades a `viewed` card', () => {
    seed([item('a')]);
    store().markViewed('a', NOW);
    store().markSkipped(['a'], NOW + MIN);
    expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW });
  });

  it('ignores ids that are not laid out', () => {
    seed([item('a')]);
    store().markSkipped(['ghost', 'a'], NOW);
    expect(store().cardStates).toEqual({ a: { state: 'skipped', at: NOW } });
  });

  it('is a no-op before hydrate', () => {
    // beforeEach leaves the store unhydrated.
    useFeedOrderStore.setState({ order: ['a'] });
    store().markSkipped(['a'], NOW);
    expect(store().cardStates).toEqual({});
  });

  it('does not call set() — so does not notify subscribers — when nothing changed', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    const listener = jest.fn();
    const unsubscribe = useFeedOrderStore.subscribe(listener);
    store().markSkipped(['a'], NOW + MIN); // already skipped (write-once)
    store().markSkipped(['ghost'], NOW); // not laid out
    store().markSkipped([], NOW); // empty batch
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('markViewed', () => {
  it('upgrades `skipped` → `viewed` with a fresh stamp', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    store().markViewed('a', NOW + 2 * MIN);
    expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW + 2 * MIN });
  });

  it('is idempotent once `viewed` — keeps the first stamp', () => {
    seed([item('a')]);
    store().markViewed('a', NOW);
    store().markViewed('a', NOW + 5 * MIN);
    expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW });
  });
});

describe('reset', () => {
  it('clears state and deletes the persisted KV', () => {
    seed([item('a'), item('b')]);
    store().setVerdict('a', 'like');
    store().reset();
    const s = store();
    expect(s.order).toEqual([]);
    expect(s.itemsById).toEqual({});
    expect(s.verdicts).toEqual({});
    expect(s.builtAt).toBeNull();
    expect(s.hydrated).toBe(false);
    expect(mockDeleteSetting).toHaveBeenCalledWith(FEED_ORDER_SETTING_KEY);
  });

  it('clears cardStates and deletes BOTH settings keys', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    store().reset();
    expect(store().cardStates).toEqual({});
    expect(mockDeleteSetting).toHaveBeenCalledWith(FEED_ORDER_SETTING_KEY);
    expect(mockDeleteSetting).toHaveBeenCalledWith(FEED_CARD_STATE_SETTING_KEY);
  });

  it('cancels a pending debounced persist so nothing re-writes the blob after the delete', () => {
    seed([item('a')]);
    store().markViewed('a', NOW); // arms the 1s trailing timer
    expect(store().cardStates.a).toEqual({ state: 'viewed', at: NOW }); // …it really is armed
    store().reset();
    jest.advanceTimersByTime(10 * PERSIST_DEBOUNCE_MS);
    expect(cardWrites()).toHaveLength(0);
  });
});
