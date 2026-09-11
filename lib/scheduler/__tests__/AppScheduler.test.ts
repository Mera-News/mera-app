// AppScheduler.test.ts — unit tests for the AppScheduler orchestrator

const mockAppStateAddEventListener = jest.fn();
// `_tick` is foreground-only, so the whole suite runs as an ACTIVE app
// unless a test says otherwise. `mock`-prefixed for jest hoisting.
let mockAppStateCurrent = 'active';
const mockLoadLastRunTimes = jest.fn();
const mockMarkStaleCrashedJobs = jest.fn();
const mockCreateJob = jest.fn();
const mockRunnerRun = jest.fn();

// Scheduler-store state. `status` is mutable + written by setStatus so the
// init()-window foreground-replay path can be exercised.
const mockSchedulerStore = {
  status: 'initializing' as 'initializing' | 'running' | 'paused',
  setStatus: jest.fn((s: 'initializing' | 'running' | 'paused') => {
    mockSchedulerStore.status = s;
  }),
  loadLastRunTimes: jest.fn(),
  isRunning: jest.fn(() => false),
  getLastRun: jest.fn((): number | null => null),
  addJob: jest.fn(),
  reserveTask: jest.fn(),
  clearTaskReservation: jest.fn(),
  clearStaleRunning: jest.fn((): boolean => false),
};

// `yieldToInteractions` falls back to setTimeout(0) unless InteractionManager
// exposes runAfterInteractions. Tests that need the never-resolving case flip
// this flag; leaving it off keeps every existing foreground test on the fast
// path (no 200ms timeout to advance past).
let mockHangInteractions = false;

// Network-store state + subscription
let networkSubscribeFn: ((state: any, prev: any) => void) | null = null;
const mockNetworkStoreSubscribe = jest.fn((...args: any[]) => {
  networkSubscribeFn = args[0];
  return jest.fn(); // unsubscribe
});
const mockNetworkState = { isConnected: true };

// User-store and database-store mocks
const mockUserStore = { userPersona: { _id: 'p-1' }, needsReauth: false };
const mockDbStore = { ready: true };

const mockGetJwtToken = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (...args: any[]) => mockAppStateAddEventListener(...args),
    get currentState() {
      return mockAppStateCurrent;
    },
  },
  InteractionManager: {
    // Only defined while `mockHangInteractions` is set — otherwise idle.ts takes its
    // "InteractionManager unavailable" setTimeout(0) fallback, which is what the
    // rest of this suite has always exercised.
    get runAfterInteractions() {
      return mockHangInteractions ? () => { /* never resolves */ } : undefined;
    },
  },
}));

const mockResetSlowRequests = jest.fn();
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: {
    subscribe: (...args: any[]) => mockNetworkStoreSubscribe(...args),
    getState: () => mockNetworkState,
  },
  resetSlowRequests: () => mockResetSlowRequests(),
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: () => mockUserStore,
  },
}));

jest.mock('@/lib/stores/database-store', () => ({
  useDatabaseStore: {
    getState: () => mockDbStore,
  },
}));

jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: any[]) => mockGetJwtToken(...args),
}));

jest.mock('@/lib/scheduler/scheduler-store', () => ({
  useSchedulerStore: {
    getState: () => mockSchedulerStore,
  },
}));

jest.mock('@/lib/scheduler/scheduler-persistence', () => ({
  loadLastRunTimes: (...args: any[]) => mockLoadLastRunTimes(...args),
  markStaleCrashedJobs: (...args: any[]) => mockMarkStaleCrashedJobs(...args),
  createJob: (...args: any[]) => mockCreateJob(...args),
}));

jest.mock('@/lib/scheduler/scheduler-runner', () => ({
  run: (...args: any[]) => mockRunnerRun(...args),
}));

