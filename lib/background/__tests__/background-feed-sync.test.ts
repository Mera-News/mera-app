// Step (b): fetch only to reach the open-ready target, inside the allowance,
// never charging for an article older than the window, with store refreshes
// owed to whoever is looking.

let mockAppState = 'background';
let mockAppStateHandler: ((s: string) => void) | null = null;
jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mockAppState;
    },
    addEventListener: jest.fn((_e: string, h: (s: string) => void) => {
      mockAppStateHandler = h;
      return { remove: jest.fn() };
    }),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { addBreadcrumb: jest.fn(), debug: jest.fn(), captureException: jest.fn() },
}));

let mockLastForeground: number | null = null;
jest.mock('../bg-refresh-settings', () => ({
  readLastForegroundAt: jest.fn(async () => mockLastForeground),
}));

let mockPerRun = 50;
const mockReserve = jest.fn(async () => {});
const mockSettle = jest.fn(async () => {});
const mockMarkExhausted = jest.fn(async () => {});
jest.mock('../background-allowance', () => ({
  readAllowance: jest.fn(async () => ({ perRun: mockPerRun, dayCap: 125, chargedToday: 0, exhausted: false })),
  reserveCharged: (...a: unknown[]) => mockReserve(...(a as [])),
  settleCharged: (...a: unknown[]) => mockSettle(...(a as [])),
  markQuotaExhausted: (...a: unknown[]) => mockMarkExhausted(...(a as [])),
}));

let mockReadiness = { relevant6h: 0, pending6h: 0, yield: 0.5, yieldSample: 100 };
jest.mock('../open-ready-target', () => ({
  ...jest.requireActual('../open-ready-target'),
  measureOpenReadiness: jest.fn(async () => mockReadiness),
}));

let mockDbReady = false;
jest.mock('@/lib/stores/database-store', () => ({
  useDatabaseStore: { getState: () => ({ ready: mockDbReady }) },
}));
const mockHydrateProtocol = jest.fn(async () => {});
let mockMode = 'CLOUD';
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: () => ({ hydrateFromDb: mockHydrateProtocol, processingMode: mockMode }),
  },
}));
const mockHydrateMeta = jest.fn(async () => {});
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ hydrateMetadataFromDb: mockHydrateMeta }) },
}));

let mockCapturedHooks: any = null;
let mockMachineImpl: () => Promise<void> = async () => {};
jest.mock('@/lib/scheduler/feed-sync/FeedSyncMachine', () => ({
  feedSyncMachine: {
    start: jest.fn((_p: string, _ctx: unknown, opts: { background: unknown }) => {
      mockCapturedHooks = opts.background;
      return mockMachineImpl();
    }),
  },
}));

const mockSubmit = jest.fn(async () => ({ submitted: 1, stoppedBy: 'done' }));
jest.mock('@/lib/services/scoring-pipeline', () => ({
  submitScoringForBackground: (...a: unknown[]) => mockSubmit(...(a as [])),
}));

const mockRefresh = jest.fn(async () => {});
jest.mock('@/lib/services/SuggestionSyncService', () => ({
  requestSuggestionsRefresh: () => mockRefresh(),
}));

import {
  __resetBackgroundFeedSyncForTests,
  isRefreshOwed,
  runBackgroundFeedSync,
  shapeBackgroundDiff,
} from '../background-feed-sync';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const idAt = (ms: number, n = 0) =>
  Math.floor(ms / 1000).toString(16).padStart(8, '0') + n.toString(16).padStart(16, '0');

beforeEach(() => {
  jest.clearAllMocks();
  __resetBackgroundFeedSyncForTests();
  mockAppState = 'background';
  mockAppStateHandler = null;
  mockLastForeground = NOW - HOUR;
  mockPerRun = 50;
  mockReadiness = { relevant6h: 0, pending6h: 0, yield: 0.5, yieldSample: 100 };
  mockDbReady = false;
  mockMode = 'CLOUD';
  mockCapturedHooks = null;
  mockMachineImpl = async () => {};
});

const run = () => runBackgroundFeedSync({ deadlineAt: Date.now() + 60_000, now: NOW });

describe('when it does not fetch at all', () => {
  it('skips a reader who has not opened the app for 24h', async () => {
    mockLastForeground = NOW - 25 * HOUR;
    expect((await run()).stoppedBy).toBe('no-foreground');
  });

  it('skips when no foreground was ever recorded', async () => {
    mockLastForeground = null;
    expect((await run()).stoppedBy).toBe('no-foreground');
  });

  it('skips when the allowance is spent', async () => {
    mockPerRun = 0;
    expect((await run()).stoppedBy).toBe('allowance');
  });

  it('skips when 50 relevant fresh articles are already there', async () => {
    mockReadiness = { relevant6h: 50, pending6h: 0, yield: 0.5, yieldSample: 100 };
    expect((await run()).stoppedBy).toBe('target-met');
  });

  it('skips when pending results are expected to cover the gap', async () => {
    mockReadiness = { relevant6h: 30, pending6h: 40, yield: 0.5, yieldSample: 100 };
    expect((await run()).stoppedBy).toBe('target-met');
  });
});

