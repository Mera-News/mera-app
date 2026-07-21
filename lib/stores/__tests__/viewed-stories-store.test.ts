// viewed-stories-store — hydrate (load + merge optimistic), markViewed
// (synchronous add of article id + optional stable cluster id). The impression
// service is mocked so importing the store never touches a real WatermelonDB.

const mockGetSeenSet = jest.fn((): Promise<Set<string>> => Promise.resolve(new Set()));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getSeenSet: () => mockGetSeenSet(),
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
import { useViewedStoriesStore } from '../viewed-stories-store';

beforeEach(() => {
  jest.clearAllMocks();
  useViewedStoriesStore.setState({ ids: new Set(), hydrated: false });
  mockGetSeenSet.mockResolvedValue(new Set());
});

describe('viewed-stories-store', () => {
  it('starts empty and unhydrated', () => {
    const s = useViewedStoriesStore.getState();
    expect(s.ids.size).toBe(0);
    expect(s.hydrated).toBe(false);
  });

  it('hydrate loads the seen set and flips hydrated', async () => {
    mockGetSeenSet.mockResolvedValueOnce(new Set(['a1', 'clu-1']));
    await useViewedStoriesStore.getState().hydrate();
    const s = useViewedStoriesStore.getState();
    expect([...s.ids].sort()).toEqual(['a1', 'clu-1']);
    expect(s.hydrated).toBe(true);
  });

  it('markViewed adds the article id and stable cluster id synchronously', () => {
    useViewedStoriesStore.getState().markViewed('art-9', 'stable-9');
    const ids = useViewedStoriesStore.getState().ids;
    expect(ids.has('art-9')).toBe(true);
    expect(ids.has('stable-9')).toBe(true);
  });

  it('markViewed without a stable cluster id adds only the article id', () => {
    useViewedStoriesStore.getState().markViewed('art-only');
    const ids = useViewedStoriesStore.getState().ids;
    expect(ids.has('art-only')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('hydrate MERGES an optimistic markViewed that raced ahead of the DB read', async () => {
    useViewedStoriesStore.getState().markViewed('optimistic');
    mockGetSeenSet.mockResolvedValueOnce(new Set(['from-db']));
    await useViewedStoriesStore.getState().hydrate();
    const ids = useViewedStoriesStore.getState().ids;
    expect(ids.has('optimistic')).toBe(true);
    expect(ids.has('from-db')).toBe(true);
  });

  it('markViewed replaces the Set reference (new identity for subscribers)', () => {
    const before = useViewedStoriesStore.getState().ids;
    useViewedStoriesStore.getState().markViewed('art-x');
    expect(useViewedStoriesStore.getState().ids).not.toBe(before);
  });

  it('hydrate flips hydrated even when the DB read throws', async () => {
    mockGetSeenSet.mockRejectedValueOnce(new Error('db error'));
    await useViewedStoriesStore.getState().hydrate();
    expect(useViewedStoriesStore.getState().hydrated).toBe(true);
    expect(mockCapture).toHaveBeenCalled();
  });
});
