// tracked-stories-poll-task.test.ts — tests for the 30-min tracked-stories
// poll task registration + handler. Mirrors push-token-check-task.test.ts's
// pattern: mock functions defined inside jest.mock factories (Babel hoists
// `import '../tracked-stories-poll-task'` above module-level consts).

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/database/services/tracked-story-service', () => ({
  getActiveForPoll: jest.fn(),
  applyUpdates: jest.fn(),
  resolveStableId: jest.fn(),
  recordMiss: jest.fn(),
  stampChecked: jest.fn(),
}));

jest.mock('@/lib/database/services/notification-service', () => ({
  notify: jest.fn(),
}));

jest.mock('@/lib/article-service', () => ({
  ArticleService: {
    getNewsClusterForArticle: jest.fn(),
    getTrackedStory: jest.fn(),
  },
}));

jest.mock('@/lib/nav-state', () => ({
  getCurrentPathname: jest.fn(() => '/logged-in/home'),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

// Load the task — triggers registration side-effect
import '../tracked-stories-poll-task';

const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const {
  getActiveForPoll: mockGetActiveForPoll,
  applyUpdates: mockApplyUpdates,
  resolveStableId: mockResolveStableId,
  recordMiss: mockRecordMiss,
  stampChecked: mockStampChecked,
} = jest.requireMock('@/lib/database/services/tracked-story-service') as any;
const { notify: mockNotify } = jest.requireMock('@/lib/database/services/notification-service') as any;
const {
  ArticleService: { getNewsClusterForArticle: mockGetNewsClusterForArticle, getTrackedStory: mockGetTrackedStory },
} = jest.requireMock('@/lib/article-service') as any;
const { getCurrentPathname: mockGetCurrentPathname } = jest.requireMock('@/lib/nav-state') as any;
const { captureException: mockCaptureException } = jest.requireMock('@/lib/logger').default as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-tracked-poll-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

function makeRow(overrides: Record<string, any> = {}) {
  return {
    id: 's1',
    stableClusterId: null,
    memberArticleIds: [],
    latestArticleId: null,
    ...overrides,
  };
}

describe('tracked-stories-poll-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name tracked-stories-poll', () => {
    expect(registeredDef.name).toBe('tracked-stories-poll');
  });

  it('has app-foreground trigger', () => {
    expect(registeredDef.triggers).toContain('app-foreground');
  });

  it('has a 30-minute frequency', () => {
    expect(registeredDef.frequency).toBe(30 * 60 * 1000);
  });

  it('has an authenticated condition', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toContain('authenticated');
  });

  it('has a network condition (skips offline — polling is a network call)', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toContain('network');
  });

  it('is exclusive', () => {
    expect(registeredDef.exclusive).toBe(true);
  });

  it('has a 20s timeout', () => {
    expect(registeredDef.timeout).toBe(20_000);
  });
});

