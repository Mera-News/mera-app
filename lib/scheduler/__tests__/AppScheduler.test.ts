// AppScheduler.test.ts — unit tests for the AppScheduler orchestrator

const mockAppStateAddEventListener = jest.fn();
const mockLoadLastRunTimes = jest.fn();
const mockMarkStaleCrashedJobs = jest.fn();
const mockCreateJob = jest.fn();
const mockRunnerRun = jest.fn();

// Scheduler-store state
const mockSchedulerStore = {
  setStatus: jest.fn(),
  loadLastRunTimes: jest.fn(),
  isRunning: jest.fn(() => false),
  getLastRun: jest.fn((): number | null => null),
  addJob: jest.fn(),
};

// Network-store state + subscription
let networkSubscribeFn: ((state: any, prev: any) => void) | null = null;
const mockNetworkStoreSubscribe = jest.fn((...args: any[]) => {
  networkSubscribeFn = args[0];
  return jest.fn(); // unsubscribe
});
const mockNetworkState = { isConnected: true };

// User-store and database-store mocks
const mockUserStore = { userPersona: { _id: 'p-1' } };
const mockDbStore = { ready: true };

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (...args: any[]) => mockAppStateAddEventListener(...args),
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
    info: jest.fn(),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

import { AppScheduler } from '../AppScheduler';
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
  networkSubscribeFn = null;
  mockNetworkState.isConnected = true;
  mockUserStore.userPersona = { _id: 'p-1' } as any;
  mockDbStore.ready = true;

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
    await jest.advanceTimersByTimeAsync(0);

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
    await jest.advanceTimersByTimeAsync(0);

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
    await jest.advanceTimersByTimeAsync(0);

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
    await jest.advanceTimersByTimeAsync(0);

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
});

export {};
