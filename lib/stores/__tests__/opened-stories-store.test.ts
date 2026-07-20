// opened-stories-store — hydrate (load + merge optimistic), markOpened
// (synchronous add of article id + optional stable cluster id). The impression
// service is mocked so importing the store never touches a real WatermelonDB.

const mockGetOpenedSeenSet = jest.fn((): Promise<Set<string>> => Promise.resolve(new Set()));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getOpenedSeenSet: () => mockGetOpenedSeenSet(),
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
  useOpenedStoriesStore.setState({ ids: new Set(), hydrated: false });
  mockGetOpenedSeenSet.mockResolvedValue(new Set());
});

describe('opened-stories-store', () => {
  it('starts empty and unhydrated', () => {
    const s = useOpenedStoriesStore.getState();
    expect(s.ids.size).toBe(0);
    expect(s.hydrated).toBe(false);
  });

  it('hydrate loads the opened seen set and flips hydrated', async () => {
    mockGetOpenedSeenSet.mockResolvedValueOnce(new Set(['a1', 'clu-1']));
    await useOpenedStoriesStore.getState().hydrate();
    const s = useOpenedStoriesStore.getState();
    expect([...s.ids].sort()).toEqual(['a1', 'clu-1']);
    expect(s.hydrated).toBe(true);
  });

  it('markOpened adds the article id and stable cluster id synchronously', () => {
    useOpenedStoriesStore.getState().markOpened('art-9', 'stable-9');
    const ids = useOpenedStoriesStore.getState().ids;
    expect(ids.has('art-9')).toBe(true);
    expect(ids.has('stable-9')).toBe(true);
  });

  it('markOpened without a stable cluster id adds only the article id', () => {
    useOpenedStoriesStore.getState().markOpened('art-only');
    const ids = useOpenedStoriesStore.getState().ids;
    expect(ids.has('art-only')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('hydrate MERGES an optimistic markOpened that raced ahead of the DB read', async () => {
    useOpenedStoriesStore.getState().markOpened('optimistic');
    mockGetOpenedSeenSet.mockResolvedValueOnce(new Set(['from-db']));
    await useOpenedStoriesStore.getState().hydrate();
    const ids = useOpenedStoriesStore.getState().ids;
    expect(ids.has('optimistic')).toBe(true);
    expect(ids.has('from-db')).toBe(true);
  });

  it('markOpened replaces the Set reference (new identity for subscribers)', () => {
    const before = useOpenedStoriesStore.getState().ids;
    useOpenedStoriesStore.getState().markOpened('art-x');
    expect(useOpenedStoriesStore.getState().ids).not.toBe(before);
  });

  it('hydrate flips hydrated even when the DB read throws', async () => {
    mockGetOpenedSeenSet.mockRejectedValueOnce(new Error('db error'));
    await useOpenedStoriesStore.getState().hydrate();
    expect(useOpenedStoriesStore.getState().hydrated).toBe(true);
    expect(mockCapture).toHaveBeenCalled();
  });
});
