// feedback-request-sync-task: registration shape + handler.
//
// Mocks are created inside the factories and read back via jest.requireMock:
// Babel hoists the task import above any module-level const.

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/feedback-requests/feedback-request-sync', () => ({
  syncFeedbackRequests: jest.fn(async () => ({ ok: true, fetched: 0, newRows: 0, answered: 0 })),
}));

jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: { getState: () => ({ appLanguage: 'zh-Hant' }) },
}));

import '../feedback-request-sync-task';

const {
  AppScheduler: { register: mockRegister },
} = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { syncFeedbackRequests: mockSync } = jest.requireMock(
  '@/lib/feedback-requests/feedback-request-sync',
) as any;

const def = mockRegister.mock.calls[0]?.[0];

function makeCtx() {
  return {
    jobId: 'job-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
  };
}

describe('feedback-request-sync-task registration', () => {
  it('registers once, by name', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(def.name).toBe('feedback-request-sync');
  });

  it('runs hourly (a floor, not just > 0) plus foreground and reconnect', () => {
    expect(def.frequency).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect([...def.triggers].sort()).toEqual(['app-foreground', 'network-reconnect']);
  });

  // Exact list, not toContain: an added condition must fail here.
  it('is gated on exactly network, authenticated and db-ready', () => {
    expect(def.conditions.map((c: { type: string }) => c.type)).toEqual(['network', 'authenticated', 'db-ready']);
  });

  it('is exclusive with a single attempt', () => {
    expect(def.exclusive).toBe(true);
    expect(def.maxAttempts).toBe(1);
  });
});

describe('feedback-request-sync-task handler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('syncs in the app language', async () => {
    await def.handler(undefined, makeCtx());
    expect(mockSync).toHaveBeenCalledWith('zh-Hant');
  });

  // No live requests is the normal state: a no-op mark would loop every 5s.
  it('never calls ctx.markNoOp, on an empty result or a failed fetch', async () => {
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    mockSync.mockResolvedValueOnce({ ok: false, fetched: 0, newRows: 0, answered: 0 });
    await def.handler(undefined, ctx);
    expect(ctx.markNoOp).not.toHaveBeenCalled();
  });

  it('logs the counts, and a failed fetch without throwing', async () => {
    mockSync.mockResolvedValueOnce({ ok: true, fetched: 2, newRows: 1, answered: 1 });
    const ctx = makeCtx();
    await def.handler(undefined, ctx);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('2 live, 1 new, 1 answered'));
    mockSync.mockResolvedValueOnce({ ok: false, fetched: 0, newRows: 0, answered: 0 });
    await expect(def.handler(undefined, ctx)).resolves.toBeUndefined();
    expect(ctx.log).toHaveBeenLastCalledWith(expect.stringContaining('fetch failed'));
  });
});