describe('the run', () => {
  it('hydrates the two stores whose setters would otherwise write defaults, first', async () => {
    await run();
    expect(mockHydrateProtocol).toHaveBeenCalled();
    expect(mockHydrateMeta).toHaveBeenCalled();
  });

  it('does not re-hydrate when the foreground boot already did', async () => {
    mockDbReady = true;
    await run();
    expect(mockHydrateProtocol).not.toHaveBeenCalled();
  });

  it('sizes the metered budget from the gap and the measured yield', async () => {
    mockReadiness = { relevant6h: 40, pending6h: 0, yield: 0.5, yieldSample: 100 };
    expect((await run()).meteredBudget).toBe(20);
  });

  it('submits the persisted ids through the bounded background submit, at most 3 batches', async () => {
    await run();
    await mockCapturedHooks.submit(['a', 'b']);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ articleIds: ['a', 'b'], maxBatches: 3 }),
    );
  });

  it('on-device mode fetches and persists only: no submit hook', async () => {
    mockMode = 'ON_DEVICE';
    await run();
    expect(mockCapturedHooks.submit).toBeNull();
  });

  it('reserves and corrects the ledger on the day the run started', async () => {
    await run();
    await mockCapturedHooks.reserveMetered(25);
    await mockCapturedHooks.settleMetered(25, 10);
    expect(mockReserve).toHaveBeenCalledWith(NOW, 25);
    expect(mockSettle).toHaveBeenCalledWith(NOW, 25, 10);
  });

  it('lets a failed reservation stop the request, so nothing is charged unrecorded', async () => {
    await run();
    mockReserve.mockRejectedValueOnce(new Error('db'));
    await expect(mockCapturedHooks.reserveMetered(25)).rejects.toThrow('db');
  });

  it('closes the day on a daily-limit, and writes nothing more to the ledger there', async () => {
    await run();
    await mockCapturedHooks.onHydrated({ meteredDelivered: 12, dailyLimitReached: true });
    expect(mockMarkExhausted).toHaveBeenCalledWith(NOW);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("reports a failed machine run as 'error', never throws", async () => {
    mockMachineImpl = async () => { throw new Error('offline'); };
    expect((await run()).stoppedBy).toBe('error');
  });

  it('returns at the deadline even if a request is still on the wire', async () => {
    jest.useFakeTimers();
    try {
      mockMachineImpl = () => new Promise<void>(() => {});
      const out = runBackgroundFeedSync({ deadlineAt: Date.now() + 1_000, now: NOW });
      await jest.advanceTimersByTimeAsync(1_000);
      expect((await out).stoppedBy).toBe('deadline');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the ObjectId prefilter and the metered cap, before hydrate', () => {
  const diff = (personaIds: string[], storyIds: string[] = []) => ({
    serverArticleIds: [...storyIds, ...personaIds],
    articleToTopicTexts: new Map(),
    missingIds: [...storyIds, ...personaIds],
    storyIds,
    personaIds,
  });

  it('never hands an id inserted before the 6h window to hydrate', () => {
    const fresh = idAt(NOW - HOUR, 1);
    const old = idAt(NOW - 7 * HOUR, 2);
    const out = shapeBackgroundDiff(diff([old, fresh]), NOW, 50);
    expect(out.personaIds).toEqual([fresh]);
    expect(out.missingIds).toEqual([fresh]);
  });

  it('caps the metered ids in order, so headlines (last) are what a cap clips', () => {
    const ids = [0, 1, 2, 3].map((n) => idAt(NOW - HOUR, n));
    const out = shapeBackgroundDiff(diff(ids), NOW, 2);
    expect(out.personaIds).toEqual(ids.slice(0, 2));
  });

  it('window-filters the free followed-story ids too', () => {
    const fresh = idAt(NOW - HOUR, 5);
    const old = idAt(NOW - 8 * HOUR, 6);
    const out = shapeBackgroundDiff(diff([], [old, fresh]), NOW, 50);
    expect(out.storyIds).toEqual([fresh]);
  });
});

describe('the store refresh owed to the reader', () => {
  it('is owed, not paid, while the app stays in the background', async () => {
    await run();
    await mockCapturedHooks.refreshStore();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(isRefreshOwed()).toBe(true);
  });

  it('is paid on the next activation', async () => {
    await run();
    await mockCapturedHooks.refreshStore();
    mockAppState = 'active';
    mockAppStateHandler?.('active');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(isRefreshOwed()).toBe(false);
  });

  it('stays owed through an activation that lands while the run is still saving rows', async () => {
    let finish: () => void = () => {};
    mockMachineImpl = () => new Promise<void>((resolve) => { finish = resolve; });
    const out = run();
    while (!mockCapturedHooks) await new Promise((r) => setTimeout(r, 0));
    await mockCapturedHooks.refreshStore();
    mockAppState = 'active';
    mockRefresh.mockClear();
    mockAppStateHandler?.('active');
    // Progressive refreshes may run, but the flag survives until the run ends.
    expect(isRefreshOwed()).toBe(true);
    finish();
    await out;
    expect(isRefreshOwed()).toBe(false);
    expect(mockRefresh).toHaveBeenCalled();
  });
});