describe('tracked-stories-poll-task handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentPathname.mockReturnValue('/logged-in/home');
    mockApplyUpdates.mockResolvedValue(undefined);
    mockResolveStableId.mockResolvedValue(undefined);
    mockRecordMiss.mockResolvedValue(undefined);
    mockStampChecked.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
  });

  it('does nothing when no story is due', async () => {
    mockGetActiveForPoll.mockResolvedValue([]);
    await registeredDef.handler(undefined, makeCtx());
    expect(mockGetTrackedStory).not.toHaveBeenCalled();
    expect(mockGetNewsClusterForArticle).not.toHaveBeenCalled();
  });

  it('caps the poll batch at 10 stories per run', async () => {
    mockGetActiveForPoll.mockResolvedValue([]);
    await registeredDef.handler(undefined, makeCtx());
    expect(mockGetActiveForPoll).toHaveBeenCalledWith(expect.any(Number), 10);
  });

  it('archive found with new members → applyUpdates + stamp, no notify', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'] }),
    ]);
    mockGetTrackedStory.mockResolvedValue({
      stableClusterId: 'clu-1',
      clusterSize: 3,
      lastRefreshedAt: new Date().toISOString(),
      articles: [{ articleId: 'a1' }, { articleId: 'a2' }],
    });

    await registeredDef.handler(undefined, makeCtx());

    expect(mockGetTrackedStory).toHaveBeenCalledWith('clu-1');
    expect(mockApplyUpdates).toHaveBeenCalledWith('s1', { newMemberIds: ['a2'] });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRecordMiss).not.toHaveBeenCalled();
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
  });

  it('archive found with no new members → recordMiss, no notify', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'] }),
    ]);
    mockGetTrackedStory.mockResolvedValue({
      stableClusterId: 'clu-1',
      articles: [{ articleId: 'a1' }],
    });

    await registeredDef.handler(undefined, makeCtx());

    expect(mockRecordMiss).toHaveBeenCalledWith('s1');
    expect(mockApplyUpdates).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('archive null → re-acquires via live cluster and adopts (resolveStableId + applyUpdates, no notify)', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'], latestArticleId: 'a1' }),
    ]);
    mockGetTrackedStory.mockResolvedValue(null);
    mockGetNewsClusterForArticle.mockResolvedValue({
      stableClusterId: 'clu-1-new',
      articles: { articles: [{ _id: 'a1' }, { _id: 'a2' }] },
    });

    await registeredDef.handler(undefined, makeCtx());

    expect(mockGetNewsClusterForArticle).toHaveBeenCalledWith('a1');
    expect(mockResolveStableId).toHaveBeenCalledWith('s1', 'clu-1-new');
    expect(mockApplyUpdates).toHaveBeenCalledWith('s1', { newMemberIds: ['a2'] });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
  });

  it('singleton (no stable id) promotes via getNewsClusterForArticle + resolveStableId', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: null, memberArticleIds: ['a1'], latestArticleId: 'a1' }),
    ]);
    mockGetNewsClusterForArticle.mockResolvedValue({
      stableClusterId: 'clu-promoted',
      articles: { articles: [{ _id: 'a1' }, { _id: 'a2' }] },
    });

    await registeredDef.handler(undefined, makeCtx());

    expect(mockGetTrackedStory).not.toHaveBeenCalled();
    expect(mockGetNewsClusterForArticle).toHaveBeenCalledWith('a1');
    expect(mockResolveStableId).toHaveBeenCalledWith('s1', 'clu-promoted');
    expect(mockApplyUpdates).toHaveBeenCalledWith('s1', { newMemberIds: ['a2'] });
  });

  it('no live cluster found → recordMiss', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: null, memberArticleIds: ['a1'], latestArticleId: 'a1' }),
    ]);
    mockGetNewsClusterForArticle.mockResolvedValue(null);

    await registeredDef.handler(undefined, makeCtx());

    expect(mockRecordMiss).toHaveBeenCalledWith('s1');
    expect(mockResolveStableId).not.toHaveBeenCalled();
    expect(mockApplyUpdates).not.toHaveBeenCalled();
  });

  it('no seed article id at all → recordMiss without a network call', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: null, memberArticleIds: [], latestArticleId: null }),
    ]);

    await registeredDef.handler(undefined, makeCtx());

    expect(mockGetNewsClusterForArticle).not.toHaveBeenCalled();
    expect(mockRecordMiss).toHaveBeenCalledWith('s1');
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
  });

  it('always stamps last_checked_at, even when a story throws', async () => {
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'] }),
      makeRow({ id: 's2', stableClusterId: 'clu-2', memberArticleIds: ['b1'] }),
    ]);
    mockGetTrackedStory
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ stableClusterId: 'clu-2', articles: [{ articleId: 'b1' }] });

    await registeredDef.handler(undefined, makeCtx());

    expect(mockCaptureException).toHaveBeenCalled();
    expect(mockStampChecked).toHaveBeenCalledWith('s1');
    expect(mockStampChecked).toHaveBeenCalledWith('s2');
    expect(mockStampChecked).toHaveBeenCalledTimes(2);
  });

  it('processes due stories serially, in order', async () => {
    const order: string[] = [];
    mockGetActiveForPoll.mockResolvedValue([
      makeRow({ id: 's1', stableClusterId: 'clu-1', memberArticleIds: ['a1'] }),
      makeRow({ id: 's2', stableClusterId: 'clu-2', memberArticleIds: ['b1'] }),
    ]);
    mockGetTrackedStory.mockImplementation(async (sid: string) => {
      order.push(sid);
      return { stableClusterId: sid, articles: [] };
    });

    await registeredDef.handler(undefined, makeCtx());

    expect(order).toEqual(['clu-1', 'clu-2']);
  });
});

export {};
