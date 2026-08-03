// AppScheduler.test.ts — unit tests for the AppScheduler orchestrator

const mockAppStateAddEventListener = jest.fn();
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

jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: {
    subscribe: (...args: any[]) => mockNetworkStoreSubscribe(...args),
    getState: () => mockNetworkState,
  },
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
  FOREGROUND_YIELD_TIMEOUT_MS,
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

  // Reset the singleton's internal task registry so tests don't accumulate
  // tasks from previous tests (TypeScript `private` compiles to a plain JS
  // property, so it is accessible at runtime via the `any` cast).
  (AppScheduler as any).tasks.clear();
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

  it('fires when the task ran 10s ago (the frequency gate no longer applies)', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'recent-run-fg-task',
      frequency: 60_000,
      triggers: ['app-foreground'],
    }));
    // 10s ago: inside the 60s frequency (would have been skipped before), but
    // outside FOREGROUND_MIN_GAP_MS.
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 10_000);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreateJob).toHaveBeenCalled();
  });

  it('holds the 5s floor so rapid app-switching cannot storm the server', async () => {
    const appStateHandler = await initThenRegisterForeground(makeTask({
      name: 'floor-fg-task',
      frequency: 60_000,
      triggers: ['app-foreground'],
    }));
    mockSchedulerStore.getLastRun.mockReturnValue(NOW - 2_000);

    appStateHandler('active');
    await jest.advanceTimersByTimeAsync(0);

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
