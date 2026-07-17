// data-cleanup-task.test.ts — tests for data-cleanup-task registration + handler

// All mock functions are defined INSIDE the jest.mock factories (not as module-level
// consts) to avoid the hoisting issue: Babel hoists `import '../data-cleanup-task'`
// above both jest.mock() and const declarations, so module-level consts are still
// undefined when the mock factory's return values are called at module-load time.
// Tests access the mocks via jest.requireMock().

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/scheduler/scheduler-persistence', () => ({
  pruneOldJobs: jest.fn(),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  deleteOldSuggestions: jest.fn(),
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  refreshSuggestionsInStoreUnsafe: jest.fn(),
}));

jest.mock('@/lib/database/services/story-impression-service', () => ({
  deleteOlderThan: jest.fn(),
}));

jest.mock('@/lib/database/services/notification-service', () => ({
  deleteOlderThan: jest.fn(),
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
import '../data-cleanup-task';

// Retrieve mock references after module load
const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { pruneOldJobs: mockPruneOldJobs } = jest.requireMock('@/lib/scheduler/scheduler-persistence') as any;
const { deleteOldSuggestions: mockDeleteOldSuggestions } = jest.requireMock('@/lib/database/services/article-suggestion-service') as any;
const { refreshSuggestionsInStoreUnsafe: mockRefreshSuggestionsInStoreUnsafe } = jest.requireMock('@/lib/services/SuggestionSyncService') as any;
const { deleteOlderThan: mockDeleteOldImpressions } = jest.requireMock('@/lib/database/services/story-impression-service') as any;
const { deleteOlderThan: mockDeleteOldNotifications } = jest.requireMock('@/lib/database/services/notification-service') as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-cleanup-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('data-cleanup-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name data-cleanup', () => {
    expect(registeredDef.name).toBe('data-cleanup');
  });

  it('has db-ready condition', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toContain('db-ready');
  });

  it('is exclusive', () => {
    expect(registeredDef.exclusive).toBe(true);
  });

  it('has a daily frequency', () => {
    // 24h in ms
    expect(registeredDef.frequency).toBe(24 * 60 * 60 * 1000);
  });

  it('has maxAttempts of 2', () => {
    expect(registeredDef.maxAttempts).toBe(2);
  });

  it('has no triggers (timer-only)', () => {
    expect(registeredDef.triggers).toEqual([]);
  });
});

describe('data-cleanup-task handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPruneOldJobs.mockResolvedValue(undefined);
    mockDeleteOldSuggestions.mockResolvedValue(0);
    mockRefreshSuggestionsInStoreUnsafe.mockResolvedValue(undefined);
    mockDeleteOldImpressions.mockResolvedValue(0);
    mockDeleteOldNotifications.mockResolvedValue(0);
  });

  it('calls pruneOldJobs', async () => {
    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);
    expect(mockPruneOldJobs).toHaveBeenCalledTimes(1);
  });

  it('calls deleteOldSuggestions with a cutoff timestamp', async () => {
    const before = Date.now();
    await registeredDef.handler(undefined, makeCtx());
    const after = Date.now();

    expect(mockDeleteOldSuggestions).toHaveBeenCalledWith(expect.any(Number));
    const cutoff = mockDeleteOldSuggestions.mock.calls[0][0];
    // cutoff should be roughly 48h ago
    const SUGGESTION_TTL_MS = 48 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - SUGGESTION_TTL_MS - 100);
    expect(cutoff).toBeLessThanOrEqual(after - SUGGESTION_TTL_MS + 100);
  });

  it('does NOT call refreshSuggestionsInStoreUnsafe when 0 suggestions deleted', async () => {
    mockDeleteOldSuggestions.mockResolvedValue(0);

    await registeredDef.handler(undefined, makeCtx());

    expect(mockRefreshSuggestionsInStoreUnsafe).not.toHaveBeenCalled();
  });

  it('calls refreshSuggestionsInStoreUnsafe when >0 suggestions deleted', async () => {
    mockDeleteOldSuggestions.mockResolvedValue(5);

    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);

    expect(mockRefreshSuggestionsInStoreUnsafe).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('5'));
  });

  it('logs deleted count when pruning occurs', async () => {
    mockDeleteOldSuggestions.mockResolvedValue(3);

    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('3'));
  });

  it('propagates errors from pruneOldJobs', async () => {
    mockPruneOldJobs.mockRejectedValueOnce(new Error('db error'));

    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow('db error');
  });

  it('propagates errors from deleteOldSuggestions', async () => {
    mockDeleteOldSuggestions.mockRejectedValueOnce(new Error('delete error'));

    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow('delete error');
  });

  it('prunes story impressions older than 30d', async () => {
    const before = Date.now();
    await registeredDef.handler(undefined, makeCtx());
    const after = Date.now();

    expect(mockDeleteOldImpressions).toHaveBeenCalledTimes(1);
    const IMPRESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = mockDeleteOldImpressions.mock.calls[0][0];
    expect(cutoff).toBeGreaterThanOrEqual(before - IMPRESSION_TTL_MS - 100);
    expect(cutoff).toBeLessThanOrEqual(after - IMPRESSION_TTL_MS + 100);
  });

  it('prunes notifications older than 90d', async () => {
    const before = Date.now();
    await registeredDef.handler(undefined, makeCtx());
    const after = Date.now();

    expect(mockDeleteOldNotifications).toHaveBeenCalledTimes(1);
    const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = mockDeleteOldNotifications.mock.calls[0][0];
    expect(cutoff).toBeGreaterThanOrEqual(before - NOTIFICATION_TTL_MS - 100);
    expect(cutoff).toBeLessThanOrEqual(after - NOTIFICATION_TTL_MS + 100);
  });

  it('logs pruned impression/notification counts when > 0', async () => {
    mockDeleteOldImpressions.mockResolvedValue(7);
    mockDeleteOldNotifications.mockResolvedValue(2);

    const ctx = makeCtx();
    await registeredDef.handler(undefined, ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('7 story impressions'));
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('2 notifications'));
  });
});

export {};
