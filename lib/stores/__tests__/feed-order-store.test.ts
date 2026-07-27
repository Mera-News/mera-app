// feed-order-store — persisted static insert-only order tests. setting-service +
// logger are mocked so importing the store never touches a real WatermelonDB.
//
// Covers: hydrate (KV load + eviction of ids with no backing item + builtAt
// restore), first ingest into an empty order (feedCompare order + persist),
// freeze-zone invariant (ids ≤ frozenThroughIndex never shift, even when a new
// item outranks a frozen entry), insertion vs REFRESHED scores, opened-new-id
// skip, rep-switch dedupe (position kept, no duplicate, fresh rep data),
// missing-item entries ranking last, the verdict mirror, and reset (clears KV).
//
// Plus the card lifecycle: the separate `feed_card_state_v1` blob (defensive
// per-field parse + debounced round-trip), markSkipped/markViewed transitions,
// sweep eviction + the four-axis tombstones it leaves, and the ingest gate
// those tombstones drive (the sweep → ingest → skip → sweep re-insert loop).
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
  CARD_STATE_TTL_MS,
  FEED_CARD_STATE_SETTING_KEY,
  FEED_ORDER_SETTING_KEY,
  TOMBSTONE_TTL_MS,
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

/** `setSetting` writes are asserted per KEY — `ingest`/`sweep` write the order
 *  blob in the same tick as a card-state write, so a bare call count lies. */
const cardWrites = () =>
  mockSetSetting.mock.calls.filter(([key]) => key === FEED_CARD_STATE_SETTING_KEY);
const lastCardBlob = () => {
  const calls = cardWrites();
  return calls.length > 0 ? (calls[calls.length - 1][1] as string) : null;
};

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
    tombstones: {},
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
    tombstones: {},
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
  it('loads the persisted order, evicts ids with no backing item, restores builtAt', async () => {
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
});

describe('ingest — no-op until hydrated', () => {
  it('does nothing before hydrate', () => {
    // store starts unhydrated (beforeEach)
    store().ingest([item('a')], new Set(), 0);
    expect(store().order).toEqual([]);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

describe('ingest — initial build (empty order)', () => {
  it('inserts into the empty tail in pure feedCompare order and persists + stamps builtAt', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest(
      [item('a', { score: 0.8 }), item('b', { score: 1.0 }), item('c', { score: 0.5 })],
      new Set(),
      5,
    );
    // feedCompare = score desc → b, a, c.
    expect(store().order).toEqual(['b', 'a', 'c']);
    expect(store().builtAt).not.toBeNull();
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEED_ORDER_SETTING_KEY,
      expect.stringContaining('"order":["b","a","c"]'),
    );
  });

  it('skips genuinely-new ids that are already opened', () => {
    useFeedOrderStore.setState({ hydrated: true });
    store().ingest([item('a'), item('b')], new Set(['a']), 0);
    expect(store().order).toEqual(['b']);
  });
});

describe('ingest — freeze-zone invariant', () => {
  it('never shifts ids at or before frozenThroughIndex, even for a higher-scoring new item', () => {
    seed([item('a', { score: 1.0 }), item('b', { score: 0.9 }), item('c', { score: 0.8 })]);
    // Freeze through index 1 (a, b). z outranks everyone but must land AFTER the
    // freeze boundary (before the first unfrozen entry it beats = c).
    store().ingest(
      [
        item('a', { score: 1.0 }),
        item('b', { score: 0.9 }),
        item('c', { score: 0.8 }),
        item('z', { score: 2.0 }),
      ],
      new Set(),
      1,
    );
    expect(store().order).toEqual(['a', 'b', 'z', 'c']);
  });
});

describe('ingest — insertion respects refreshed scores', () => {
  it('compares a new item against the CURRENT refreshed row, not the original score', () => {
    seed([item('a', { score: 1.0 }), item('b', { score: 0.5 })]);
    // Refresh b down to 0.2 in the same ingest; new c (0.3) must beat the
    // refreshed b (0.2) and land between a and b. Freeze through index 0 (a).
    store().ingest(
      [item('a', { score: 1.0 }), item('b', { score: 0.2 }), item('c', { score: 0.3 })],
      new Set(),
      0,
    );
    expect(store().order).toEqual(['a', 'c', 'b']);
    expect(store().itemsById.b.score).toBe(0.2);
  });
});

describe('ingest — rep-switch dedupe', () => {
  it('updates the existing entry in place under its old id — no duplicate, position kept, fresh rep data', () => {
    seed([item('x', { score: 0.5, cluster: 'C1' })]);
    // New rep article y for the SAME stable cluster C1 (group grew).
    store().ingest([item('y', { score: 0.9, cluster: 'C1' })], new Set(), 0);
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
    store().ingest([item('y', { score: 0.9, memberIds: ['x', 'y'] })], new Set(), 0);
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
        0,
      );
      expect(store().order).toEqual(['x', 'y']);
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
        0,
      );
      expect(store().order).toEqual(['x', 'y']);
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
        0,
      );
      // p takes the row in place; q becomes its own card. Nothing is lost.
      expect(store().itemsById.x.suggestion.articleId).toBe('p');
      expect(store().order).toEqual(['x', 'q']);
    });
  });
});