// Jitter is mocked to IDENTITY here, deliberately, and exercised for real in
// lib/scheduler/__tests__/jitter.test.ts instead.
//
// Every interval fixture in this file is written against an exact boundary
// (`lastRun = NOW - 5_001` against a 5_000 frequency, and friends). A live
// +/-20% would move those boundaries and break the suite by ARITHMETIC rather
// than by intent — which would be the worst kind of red: a real regression and
// a fixture artefact look identical. Mocking it to 1.0 keeps every existing
// assertion meaning exactly what its author wrote.
jest.mock('../jitter', () => ({
  JITTER_RATIO: 0.2,
  jitterFactor: () => 1,
  jitteredInterval: (_name: string, ms: number) => ms,
  __setJitterSeedForTests: () => {},
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

import {
  AppScheduler,
  AUTH_PREFLIGHT_TIMEOUT_MS,
  FAILURE_TICK_BACKOFF_MS,
  FOREGROUND_YIELD_TIMEOUT_MS,
  RECONNECT_FAILURE_GAP_MS,
} from '../AppScheduler';
import type { TaskDefinition, TaskContext } from '../scheduler-types';

const NOW = 1_700_000_000_000;

function makeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    name: 'test-task',
    displayName: 'Test Task',
    handler: jest.fn().mockResolvedValue(undefined),
    frequency: 10_000,
    maxAttempts: 3,
    ...overrides,
  };
}

function makeJob(overrides: Record<string, any> = {}) {
  return {
    id: 'job-1',
    taskName: 'test-task',
    status: 'pending',
    attempt: 1,
    maxAttempts: 3,
    scheduledAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  mockLoadLastRunTimes.mockResolvedValue({});
  mockMarkStaleCrashedJobs.mockResolvedValue(undefined);
  mockCreateJob.mockResolvedValue(makeJob());
  mockRunnerRun.mockResolvedValue(undefined);
  mockSchedulerStore.isRunning.mockReturnValue(false);
  mockSchedulerStore.getLastRun.mockReturnValue(null);
  mockSchedulerStore.clearStaleRunning.mockReturnValue(false);
  mockSchedulerStore.status = 'initializing';
  mockSchedulerStore.setStatus.mockImplementation((s) => { mockSchedulerStore.status = s; });
  mockHangInteractions = false;
  networkSubscribeFn = null;
  mockNetworkState.isConnected = true;
  mockUserStore.userPersona = { _id: 'p-1' } as any;
  mockUserStore.needsReauth = false;
  mockDbStore.ready = true;
  mockGetJwtToken.mockReset().mockResolvedValue('jwt-token');

  // Return a remove function from addEventListener
  mockAppStateAddEventListener.mockReturnValue({ remove: jest.fn() });
  mockAppStateCurrent = 'active';

  // Reset the singleton's internal task registry so tests don't accumulate
  // tasks from previous tests (TypeScript `private` compiles to a plain JS
  // property, so it is accessible at runtime via the `any` cast).
  (AppScheduler as any).tasks.clear();
  (AppScheduler as any).lastFailureAt.clear();
});

afterEach(() => {
  AppScheduler.dispose();
  jest.useRealTimers();
});

describe('AppScheduler.register', () => {
  it('registers a task definition', async () => {
    const task = makeTask();
    AppScheduler.register(task);
    // Trigger to verify registration
    await AppScheduler.trigger('test-task');
    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('throws when triggering an unregistered task', async () => {
    await expect(AppScheduler.trigger('non-existent-task')).rejects.toThrow(
      'Unknown task: non-existent-task',
    );
  });
});

describe('AppScheduler.init', () => {
  it('loads last run times from persistence', async () => {
    mockLoadLastRunTimes.mockResolvedValue({ 'test-task': NOW - 5000 });
    AppScheduler.register(makeTask());

    await AppScheduler.init();

    expect(mockLoadLastRunTimes).toHaveBeenCalled();
    expect(mockSchedulerStore.loadLastRunTimes).toHaveBeenCalledWith({ 'test-task': NOW - 5000 });
  });

  it('calls markStaleCrashedJobs on init', async () => {
    await AppScheduler.init();
    expect(mockMarkStaleCrashedJobs).toHaveBeenCalledTimes(1);
  });

  it('sets scheduler status to running', async () => {
    await AppScheduler.init();
    expect(mockSchedulerStore.setStatus).toHaveBeenCalledWith('running');
  });

  it('subscribes to AppState changes', async () => {
    await AppScheduler.init();
    expect(mockAppStateAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('subscribes to network store changes', async () => {
    await AppScheduler.init();
    expect(mockNetworkStoreSubscribe).toHaveBeenCalled();
  });

  it('fires _tick immediately on init', async () => {
    const task = makeTask({ frequency: 10_000 });
    AppScheduler.register(task);
    await AppScheduler.init();

    // Since lastRun is null, the task is due — _tick should have fired
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateJob).toHaveBeenCalled();
  });
});

describe('AppScheduler.dispose', () => {
  it('sets scheduler status to paused', async () => {
    await AppScheduler.init();
    AppScheduler.dispose();
    expect(mockSchedulerStore.setStatus).toHaveBeenCalledWith('paused');
  });

  it('clears the tick interval', async () => {
    await AppScheduler.init();
    const timersBefore = jest.getTimerCount();
    AppScheduler.dispose();
    // Interval should be cleared
    expect(jest.getTimerCount()).toBeLessThan(timersBefore);
  });
});

describe('AppScheduler — tick scheduling', () => {
  it('fires tasks that are due on tick', async () => {
    const task = makeTask({ name: 'tick-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  // The tick is FOREGROUND-ONLY. A backgrounded app's requests run their full
  // 30s abort budget and fail for no actionable reason (Sentry MERA-APP-79).
  // Asserted in both directions so the gate cannot be deleted silently — the
  // due-on-tick test above passes with or without it.
  it('does NOT fire a due task while the app is backgrounded', async () => {
    const task = makeTask({ name: 'bg-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);
    mockAppStateCurrent = 'background';

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  // Catch-up is the 5s interval itself, not the app-foreground trigger:
  // data-cleanup, feedback-cycle and persona-hygiene declare `triggers: []`, so
  // a trigger-based catch-up would strand them forever.
  it('fires a task held back by the gate on the first tick after returning to active', async () => {
    const task = makeTask({ name: 'catchup-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);
    mockAppStateCurrent = 'background';

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateJob).not.toHaveBeenCalled();

    mockAppStateCurrent = 'active';
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('skips tasks not yet due', async () => {
    const task = makeTask({ name: 'skip-task', frequency: 10_000 });
    AppScheduler.register(task);
    // Last run was 1 second ago, frequency is 10s
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 1000);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('skips exclusive tasks that are already running', async () => {
    const task = makeTask({ name: 'exclusive-task', frequency: 10_000, exclusive: true });
    AppScheduler.register(task);
    mockSchedulerStore.isRunning.mockReturnValue(true);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('skips event-driven tasks (frequency=0) on tick', async () => {
    const task = makeTask({ name: 'event-task', frequency: 0, triggers: ['app-foreground'] });
    AppScheduler.register(task);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('fires task again after interval elapses', async () => {
    const task = makeTask({ name: 'interval-task', frequency: 5_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0); // initial tick
    jest.clearAllMocks();

    // Advance past the next tick interval (5s tick interval in scheduler)
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 5_001);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockCreateJob).toHaveBeenCalled();
  });
});

describe('AppScheduler — condition checks', () => {
  it('blocks task when network condition fails', async () => {
    const task = makeTask({
      name: 'network-task',
      frequency: 10_000,
      conditions: [{ type: 'network' }],
    });
    AppScheduler.register(task);
    mockNetworkState.isConnected = false;

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('blocks task when authenticated condition fails', async () => {
    const task = makeTask({
      name: 'auth-task',
      frequency: 10_000,
      conditions: [{ type: 'authenticated' }],
    });
    AppScheduler.register(task);
    (mockUserStore as any).userPersona = null;

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('blocks task when db-ready condition fails', async () => {
    const task = makeTask({
      name: 'db-task',
      frequency: 10_000,
      conditions: [{ type: 'db-ready' }],
    });
    AppScheduler.register(task);
    mockDbStore.ready = false;

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('allows task when custom condition returns true', async () => {
    const task = makeTask({
      name: 'custom-task',
      frequency: 10_000,
      conditions: [{ type: 'custom', check: () => true }],
    });
    AppScheduler.register(task);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('blocks task when custom condition returns false', async () => {
    const task = makeTask({
      name: 'custom-block-task',
      frequency: 10_000,
      conditions: [{ type: 'custom', check: () => false }],
    });
    AppScheduler.register(task);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('allows task when condition type is unknown (default return true branch)', async () => {
    // Covers the final `return true` in _checkCondition (line 121) which is the
    // defensive fallback for any future condition types not yet implemented.
    const task = makeTask({
      name: 'unknown-cond-task',
      frequency: 10_000,
      conditions: [{ type: 'unknown-future-type' } as any],
    });
    AppScheduler.register(task);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    // Unknown condition type → _checkCondition returns true → task should run
    expect(mockCreateJob).toHaveBeenCalled();
  });
});

describe('AppScheduler — authenticated condition (real credential pre-flight)', () => {
  function makeAuthTask(name: string) {
    return makeTask({ name, frequency: 10_000, conditions: [{ type: 'authenticated' }] });
  }

  it('allows: persona present, online, jwt ok, needsReauth false', async () => {
    AppScheduler.register(makeAuthTask('auth-ok'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockResolvedValue('jwt-token');

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
    expect(mockGetJwtToken).toHaveBeenCalled();
  });

  it('blocks: persona present, online, jwt null, needsReauth false', async () => {
    AppScheduler.register(makeAuthTask('auth-jwt-null'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockResolvedValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('blocks: persona present, online, getJwtToken throws, needsReauth false', async () => {
    AppScheduler.register(makeAuthTask('auth-jwt-throws'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockRejectedValue(new Error('keychain unavailable'));

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('allows: persona present, offline — credential check is skipped entirely', async () => {
    AppScheduler.register(makeAuthTask('auth-offline'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = false;
    // Even if it were called, it would fail — proves the check is genuinely skipped.
    mockGetJwtToken.mockResolvedValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('blocks: persona absent, online, jwt ok — fast local check short-circuits', async () => {
    AppScheduler.register(makeAuthTask('auth-no-persona'));
    mockUserStore.userPersona = null as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockResolvedValue('jwt-token');

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('blocks: persona absent, offline', async () => {
    AppScheduler.register(makeAuthTask('auth-no-persona-offline'));
    mockUserStore.userPersona = null as any;
    mockNetworkState.isConnected = false;

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('blocks: persona present, online, jwt ok, but needsReauth true', async () => {
    AppScheduler.register(makeAuthTask('auth-needs-reauth'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = true;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockResolvedValue('jwt-token');

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
    // needsReauth short-circuits before the network-gated jwt check.
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('blocks: persona present, offline, needsReauth true — checked unconditionally', async () => {
    AppScheduler.register(makeAuthTask('auth-needs-reauth-offline'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = true;
    mockNetworkState.isConnected = false;

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('a failed auth pre-flight does not consume an attempt or capture to Sentry (quiet skip)', async () => {
    AppScheduler.register(makeAuthTask('auth-quiet-skip'));
    mockUserStore.userPersona = { _id: 'p-1' } as any;
    mockUserStore.needsReauth = false;
    mockNetworkState.isConnected = true;
    mockGetJwtToken.mockResolvedValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockRunnerRun).not.toHaveBeenCalled();
    const loggerMock = jest.requireMock('@/lib/logger').default;
    expect(loggerMock.captureException).not.toHaveBeenCalled();
  });
});

describe('AppScheduler — foreground trigger', () => {
  it('fires app-foreground tasks on onStoresHydrated()', async () => {
    const task = makeTask({
      name: 'fg-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
    });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'fg-task' }));

    AppScheduler.onStoresHydrated();
    // A6: onStoresHydrated defers the kick past interactions + a ~1s settle.
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('fires app-foreground tasks when AppState changes to active', async () => {
    let appStateHandler: ((state: string) => void) | null = null;
    mockAppStateAddEventListener.mockImplementation((_event, handler) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    });

    const task = makeTask({
      name: 'appstate-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
    });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'appstate-task' }));

    (appStateHandler as ((state: string) => void) | null)?.('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('does NOT fire app-foreground task if already running (exclusive)', async () => {
    const task = makeTask({
      name: 'exclusive-fg-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
      exclusive: true,
    });
    AppScheduler.register(task);
    mockSchedulerStore.isRunning.mockReturnValue(true);

    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('does NOT fire app-foreground task that was run recently (not due)', async () => {
    const task = makeTask({
      name: 'recent-fg-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
    });
    AppScheduler.register(task);
    // Last run 1 second ago, frequency 10 seconds
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 1000);

    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('blocks app-foreground task when conditions not met', async () => {
    const task = makeTask({
      name: 'cond-fg-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
      conditions: [{ type: 'db-ready' }],
    });
    AppScheduler.register(task);
    mockDbStore.ready = false;

    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('fires app-foreground tasks via AppState change to active (triggers branch)', async () => {
    let appStateHandler: ((state: string) => void) | null = null;
    mockAppStateAddEventListener.mockImplementation((_event: string, handler: (s: string) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    });

    const task = makeTask({
      name: 'fg-appstate-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
    });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'fg-appstate-task' }));

    // AppState non-active → should not fire
    (appStateHandler as ((state: string) => void) | null)?.('background');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});

describe('AppScheduler — network-reconnect trigger', () => {
  it('fires network-reconnect tasks when network comes back up', async () => {
    const task = makeTask({
      name: 'reconnect-task',
      frequency: 10_000,
      triggers: ['network-reconnect'],
    });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'reconnect-task' }));

    // Simulate network reconnection
    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('does NOT fire network-reconnect tasks when network goes down', async () => {
    const task = makeTask({
      name: 'down-task',
      frequency: 10_000,
      triggers: ['network-reconnect'],
    });
    AppScheduler.register(task);

    await AppScheduler.init();
    jest.clearAllMocks();

    networkSubscribeFn?.({ isConnected: false }, { isConnected: true });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('skips exclusive network-reconnect tasks that are already running', async () => {
    const task = makeTask({
      name: 'exclusive-reconnect-task',
      frequency: 10_000,
      triggers: ['network-reconnect'],
      exclusive: true,
    });
    AppScheduler.register(task);
    mockSchedulerStore.isRunning.mockReturnValue(true);

    await AppScheduler.init();
    jest.clearAllMocks();

    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('skips network-reconnect task when conditions not met', async () => {
    const task = makeTask({
      name: 'reconnect-cond-task',
      frequency: 10_000,
      triggers: ['network-reconnect'],
      conditions: [{ type: 'authenticated' }],
    });
    AppScheduler.register(task);
    (mockUserStore as any).userPersona = null;

    await AppScheduler.init();
    jest.clearAllMocks();

    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('skips tasks without network-reconnect trigger on reconnect', async () => {
    const task = makeTask({
      name: 'no-reconnect-trigger-task',
      frequency: 10_000,
      triggers: ['app-foreground'], // not network-reconnect
    });
    AppScheduler.register(task);

    await AppScheduler.init();
    jest.clearAllMocks();

    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});

describe('AppScheduler.trigger', () => {
  it('enqueues and runs the named task immediately', async () => {
    const task = makeTask({ name: 'manual-task' });
    AppScheduler.register(task);

    await AppScheduler.trigger('manual-task');

    expect(mockCreateJob).toHaveBeenCalledWith(task, undefined);
    expect(mockRunnerRun).toHaveBeenCalled();
  });

  it('passes input to createJob', async () => {
    const task = makeTask({ name: 'input-task' });
    AppScheduler.register(task);

    await AppScheduler.trigger('input-task', { key: 'val' });

    expect(mockCreateJob).toHaveBeenCalledWith(task, { key: 'val' });
  });

  it('skips an exclusive task that is already running (retry must not run concurrently)', async () => {
    const task = makeTask({ name: 'exclusive-trigger-task', exclusive: true });
    AppScheduler.register(task);
    mockSchedulerStore.isRunning.mockReturnValue(true);

    await AppScheduler.trigger('exclusive-trigger-task');

    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockRunnerRun).not.toHaveBeenCalled();
  });

  it('still runs a non-exclusive task even if isRunning reports true', async () => {
    const task = makeTask({ name: 'non-exclusive-trigger-task', exclusive: false });
    AppScheduler.register(task);
    mockSchedulerStore.isRunning.mockReturnValue(true);

    await AppScheduler.trigger('non-exclusive-trigger-task');

    expect(mockCreateJob).toHaveBeenCalled();
  });
});

describe('AppScheduler — exclusive reservation (close check-then-run gap)', () => {
  it('reserves an exclusive task synchronously before createJob', async () => {
    const task = makeTask({ name: 'reserve-task', exclusive: true });
    AppScheduler.register(task);
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'reserve-task' }));

    await AppScheduler.trigger('reserve-task');

    expect(mockSchedulerStore.reserveTask).toHaveBeenCalledWith('reserve-task');
  });

  it('does NOT reserve a non-exclusive task', async () => {
    const task = makeTask({ name: 'no-reserve-task', exclusive: false });
    AppScheduler.register(task);

    await AppScheduler.trigger('no-reserve-task');

    expect(mockSchedulerStore.reserveTask).not.toHaveBeenCalled();
  });

  it('releases the reservation if createJob throws', async () => {
    const task = makeTask({ name: 'reserve-fail-task', exclusive: true });
    AppScheduler.register(task);
    mockCreateJob.mockRejectedValueOnce(new Error('createJob failed'));

    await expect(AppScheduler.trigger('reserve-fail-task')).rejects.toThrow('createJob failed');

    expect(mockSchedulerStore.reserveTask).toHaveBeenCalledWith('reserve-fail-task');
    expect(mockSchedulerStore.clearTaskReservation).toHaveBeenCalledWith('reserve-fail-task');
  });
});

// Registers the task AFTER init() so the init-time _tick() can't be what fires
// it — every assertion below must be attributable to the foreground path.
async function initThenRegisterForeground(task: TaskDefinition): Promise<(state: string) => void> {
  let appStateHandler: ((state: string) => void) | null = null;
  mockAppStateAddEventListener.mockImplementation((_event: string, handler: (s: string) => void) => {
    appStateHandler = handler;
    return { remove: jest.fn() };
  });

  await AppScheduler.init();
  jest.clearAllMocks();
  AppScheduler.register(task);
  mockCreateJob.mockResolvedValue(makeJob({ taskName: task.name }));
  mockSchedulerStore.clearStaleRunning.mockReturnValue(false);
  mockSchedulerStore.isRunning.mockReturnValue(false);
  mockSchedulerStore.getLastRun.mockReturnValue(null);
  return appStateHandler as unknown as (state: string) => void;
}

describe('AppScheduler — bounded foreground kick', () => {
  it('still fires the task when runAfterInteractions never resolves', async () => {
    // A leaked InteractionManager handle used to swallow the foreground kick
    // outright; FOREGROUND_YIELD_TIMEOUT_MS is the escape hatch.
    mockHangInteractions = true;
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'hang-fg-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
    }));

    appStateHandler('active');

    // Nothing yet — the interaction promise is still pending.
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateJob).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(FOREGROUND_YIELD_TIMEOUT_MS);
    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('fires when the task ran 90s ago (the frequency gate no longer applies)', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'recent-run-fg-task',
      frequency: 300_000,
      triggers: ['app-foreground'],
    }));
    // 90s ago: inside the 5min frequency (so a tick would skip it), but outside
    // FOREGROUND_MIN_GAP_MS. This is the whole point of the foreground floor —
    // a deliberate app-open is not a timer tick.
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 90_000);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  // The fixture is 30s, NOT 2s, deliberately. 2s sits below both the old 5s
  // floor and the current 60s one, so it passed either way and could not catch
  // the floor being lowered back — the same "green because it never looked"
  // shape as a toContain over conditions. 30s fires under the old value and is
  // held under the new one, so this test now discriminates.
  it('holds the 60s floor so rapid app-switching cannot storm the server', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'floor-fg-task',
      frequency: 300_000,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 30_000);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  // The cold-start kick is a DIFFERENT event wearing the same shape: a relaunch
  // must sync against rows restored from disk, whatever the previous session
  // stamped. Same fixture as the warm test above, opposite expectation — which
  // is what pins the two floors apart.
  it('uses the short cold-start floor on onStoresHydrated, where the warm floor would block', async () => {
    AppScheduler.register(makeTask({
      name: 'cold-start-fg-task',
      frequency: 300_000,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 30_000);
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'cold-start-fg-task' }));

    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('still holds the cold-start floor for a run 2s ago', async () => {
    AppScheduler.register(makeTask({
      name: 'cold-start-floor-task',
      frequency: 300_000,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 2_000);

    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(1_100);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('keeps frequency-0 tasks always-due on foreground', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'always-due-fg-task',
      frequency: 0,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 100);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('replays a foreground event that arrived during init()\'s awaits', async () => {
    let appStateHandler: ((state: string) => void) | null = null;
    mockAppStateAddEventListener.mockImplementation((_event: string, handler: (s: string) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    });

    // Hold loadLastRunTimes open so we can fire the event mid-init.
    let releaseLoad: (v: Record<string, number>) => void = () => {};
    mockLoadLastRunTimes.mockReturnValue(
      new Promise<Record<string, number>>((resolve) => { releaseLoad = resolve; }),
    );

    // frequency 0 = event-driven only, so the init-time _tick() skips it
    // entirely and the foreground replay is the only thing that can fire it.
    AppScheduler.register(makeTask({
      name: 'replay-fg-task',
      frequency: 0,
      triggers: ['app-foreground'],
    }));
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'replay-fg-task' }));

    const initPromise = AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);

    // The listener is already registered — this is the whole point of moving it
    // above the awaits.
    expect(appStateHandler).not.toBeNull();
    (appStateHandler as ((state: string) => void) | null)?.('active');
    await jest.advanceTimersByTimeAsync(0);
    // Deferred, not dropped: last-run times aren't loaded, so dueness is unknown.
    expect(mockCreateJob).not.toHaveBeenCalled();

    releaseLoad({});
    await initPromise;
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('clears a stale running flag on foreground and logs it', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'stale-flag-task',
      frequency: 10_000,
      triggers: ['app-foreground'],
      timeout: 180_000,
    }));
    mockSchedulerStore.clearStaleRunning.mockReturnValue(true);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    // timeout (180s) + the 30s margin.
    expect(mockSchedulerStore.clearStaleRunning).toHaveBeenCalledWith('stale-flag-task', 210_000);
    const loggerMock = jest.requireMock('@/lib/logger').default;
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("stale 'running' flag"));
  });
});

describe('AppScheduler — auth pre-flight time-box', () => {
  function makeAuthTask(name: string) {
    return makeTask({ name, frequency: 10_000, conditions: [{ type: 'authenticated' }] });
  }

  it('passes optimistically when getJwtToken hangs past the budget', async () => {
    // A hung credential check must not block the sync — a genuinely dead
    // session is caught by the request's own 401 → breaker → needsReauth.
    AppScheduler.register(makeAuthTask('auth-hangs'));
    mockGetJwtToken.mockImplementation(() => new Promise(() => { /* never settles */ }));

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(AUTH_PREFLIGHT_TIMEOUT_MS + 10);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('still blocks on an explicit null even though the check is time-boxed', async () => {
    AppScheduler.register(makeAuthTask('auth-null-timeboxed'));
    mockGetJwtToken.mockResolvedValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(AUTH_PREFLIGHT_TIMEOUT_MS + 10);

    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});

export {};

// ── failure backoff ────────────────────────────────────────────────────────
// A failed job deliberately does NOT stamp `lastRun` (scheduler-runner keeps
// the frequency gate from being armed by a run that accomplished nothing). The
// consequence, before this gate existed, was that `_tick()` found the task due
// again 5 seconds later and kept finding it due: a persistently failing
// feed-sync re-ran as fast as it could fail, which is the single largest source
// of failure-mode load on the server.
describe('AppScheduler — failure backoff', () => {
  it('does NOT re-fire a failed task on the next tick', async () => {
    const task = makeTask({ name: 'failing-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null); // never succeeded

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateJob).toHaveBeenCalledTimes(1);

    AppScheduler.recordFailure('failing-task');
    jest.clearAllMocks();

    // Several ticks inside the backoff window.
    await jest.advanceTimersByTimeAsync(FAILURE_TICK_BACKOFF_MS - 5_000);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('re-fires once the failure backoff elapses', async () => {
    const task = makeTask({ name: 'recovering-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    AppScheduler.recordFailure('recovering-task');
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'recovering-task' }));

    await jest.advanceTimersByTimeAsync(FAILURE_TICK_BACKOFF_MS + 5_000);
    expect(mockCreateJob).toHaveBeenCalled();
  });

  // The half a green suite hides: a gate that is never cleared also passes
  // both tests above, and would then permanently throttle a healthy task.
  it('clears the backoff on a successful run', async () => {
    const task = makeTask({ name: 'cleared-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    AppScheduler.recordFailure('cleared-task');
    AppScheduler.clearFailure('cleared-task');
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'cleared-task' }));

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockCreateJob).toHaveBeenCalled();
  });

  // markNoOp is NOT a failure. A skipped cycle must still retry promptly, or a
  // single no-op turns into a dead zone repeated indefinitely.
  it('leaves a no-op run free to re-fire on the next tick', async () => {
    const task = makeTask({ name: 'noop-task', frequency: 10_000 });
    AppScheduler.register(task);
    mockSchedulerStore.getLastRun.mockReturnValue(null);

    await AppScheduler.init();
    await jest.advanceTimersByTimeAsync(0);
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'noop-task' }));

    // No recordFailure: a no-op neither stamps lastRun nor counts as a failure.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockCreateJob).toHaveBeenCalled();
  });

  // Tick-only, deliberately. A user who opens the app should not be made to
  // wait out a failure they never saw.
  it('does not gate the foreground path on a recent failure', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'fg-after-failure-task',
      frequency: 300_000,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 90_000);
    AppScheduler.recordFailure('fg-after-failure-task');
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'fg-after-failure-task' }));

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });
});

// ── network-reconnect gating ───────────────────────────────────────────────
// This path had no time gate at all: every false->true NetInfo transition
// re-ran the task, so a flapping link re-synced on every flap.
describe('AppScheduler — network-reconnect gating', () => {
  async function reconnect(): Promise<void> {
    mockNetworkState.isConnected = true;
    networkSubscribeFn?.({ isConnected: true }, { isConnected: false });
    await jest.advanceTimersByTimeAsync(0);
  }

  it('does NOT re-fire when the task ran 30s ago (flap bound)', async () => {
    AppScheduler.register(makeTask({
      name: 'flap-task',
      frequency: 300_000,
      triggers: ['network-reconnect'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 30_000);

    await AppScheduler.init();
    jest.clearAllMocks();

    await reconnect();
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('fires when the task last ran 90s ago', async () => {
    AppScheduler.register(makeTask({
      name: 'reconnect-due-task',
      frequency: 300_000,
      triggers: ['network-reconnect'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 90_000);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'reconnect-due-task' }));

    await reconnect();
    expect(mockCreateJob).toHaveBeenCalled();
  });

  // The tunnel-exit case, and the reason the reconnect failure gap is 15s
  // rather than the tick's 60s: the usual reason a run just failed is that we
  // were offline, so the reconnect IS the recovery.
  it('fires 20s after a failure when lastRun is old (tunnel exit)', async () => {
    AppScheduler.register(makeTask({
      name: 'tunnel-task',
      frequency: 300_000,
      triggers: ['network-reconnect'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 600_000);
    jest.setSystemTime(NOW - 20_000);
    AppScheduler.recordFailure('tunnel-task');
    jest.setSystemTime(NOW);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'tunnel-task' }));

    await reconnect();
    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('does NOT fire 5s after a failure', async () => {
    AppScheduler.register(makeTask({
      name: 'just-failed-task',
      frequency: 300_000,
      triggers: ['network-reconnect'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 600_000);
    jest.setSystemTime(NOW - 5_000);
    AppScheduler.recordFailure('just-failed-task');
    jest.setSystemTime(NOW);

    await AppScheduler.init();
    jest.clearAllMocks();

    await reconnect();
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('keeps frequency-0 tasks always-due on reconnect', async () => {
    AppScheduler.register(makeTask({
      name: 'always-due-reconnect-task',
      frequency: 0,
      triggers: ['network-reconnect'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 100);

    await AppScheduler.init();
    jest.clearAllMocks();
    mockCreateJob.mockResolvedValue(makeJob({ taskName: 'always-due-reconnect-task' }));

    await reconnect();
    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('RECONNECT_FAILURE_GAP_MS is shorter than the tick backoff', () => {
    expect(RECONNECT_FAILURE_GAP_MS).toBeLessThan(FAILURE_TICK_BACKOFF_MS);
  });
});
