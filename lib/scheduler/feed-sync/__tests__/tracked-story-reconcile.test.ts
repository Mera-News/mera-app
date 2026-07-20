// tracked-story-reconcile.test.ts — unit tests for the feed-sync-piggybacked
// tracked-story reconcile step.

const mockGetActiveForReconcile = jest.fn();
const mockApplyUpdates = jest.fn();
const mockStampChecked = jest.fn();
const mockNotify = jest.fn();
const mockCaptureException = jest.fn();
const mockFetch = jest.fn();
const mockQuery = jest.fn((..._args: any[]) => ({ fetch: (...args: any[]) => mockFetch(...args) }));
const mockGet = jest.fn((..._args: any[]) => ({ query: (...args: any[]) => mockQuery(...args) }));

jest.mock('@/lib/database/services/tracked-story-service', () => ({
  getActiveForReconcile: (...args: any[]) => mockGetActiveForReconcile(...args),
  applyUpdates: (...args: any[]) => mockApplyUpdates(...args),
  stampChecked: (...args: any[]) => mockStampChecked(...args),
}));

jest.mock('@/lib/database/services/notification-service', () => ({
  notify: (...args: any[]) => mockNotify(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@/lib/database', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockGet(...args) },
}));

import { reconcileTrackedStories } from '../tracked-story-reconcile';

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyUpdates.mockResolvedValue(undefined);
  mockStampChecked.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
});

describe('reconcileTrackedStories', () => {
  it('no-ops (no query, no writes) when nothing is tracked', async () => {
    mockGetActiveForReconcile.mockResolvedValue([]);

    await reconcileTrackedStories();

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockApplyUpdates).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockStampChecked).not.toHaveBeenCalled();
  });

  it('applies updates + fires exactly one notify for a story that gained members', async () => {
    mockGetActiveForReconcile.mockResolvedValue([
      { id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'], latestArticleId: 'a1' },
      { id: 's2', stableClusterId: 'clu-2', memberArticleIds: ['b1'], latestArticleId: 'b1' },
    ]);
    mockFetch.mockResolvedValue([
      { id: 'a1', stableClusterId: 'clu-1' },
      { id: 'a2', stableClusterId: 'clu-1' }, // new for s1
      { id: 'a3', stableClusterId: 'clu-1' }, // new for s1
      { id: 'b1', stableClusterId: 'clu-2' }, // already known for s2 — no new members
    ]);

    await reconcileTrackedStories();

    expect(mockApplyUpdates).toHaveBeenCalledTimes(1);
    expect(mockApplyUpdates).toHaveBeenCalledWith('s1', { newMemberIds: ['a2', 'a3'] });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      type: 'tracked_story_update',
      title: 'notifications.trackedStoryUpdateTitle',
      body: 'notifications.trackedStoryUpdateBody',
      icon: 'track-changes',
      context: { trackedStoryId: 's1', count: 2 },
      source: 'tracked-stories',
    });

    // Both examined stories get stamped, found-new or not.
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
    expect(mockStampChecked).toHaveBeenCalledWith('s2');
    expect(mockStampChecked).toHaveBeenCalledTimes(2);
  });

  it('runs one indexed query scoped to the tracked stable ids', async () => {
    mockGetActiveForReconcile.mockResolvedValue([
      { id: 's1', stableClusterId: 'clu-1', memberArticleIds: [], latestArticleId: null },
      { id: 's2', stableClusterId: 'clu-2', memberArticleIds: [], latestArticleId: null },
    ]);
    mockFetch.mockResolvedValue([]);

    await reconcileTrackedStories();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('article_suggestions');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('isolates a per-story failure — remaining stories are still processed and stamped', async () => {
    mockGetActiveForReconcile.mockResolvedValue([
      { id: 's1', stableClusterId: 'clu-1', memberArticleIds: [], latestArticleId: null },
      { id: 's2', stableClusterId: 'clu-2', memberArticleIds: [], latestArticleId: null },
    ]);
    mockFetch.mockResolvedValue([
      { id: 'a1', stableClusterId: 'clu-1' },
      { id: 'b1', stableClusterId: 'clu-2' },
    ]);
    mockApplyUpdates.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await reconcileTrackedStories();

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'tracked-story-reconcile' }),
        extra: { trackedStoryId: 's1' },
      }),
    );
    // s2's own applyUpdates still ran despite s1's failure.
    expect(mockApplyUpdates).toHaveBeenCalledTimes(2);
    expect(mockApplyUpdates).toHaveBeenNthCalledWith(2, 's2', { newMemberIds: ['b1'] });
    // Both get stamped, including the one that threw.
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
    expect(mockStampChecked).toHaveBeenCalledWith('s2');
  });

  it('rows with no stable_cluster_id on the suggestion are ignored (defensive)', async () => {
    mockGetActiveForReconcile.mockResolvedValue([
      { id: 's1', stableClusterId: 'clu-1', memberArticleIds: [], latestArticleId: null },
    ]);
    mockFetch.mockResolvedValue([{ id: 'a1', stableClusterId: null }]);

    await reconcileTrackedStories();

    expect(mockApplyUpdates).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
  });
});
