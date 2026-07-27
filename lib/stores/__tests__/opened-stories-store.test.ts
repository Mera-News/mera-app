// opened-stories-store — hydrate (load + merge optimistic), markOpened
// (synchronous add of article id + optional stable cluster id). The impression
// service is mocked so importing the store never touches a real WatermelonDB.
//
// `articleIds` is the Feed's ingest-gate key (article axis only); `ids` is the
// article ∪ cluster union used by the Dashboard read-ticks + P_SEEN scoring.
// hydrate() now sources from `getOpenedSeenBreakdown` (not `getOpenedSeenSet`)
// so it can populate both sets from the one DB read.

function makeBreakdown(articleIds: string[], clusterIds: string[] = []) {
  return {
    articleIds: new Set(articleIds),
    clusterIds: new Set(clusterIds),
    stats: {
      rowCount: articleIds.length,
      articleIdCount: articleIds.length,
      clusterIdCount: clusterIds.length,
      unionSize: new Set([...articleIds, ...clusterIds]).size,
      oldestFirstSeenAtMs: null,
      newestLastSeenAtMs: null,
      ageBuckets: { le24h: 0, d1to7: 0, d7to30: 0 },
    },
  };
}

const mockGetOpenedSeenBreakdown = jest.fn(() => Promise.resolve(makeBreakdown([])));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getOpenedSeenBreakdown: () => mockGetOpenedSeenBreakdown(),
}));

const mockCapture = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...a: unknown[]) => mockCapture(...a),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { useOpenedStoriesStore } from '../opened-stories-store';

beforeEach(() => {
  jest.clearAllMocks();
  useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set(), hydrated: false });
  mockGetOpenedSeenBreakdown.mockResolvedValue(makeBreakdown([]));
});

describe('opened-stories-store', () => {
  it('starts empty and unhydrated', () => {
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.size).toBe(0);
    expect(s.articleIds.size).toBe(0);
    expect(s.hydrated).toBe(false);
  });

  it('hydrate populates `ids` with the article ∪ cluster union and `articleIds` with article ids only', async () => {
    mockGetOpenedSeenBreakdown.mockResolvedValueOnce(makeBreakdown(['a1', 'a2'], ['clu-1']));
    await useOpenedStoriesStore.getState().hydrate();
    const s = useOpenedStoriesStore.getState();
    expect([...s.ids].sort()).toEqual(['a1', 'a2', 'clu-1']);
    expect([...s.articleIds].sort()).toEqual(['a1', 'a2']);
    expect(s.hydrated).toBe(true);
  });

  it('markOpened adds the article id and stable cluster id synchronously', () => {
    useOpenedStoriesStore.getState().markOpened('art-9', 'stable-9');
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.has('art-9')).toBe(true);
    expect(s.ids.has('stable-9')).toBe(true);
  });

  it('markOpened(articleId, clusterId) adds the cluster id to `ids` but NOT to `articleIds`', () => {
    useOpenedStoriesStore.getState().markOpened('art-9', 'stable-9');
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.has('stable-9')).toBe(true);
    expect(s.articleIds.has('stable-9')).toBe(false);
    expect(s.articleIds.has('art-9')).toBe(true);
  });

  it('markOpened without a stable cluster id leaves `articleIds` correct', () => {
    useOpenedStoriesStore.getState().markOpened('art-only');
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.has('art-only')).toBe(true);
    expect(s.ids.size).toBe(1);
    expect([...s.articleIds]).toEqual(['art-only']);
  });

  it('an optimistic markOpened that lands BEFORE hydrate is preserved in BOTH sets (merge, not replace)', async () => {
    useOpenedStoriesStore.getState().markOpened('optimistic', 'optimistic-clu');
    mockGetOpenedSeenBreakdown.mockResolvedValueOnce(makeBreakdown(['from-db'], ['from-db-clu']));
    await useOpenedStoriesStore.getState().hydrate();
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.has('optimistic')).toBe(true);
    expect(s.ids.has('optimistic-clu')).toBe(true);
    expect(s.ids.has('from-db')).toBe(true);
    expect(s.ids.has('from-db-clu')).toBe(true);
    expect(s.articleIds.has('optimistic')).toBe(true);
    expect(s.articleIds.has('from-db')).toBe(true);
    // The optimistic cluster id must never leak into articleIds.
    expect(s.articleIds.has('optimistic-clu')).toBe(false);
  });

  it('markOpened replaces the Set reference (new identity for subscribers)', () => {
    const before = useOpenedStoriesStore.getState().ids;
    useOpenedStoriesStore.getState().markOpened('art-x');
    expect(useOpenedStoriesStore.getState().ids).not.toBe(before);
  });

  it('hydrate flips hydrated even when the DB read throws', async () => {
    mockGetOpenedSeenBreakdown.mockRejectedValueOnce(new Error('db error'));
    await useOpenedStoriesStore.getState().hydrate();
    expect(useOpenedStoriesStore.getState().hydrated).toBe(true);
    expect(mockCapture).toHaveBeenCalled();
  });
});
