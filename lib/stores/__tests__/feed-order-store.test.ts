// feed-order-store — persisted static insert-only order tests. setting-service +
// logger are mocked so importing the store never touches a real WatermelonDB.
//
// Covers: hydrate (KV load + eviction of ids with no backing item + builtAt
// restore), first ingest into an empty order (feedCompare order + persist),
// freeze-zone invariant (ids ≤ frozenThroughIndex never shift, even when a new
// item outranks a frozen entry), insertion vs REFRESHED scores, opened-new-id
// skip, rep-switch dedupe (position kept, no duplicate, fresh rep data),
// missing-item entries ranking last, the verdict mirror, and reset (clears KV).

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
  FEED_ORDER_SETTING_KEY,
  useFeedOrderStore,
} from '../feed-order-store';
// eslint-disable-next-line import/first
import type { FeedListItem } from '../feed-list-selector';
// eslint-disable-next-line import/first
import type { ForYouSuggestion } from '../for-you-store';

function item(
  id: string,
  over: { score?: number; pubMs?: number; cluster?: string | null } = {},
): FeedListItem {
  const clusters = over.cluster ? [{ stableClusterId: over.cluster }] : [];
  const suggestion = {
    _id: id,
    articleId: id,
    firstPubDate: new Date(over.pubMs ?? 1_000).toISOString(),
    clusters,
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: 1,
    breaking: false,
    score: over.score ?? 0.5,
  };
}

const store = () => useFeedOrderStore.getState();

/** Force the store into a hydrated state with a given order/itemsById. */
function seed(items: FeedListItem[], builtAt: number | null = 1) {
  const itemsById: Record<string, FeedListItem> = {};
  for (const it of items) itemsById[it.id] = it;
  useFeedOrderStore.setState({
    order: items.map((it) => it.id),
    itemsById,
    builtAt,
    hydrated: true,
    verdicts: {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useFeedOrderStore.setState({
    order: [],
    itemsById: {},
    builtAt: null,
    hydrated: false,
    verdicts: {},
  });
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
});
