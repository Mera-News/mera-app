// tracked-story-reconcile.test.ts — unit tests for the feed-sync-piggybacked
// tracked-story reconcile step. A followed story is a TOPIC, so growth matches
// suggestions by `topic_id` (the legacy stable-cluster pass was removed once
// legacy follows auto-migrate to the topic model).

const mockGetActiveForTopicReconcile = jest.fn();
const mockApplyUpdates = jest.fn();
const mockStampChecked = jest.fn();
const mockNotify = jest.fn();
const mockCaptureException = jest.fn();
const mockFetch = jest.fn();
const mockQuery = jest.fn((..._args: any[]) => ({ fetch: (...args: any[]) => mockFetch(...args) }));
const mockGet = jest.fn((..._args: any[]) => ({ query: (...args: any[]) => mockQuery(...args) }));

jest.mock('@/lib/database/services/tracked-story-service', () => ({
  getActiveForTopicReconcile: (...args: any[]) => mockGetActiveForTopicReconcile(...args),
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

const sug = (
  id: string,
  topicIds: string[],
  extra: Record<string, any> = {},
) => ({
  id,
  matchedTopicsJson: JSON.stringify(topicIds.map((t) => ({ topicId: t, text: t }))),
  titleEn: extra.titleEn ?? `Title ${id}`,
  firstPubDate: extra.firstPubDate ?? new Date(1700000000000),
  imageUrl: extra.imageUrl ?? null,
  publicationName: extra.publicationName ?? null,
});

describe('reconcileTrackedStories — topic path', () => {
  it('no-ops (no query, no writes) when nothing is tracked', async () => {
    mockGetActiveForTopicReconcile.mockResolvedValue([]);

    await reconcileTrackedStories();

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockApplyUpdates).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockStampChecked).not.toHaveBeenCalled();
  });

  it('grows a topic story from suggestions matching its topic id, with snapshots (no notification)', async () => {
    mockGetActiveForTopicReconcile.mockResolvedValue([
      { id: 't1', topicId: 'top-1', memberArticleIds: ['a1'] },
    ]);
    mockFetch.mockResolvedValue([
      sug('a1', ['top-1']), // already a member
      sug('a2', ['top-1'], { titleEn: 'Fresh', firstPubDate: new Date(1700000005000), publicationName: 'BBC' }), // new
      sug('a3', ['top-9']), // matches a different topic
    ]);

    await reconcileTrackedStories();

    expect(mockApplyUpdates).toHaveBeenCalledTimes(1);
    expect(mockApplyUpdates).toHaveBeenCalledWith('t1', {
      newMemberIds: ['a2'],
      newSnapshots: [
        {
          articleId: 'a2',
          title: 'Fresh',
          pubDateMs: 1700000005000,
          imageUrl: undefined,
          publicationName: 'BBC',
        },
      ],
    });
    expect(mockNotify).not.toHaveBeenCalled();
    // Topic stories are stamped checked but NEVER end (no recordMiss here).
    expect(mockStampChecked).toHaveBeenCalledWith('t1');
  });

  it('stamps but does not grow / notify when no fresh members match', async () => {
    mockGetActiveForTopicReconcile.mockResolvedValue([
      { id: 't1', topicId: 'top-1', memberArticleIds: ['a1'] },
    ]);
    mockFetch.mockResolvedValue([sug('a1', ['top-1'])]); // only the known member

    await reconcileTrackedStories();

    expect(mockApplyUpdates).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockStampChecked).toHaveBeenCalledWith('t1');
  });

  it('grows multiple topic stories, each from its own matched suggestions', async () => {
    mockGetActiveForTopicReconcile.mockResolvedValue([
      { id: 't1', topicId: 'top-1', memberArticleIds: [] },
      { id: 't2', topicId: 'top-2', memberArticleIds: [] },
    ]);
    mockFetch.mockResolvedValue([
      sug('a1', ['top-1']),
      sug('b1', ['top-2']),
    ]);

    await reconcileTrackedStories();

    expect(mockApplyUpdates).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ newMemberIds: ['a1'] }),
    );
    expect(mockApplyUpdates).toHaveBeenCalledWith(
      't2',
      expect.objectContaining({ newMemberIds: ['b1'] }),
    );
    expect(mockStampChecked).toHaveBeenCalledWith('t1');
    expect(mockStampChecked).toHaveBeenCalledWith('t2');
  });

  it('isolates a per-story failure — remaining stories are still processed and stamped', async () => {
    mockGetActiveForTopicReconcile.mockResolvedValue([
      { id: 't1', topicId: 'top-1', memberArticleIds: [] },
      { id: 't2', topicId: 'top-2', memberArticleIds: [] },
    ]);
    mockFetch.mockResolvedValue([
      sug('a1', ['top-1']),
      sug('b1', ['top-2']),
    ]);
    mockApplyUpdates.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await reconcileTrackedStories();

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'tracked-story-reconcile' }),
        extra: { trackedStoryId: 't1' },
      }),
    );
    // t2's own applyUpdates still ran despite t1's failure.
    expect(mockApplyUpdates).toHaveBeenCalledTimes(2);
    // Both get stamped, including the one that threw.
    expect(mockStampChecked).toHaveBeenCalledWith('t1');
    expect(mockStampChecked).toHaveBeenCalledWith('t2');
  });
});