describe('ingest — missing-item entries rank last', () => {
  it('inserts a new item BEFORE an order id that has no backing item', () => {
    // 'ghost' is in order but has no itemsById entry (a transient orphan).
    useFeedOrderStore.setState({
      order: ['a', 'ghost'],
      itemsById: { a: item('a', { score: 1.0 }) },
      builtAt: 1,
      hydrated: true,
      verdicts: {},
      cardStates: {},
      tombstones: {},
    });
    // Freeze through index 0 (a). New low-scoring z still beats the ghost.
    store().ingest([item('a', { score: 1.0 }), item('z', { score: 0.1 })], new Set(), 0);
    expect(store().order).toEqual(['a', 'z', 'ghost']);
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
  it('a device with no card-state key hydrates to empty maps and keeps the whole order (back-compat)', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b', 'c'], builtAt: 123 });
    // No FEED_CARD_STATE_SETTING_KEY at all — the pre-lifecycle device.
    await store().hydrate([item('a'), item('b'), item('c')]);
    const s = store();
    expect(s.order).toEqual(['a', 'b', 'c']); // no wipe
    expect(s.cardStates).toEqual({});
    expect(s.tombstones).toEqual({});
    expect(mockGetSetting).toHaveBeenCalledWith(FEED_CARD_STATE_SETTING_KEY);
  });

  it('drops malformed state entries but keeps the valid ones, and a malformed `tombs` does not discard `states`', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({
      order: ['ok', 'short', 'badcode', 'nullat', 'inf'],
      builtAt: 1,
    });
    // Raw literal on purpose: JSON.stringify turns Infinity/NaN into null, so a
    // genuinely non-finite `at` can only be written by hand (`1e999` parses
    // back as Infinity).
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
    expect(s.tombstones).toEqual({});
    // The order blob lives under a DIFFERENT key, so it is untouched.
    expect(s.order).toEqual(['ok', 'short', 'badcode', 'nullat', 'inf']);
  });

  it('round-trips: states serialize as [code, ms] under `states`, tombstones under `tombs`', async () => {
    seed([item('a'), item('b')]);
    useFeedOrderStore.setState({ tombstones: { gone: NOW - 1000 } });
    store().markSkipped(['a'], NOW);
    store().markViewed('b', NOW);
    jest.advanceTimersByTime(PERSIST_DEBOUNCE_MS);

    const blob = lastCardBlob();
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob as string)).toEqual({
      states: { a: ['s', NOW], b: ['v', NOW] },
      tombs: { gone: NOW - 1000 },
    });

    // Feed the exact bytes back through hydrate — must re-parse identically.
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b'], builtAt: 1 });
    kv[FEED_CARD_STATE_SETTING_KEY] = blob as string;
    useFeedOrderStore.setState({
      order: [],
      itemsById: {},
      hydrated: false,
      cardStates: {},
      tombstones: {},
    });
    await store().hydrate([item('a'), item('b')]);
    expect(store().cardStates).toEqual({
      a: { state: 'skipped', at: NOW },
      b: { state: 'viewed', at: NOW },
    });
    expect(store().tombstones).toEqual({ gone: NOW - 1000 });
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

  it('is WRITE-ONCE — a second pass does not restart the eviction clock', () => {
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

  it('ignores ids that are not laid out (a debounced flush landing after a sweep)', () => {
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

describe('sweep', () => {
  it('evicts a skipped card past the grace period and keeps one inside it', () => {
    seed([item('stale'), item('recent')]);
    store().markSkipped(['stale'], NOW - 11 * MIN);
    store().markSkipped(['recent'], NOW - 9 * MIN);
    expect(store().sweep({ force: false, nowMs: NOW })).toBe(1);
    expect(store().order).toEqual(['recent']);
  });

  it('NEVER evicts an unviewed card (no record), whatever its age or the force flag', () => {
    seed([item('a'), item('b')]);
    expect(store().sweep({ force: false, nowMs: NOW + 365 * 24 * 60 * MIN })).toBe(0);
    expect(store().sweep({ force: true, nowMs: NOW })).toBe(0);
    expect(store().order).toEqual(['a', 'b']);
    expect(store().tombstones).toEqual({});
  });

  it('force evicts stamped cards regardless of age, and returns the evicted count', () => {
    seed([item('a'), item('b'), item('c')]);
    store().markSkipped(['a'], NOW);
    store().markViewed('b', NOW);
    expect(store().sweep({ force: true, nowMs: NOW })).toBe(2);
    expect(store().order).toEqual(['c']);
  });

  it('prunes cardStates entries for evicted ids', () => {
    seed([item('a'), item('b')]);
    store().markSkipped(['a'], NOW);
    store().markViewed('b', NOW);
    store().sweep({ force: true, nowMs: NOW });
    expect(store().cardStates).toEqual({});
  });

  it('returns 0 and writes nothing when nothing is dirty', () => {
    seed([item('a')]);
    mockSetSetting.mockClear();
    expect(store().sweep({ force: false, nowMs: NOW })).toBe(0);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('is a hard no-op before hydrate (an unhydrated sweep would persist an empty order)', () => {
    useFeedOrderStore.setState({ order: ['a'], itemsById: { a: item('a') } });
    expect(store().sweep({ force: true, nowMs: NOW })).toBe(0);
    expect(store().order).toEqual(['a']);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('stamps `viewed` on a row opened on another surface that carries no state of its own', () => {
    seed([item('a'), item('b')]);
    expect(store().sweep({ force: false, nowMs: NOW, openedIds: new Set(['a']) })).toBe(0);
    // Joins the normal grace period rather than lingering forever.
    expect(store().cardStates).toEqual({ a: { state: 'viewed', at: NOW } });
    expect(store().order).toEqual(['a', 'b']);
  });

  it('tombstones all four identity axes: order id, rep articleId, stableClusterId, memberIds', () => {
    // A rep-switched row: `ingest` stored the fresh rep under the OLD order id,
    // so `id` ('x') and `suggestion.articleId` ('y') genuinely diverge.
    const repSwitched: FeedListItem = {
      ...item('y', { cluster: 'C1', memberIds: ['y', 'm1'] }),
      id: 'x',
    };
    useFeedOrderStore.setState({
      order: ['x'],
      itemsById: { x: repSwitched },
      builtAt: 1,
      hydrated: true,
      verdicts: {},
      cardStates: {},
      tombstones: {},
    });
    store().markSkipped(['x'], NOW);
    expect(store().sweep({ force: true, nowMs: NOW })).toBe(1);
    expect(store().tombstones).toEqual({ x: NOW, y: NOW, C1: NOW, m1: NOW });
  });
});

describe('ingest + tombstones — the re-insert loop', () => {
  it('does not re-insert an id a sweep just evicted', () => {
    const items = [item('a', { score: 0.5 }), item('b', { score: 0.4 })];
    seed(items);
    store().markSkipped(['a'], NOW);
    expect(store().sweep({ force: true, nowMs: NOW })).toBe(1);
    store().ingest(items, new Set(), 0);
    expect(store().order).toEqual(['b']);
  });

  it('does not insert a NEW representative of a tombstoned group (overlapping memberIds)', () => {
    // The oscillation case: a title-Jaccard group with no stableClusterId
    // re-elects its representative whenever a fresher member lands, so the
    // returning card has a different `it.id` than the one that was evicted.
    seed([item('a', { memberIds: ['a', 'a2'] })]);
    store().markSkipped(['a'], NOW);
    store().sweep({ force: true, nowMs: NOW });
    store().ingest([item('a2', { memberIds: ['a2', 'a'] })], new Set(), 0);
    expect(store().order).toEqual([]);
  });

  it('does not insert a different article sharing the tombstoned stableClusterId', () => {
    seed([item('a', { cluster: 'C9' })]);
    store().markSkipped(['a'], NOW);
    store().sweep({ force: true, nowMs: NOW });
    store().ingest([item('z', { cluster: 'C9' })], new Set(), 0);
    expect(store().order).toEqual([]);
  });

  it('an unrelated tombstone does not block an unrelated new item', () => {
    seed([]);
    useFeedOrderStore.setState({ tombstones: { unrelated: NOW } });
    store().ingest([item('n', { score: 0.5 })], new Set(), 0);
    expect(store().order).toEqual(['n']);
  });

  it('a tombstoned id already in `order` is still refreshed in place', () => {
    // The tombstone gate sits AFTER the known-row check on purpose.
    seed([item('a', { score: 0.9 })]);
    useFeedOrderStore.setState({ tombstones: { a: NOW } });
    store().ingest([item('a', { score: 0.2 })], new Set(), 0);
    expect(store().order).toEqual(['a']);
    expect(store().itemsById.a.score).toBe(0.2);
  });

  it('prunes a tombstone past TOMBSTONE_TTL_MS, after which the story ingests normally again', () => {
    seed([]);
    useFeedOrderStore.setState({ tombstones: { a: NOW - TOMBSTONE_TTL_MS - 1 } });
    store().ingest([item('a')], new Set(), 0);
    expect(store().order).toEqual([]); // still blocked

    store().sweep({ force: false, nowMs: NOW });
    expect(store().tombstones).toEqual({});
    store().ingest([item('a')], new Set(), 0);
    expect(store().order).toEqual(['a']);
  });

  it('keeps the NEWEST entries when the tombstone cap is exceeded', () => {
    const CAP = 2000; // mirrors the store's module-private MAX_TOMBSTONES
    const tombstones: Record<string, number> = {};
    for (let i = 0; i < CAP + 500; i++) tombstones[`k${i}`] = NOW - i; // k0 = newest
    seed([]);
    useFeedOrderStore.setState({ tombstones });
    store().sweep({ force: true, nowMs: NOW });
    const kept = store().tombstones;
    expect(Object.keys(kept)).toHaveLength(CAP);
    expect(kept.k0).toBe(NOW);
    expect(kept[`k${CAP - 1}`]).toBe(NOW - (CAP - 1));
    expect(kept[`k${CAP}`]).toBeUndefined();
  });
});

describe('hydrate — card lifecycle', () => {
  it('an EMPTY candidate pool empties `order` WITHOUT tombstoning — hydrate races the suggestion store and must not brick the feed for 48h', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['a', 'b', 'c'], builtAt: 7 });
    // FeedScreen fires hydrate on `dbReady`, often before any suggestion loads.
    await store().hydrate([]);
    expect(store().order).toEqual([]);
    expect(store().tombstones).toEqual({});
    expect(cardWrites()).toHaveLength(0);

    // …the suggestion store lands a moment later and the rows come straight back.
    store().ingest(
      [item('a', { score: 0.9 }), item('b', { score: 0.8 }), item('c', { score: 0.7 })],
      new Set(),
      0,
    );
    expect(store().order).toEqual(['a', 'b', 'c']);
  });

  it('launch sweep evicts + tombstones a persisted `skipped` past the grace period, sparing a fresh one', async () => {
    kv[FEED_ORDER_SETTING_KEY] = JSON.stringify({ order: ['old', 'fresh'], builtAt: 7 });
    kv[FEED_CARD_STATE_SETTING_KEY] = JSON.stringify({
      states: { old: ['s', NOW - 11 * MIN], fresh: ['s', NOW - MIN] },
      tombs: {},
    });
    // Both still have a live backing item, so the launch sweep tombstones normally.
    await store().hydrate([item('old', { cluster: 'C-old' }), item('fresh')]);
    const s = store();
    expect(s.order).toEqual(['fresh']);
    expect(s.cardStates).toEqual({ fresh: { state: 'skipped', at: NOW - MIN } });
    expect(s.tombstones).toEqual({ old: NOW, 'C-old': NOW });
    expect(CARD_STATE_TTL_MS).toBe(10 * MIN);
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

  it('clears cardStates + tombstones and deletes BOTH settings keys', () => {
    seed([item('a')]);
    store().markSkipped(['a'], NOW);
    useFeedOrderStore.setState({ tombstones: { t: NOW } });
    store().reset();
    expect(store().cardStates).toEqual({});
    expect(store().tombstones).toEqual({});
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
