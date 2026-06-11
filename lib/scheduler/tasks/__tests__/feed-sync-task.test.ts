// feed-sync-task.test.ts — tests for feed-sync-task registration + handler

// All mock functions are defined INSIDE the jest.mock factories (not as module-level
// consts) to avoid the hoisting issue: Babel hoists `import '../feed-sync-task'`
// above both jest.mock() and const declarations, so module-level consts are still
// undefined when the mock factory's return values are called at module-load time.
// Tests access the mocks via jest.requireMock().

jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { register: jest.fn() },
}));

jest.mock('@/lib/scheduler/feed-sync/FeedSyncMachine', () => ({
  feedSyncMachine: {
    start: jest.fn(),
  },
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

// Load the task module — this triggers the AppScheduler.register() side-effect
import '../feed-sync-task';

// Retrieve mock references after module load
const { AppScheduler: { register: mockRegister } } = jest.requireMock('@/lib/scheduler/AppScheduler') as any;
const { feedSyncMachine: { start: mockFeedSyncMachineStart } } = jest.requireMock('@/lib/scheduler/feed-sync/FeedSyncMachine') as any;
const { useUserStore: { getState: mockGetUserStoreState } } = jest.requireMock('@/lib/stores/user-store') as any;
const { default: { info: mockLogInfo } } = jest.requireMock('@/lib/logger') as any;

const registeredDef = mockRegister.mock.calls[0]?.[0];

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    jobId: 'job-1',
    attempt: 1,
    signal: new AbortController().signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('feed-sync-task registration', () => {
  it('registers with AppScheduler on module load', () => {
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers with name feed-sync', () => {
    expect(registeredDef.name).toBe('feed-sync');
  });

  it('registers with app-foreground and network-reconnect triggers', () => {
    expect(registeredDef.triggers).toContain('app-foreground');
    expect(registeredDef.triggers).toContain('network-reconnect');
  });

  it('has network, authenticated, db-ready conditions', () => {
    const types = registeredDef.conditions.map((c: any) => c.type);
    expect(types).toContain('network');
    expect(types).toContain('authenticated');
    expect(types).toContain('db-ready');
  });

  it('is exclusive', () => {
    expect(registeredDef.exclusive).toBe(true);
  });

  it('has a positive frequency (timer-driven)', () => {
    expect(registeredDef.frequency).toBeGreaterThan(0);
  });

  it('has maxAttempts set', () => {
    expect(registeredDef.maxAttempts).toBeGreaterThan(0);
  });

  it('has a timeout set', () => {
    expect(registeredDef.timeout).toBeGreaterThan(0);
  });
});

describe('feed-sync-task handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFeedSyncMachineStart.mockResolvedValue(undefined);
  });

  it('calls feedSyncMachine.start with personaId and ctx when persona exists', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: { _id: 'persona-abc' },
      userId: 'user-1',
    });
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(mockFeedSyncMachineStart).toHaveBeenCalledWith('persona-abc', ctx);
  });

  it('throws when userPersona is null', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: null,
      userId: 'user-1',
    });
    const ctx = makeCtx();

    await expect(registeredDef.handler(undefined, ctx)).rejects.toThrow('UserPersona not found');
    expect(mockFeedSyncMachineStart).not.toHaveBeenCalled();
  });

  it('throws when userPersona has no _id', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: {},
      userId: 'user-1',
    });
    const ctx = makeCtx();

    await expect(registeredDef.handler(undefined, ctx)).rejects.toThrow('UserPersona not found');
  });

  it('logs handler start with userId and personaId', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: { _id: 'p-123' },
      userId: 'u-456',
    });
    const ctx = makeCtx({ attempt: 2 });

    await registeredDef.handler(undefined, ctx);

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('feed-sync-task'),
    );
  });

  it('logs "null" for userId when userId is null (covers ?? branch)', async () => {
    // Covers the `userStore.userId ?? 'null'` branch in the log line (line 22)
    // when userId is null/undefined.
    mockGetUserStoreState.mockReturnValue({
      userPersona: { _id: 'p-xyz' },
      userId: null,
    });
    const ctx = makeCtx();

    await registeredDef.handler(undefined, ctx);

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('userId=null'),
    );
  });

  it('propagates errors from feedSyncMachine.start', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: { _id: 'p-999' },
      userId: 'u-999',
    });
    const err = new Error('sync failure');
    mockFeedSyncMachineStart.mockRejectedValueOnce(err);

    await expect(registeredDef.handler(undefined, makeCtx())).rejects.toThrow('sync failure');
  });
});

export {};
