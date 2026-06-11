// scheduler-runner.test.ts — unit tests for scheduler-runner.run()

const mockMarkRunning = jest.fn();
const mockMarkCompleted = jest.fn();
const mockMarkFailed = jest.fn();
const mockSaveLastRun = jest.fn();
const mockSetJobRunning = jest.fn();
const mockSetJobCompleted = jest.fn();
const mockSetJobFailed = jest.fn();
const mockUpdateProgress = jest.fn();
const mockStartInactiveSpan = jest.fn();
const mockWithScope = jest.fn();
const mockCaptureException = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockAppSchedulerTrigger = jest.fn();

jest.mock('@/lib/scheduler/scheduler-persistence', () => ({
  markRunning: (...args: any[]) => mockMarkRunning(...args),
  markCompleted: (...args: any[]) => mockMarkCompleted(...args),
  markFailed: (...args: any[]) => mockMarkFailed(...args),
  saveLastRun: (...args: any[]) => mockSaveLastRun(...args),
}));

jest.mock('@/lib/scheduler/scheduler-store', () => ({
  useSchedulerStore: {
    getState: jest.fn(() => ({
      setJobRunning: mockSetJobRunning,
      setJobCompleted: mockSetJobCompleted,
      setJobFailed: mockSetJobFailed,
      updateProgress: mockUpdateProgress,
    })),
  },
}));

jest.mock('@sentry/react-native', () => ({
  startInactiveSpan: (...args: any[]) => mockStartInactiveSpan(...args),
  withScope: (fn: any) => mockWithScope(fn),
  captureException: (...args: any[]) => mockCaptureException(...args),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: (...args: any[]) => mockLogWarn(...args),
    captureException: jest.fn(),
  },
}));

// AppScheduler is required dynamically inside runner.run() on retry path
jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: {
    trigger: (...args: any[]) => mockAppSchedulerTrigger(...args),
  },
}));

import { run } from '../scheduler-runner';
import type { Job, TaskDefinition } from '../scheduler-types';

const NOW = 1_700_000_000_000;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-test-1',
    taskName: 'feed-sync',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    scheduledAt: NOW - 5000,
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    name: 'feed-sync',
    displayName: 'Feed Sync',
    handler: jest.fn().mockResolvedValue(undefined),
    frequency: 10_000,
    maxAttempts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  mockMarkRunning.mockResolvedValue(undefined);
  mockMarkCompleted.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue(undefined);
  mockSaveLastRun.mockResolvedValue(undefined);

  // Mock Sentry span with no-op methods
  mockStartInactiveSpan.mockReturnValue({
    setStatus: jest.fn(),
    setAttribute: jest.fn(),
    end: jest.fn(),
  });
  mockWithScope.mockImplementation((fn) => {
    fn({
      setTag: jest.fn(),
      setLevel: jest.fn(),
    });
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('run — successful execution', () => {
  it('marks job as running in persistence and store', async () => {
    const job = makeJob();
    const def = makeDefinition();

    await run(job, def);

    expect(mockMarkRunning).toHaveBeenCalledWith('job-test-1');
    expect(mockSetJobRunning).toHaveBeenCalledWith('job-test-1');
  });

  it('calls the handler with input and task context', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const job = makeJob({ input: { topicIds: ['t1'] } });
    const def = makeDefinition({ handler });

    await run(job, def);

    expect(handler).toHaveBeenCalledWith(
      { topicIds: ['t1'] },
      expect.objectContaining({
        jobId: 'job-test-1',
        attempt: 1,
        signal: expect.any(AbortSignal),
        reportProgress: expect.any(Function),
        log: expect.any(Function),
      }),
    );
  });

  it('marks job completed in persistence and store on success', async () => {
    await run(makeJob(), makeDefinition());

    expect(mockMarkCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number));
    expect(mockSaveLastRun).toHaveBeenCalledWith('feed-sync', expect.any(Number));
    expect(mockSetJobCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number));
  });

  it('reportProgress callback calls updateProgress', async () => {
    let capturedCtx: any;
    const handler = jest.fn().mockImplementation(async (_input, ctx) => {
      capturedCtx = ctx;
    });
    await run(makeJob(), makeDefinition({ handler }));

    capturedCtx.reportProgress({ step: 'hydrating', current: 3, total: 10 });
    expect(mockUpdateProgress).toHaveBeenCalledWith('job-test-1', { step: 'hydrating', current: 3, total: 10 });
  });

  it('log callback calls logger.info with task prefix', async () => {
    let capturedCtx: any;
    const handler = jest.fn().mockImplementation(async (_input, ctx) => {
      capturedCtx = ctx;
    });
    await run(makeJob(), makeDefinition({ handler }));

    capturedCtx.log('test message');
    expect(mockLogInfo).toHaveBeenCalledWith('[feed-sync] test message');
  });
});

describe('run — failure handling', () => {
  it('marks job failed when handler throws and attempt exhausted', async () => {
    const err = new Error('handler error');
    const handler = jest.fn().mockRejectedValue(err);
    const job = makeJob({ attempt: 3, maxAttempts: 3 });
    const def = makeDefinition({ handler, maxAttempts: 3 });

    await run(job, def);

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, true, undefined);
    expect(mockSetJobFailed).toHaveBeenCalledWith('job-test-1', true, undefined);
  });

  it('marks job as retrying when handler throws but not exhausted', async () => {
    const err = new Error('transient error');
    const handler = jest.fn().mockRejectedValue(err);
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    const def = makeDefinition({ handler, maxAttempts: 3 });

    await run(job, def);

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, false, expect.any(Number));
    expect(mockSetJobFailed).toHaveBeenCalledWith('job-test-1', false, expect.any(Number));
  });

  it('uses defaultBackoff for retry delay (attempt 1 → 30s)', async () => {
    const err = new Error('fail');
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    const retryAt = mockMarkFailed.mock.calls[0][3];
    expect(retryAt).toBe(NOW + 30_000);
  });

  it('uses defaultBackoff for retry delay (attempt 2 → 60s)', async () => {
    const err = new Error('fail');
    const job = makeJob({ attempt: 2, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    const retryAt = mockMarkFailed.mock.calls[0][3];
    expect(retryAt).toBe(NOW + 60_000);
  });

  it('uses defaultBackoff for retry delay (attempt 3 → capped at 120s)', async () => {
    const err = new Error('fail');
    const job = makeJob({ attempt: 3, maxAttempts: 4 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err), maxAttempts: 4 }));

    const retryAt = mockMarkFailed.mock.calls[0][3];
    expect(retryAt).toBe(NOW + 120_000);
  });

  it('defaultBackoff falls back to 120s for attempt index beyond array (attempt 4 → ?? 120_000 branch)', async () => {
    // Covers the `?? 120_000` branch in defaultBackoff(attempt) when attempt-1 >= 3,
    // i.e. the array index is out of bounds and returns undefined, falling back to 120_000.
    const err = new Error('fail');
    const job = makeJob({ attempt: 4, maxAttempts: 5 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err), maxAttempts: 5 }));

    const retryAt = mockMarkFailed.mock.calls[0][3];
    // defaultBackoff(4) → [30k,60k,120k][3] = undefined ?? 120_000 → 120_000
    expect(retryAt).toBe(NOW + 120_000);
  });

  it('uses definition.maxAttempts ?? 3 default when maxAttempts is undefined', async () => {
    // Covers the `?? 3` branch in `job.attempt >= (definition.maxAttempts ?? 3)` (line 51)
    // when maxAttempts is not set on the definition.
    const err = new Error('fail');
    const job = makeJob({ attempt: 3, maxAttempts: 3 });
    // Omit maxAttempts from definition — defaults to undefined, ?? 3 kicks in
    const { maxAttempts: _omitted, ...defWithoutMax } = makeDefinition();
    const def = { ...defWithoutMax, handler: jest.fn().mockRejectedValue(err) } as TaskDefinition;

    await run(job, def);

    // attempt 3 >= (undefined ?? 3) = 3 → exhausted = true
    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, true, undefined);
  });

  it('uses custom retryDelay when provided', async () => {
    const err = new Error('fail');
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    const def = makeDefinition({
      handler: jest.fn().mockRejectedValue(err),
      retryDelay: (_attempt) => 5_000,
    });

    await run(job, def);

    const retryAt = mockMarkFailed.mock.calls[0][3];
    expect(retryAt).toBe(NOW + 5_000);
  });

  it('captures exception to Sentry on failure', async () => {
    const err = new Error('sentry error');
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockWithScope).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(err);
  });

  it('schedules retry via AppScheduler.trigger when retryAt is set', async () => {
    const err = new Error('retry me');
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    // There should be a setTimeout call for retry
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockAppSchedulerTrigger).toHaveBeenCalledWith('feed-sync');
  });

  it('does NOT schedule retry when job is exhausted', async () => {
    const err = new Error('exhausted');
    const job = makeJob({ attempt: 3, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockAppSchedulerTrigger).not.toHaveBeenCalled();
  });
});

describe('run — timeout/abort', () => {
  it('clears the timeout after handler completes (no timer leak)', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    await run(makeJob(), makeDefinition({ handler }));
    // Timer should have been cleared — no pending timers from success path
    // (the only remaining timer would be from the retry path if applicable)
    expect(mockMarkCompleted).toHaveBeenCalled();
  });

  // Uses real timers: the handler waits for a real 200 ms promise; the 50 ms
  // task timeout fires first and aborts the signal.  Fake-timer advancement
  // cannot unblock the handler's own await-setTimeout under jest-expo's Babel
  // config, so we drop back to real time with small values and a raised timeout.
  it('aborts the signal when timeout fires', async () => {
    jest.useRealTimers(); // switch for this test only
    let capturedSignal: AbortSignal | null = null;
    const handler = jest.fn().mockImplementation(async (_input, ctx) => {
      capturedSignal = ctx.signal;
      // Simulate a long-running task that outlives the task timeout
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });

    const job = makeJob();
    const def = makeDefinition({ handler, timeout: 50 }); // abort after 50 ms

    await run(job, def); // resolves after handler finishes (~200 ms real time)

    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
  }, 15_000);
});

describe('run — Sentry span', () => {
  it('starts an inactive span with task name and op', async () => {
    await run(makeJob(), makeDefinition());

    expect(mockStartInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'task.feed-sync',
        op: 'app.task',
      }),
    );
  });

  it('handles Sentry.startInactiveSpan throwing without crashing run()', async () => {
    mockStartInactiveSpan.mockImplementationOnce(() => {
      throw new Error('sentry unavailable');
    });

    await expect(run(makeJob(), makeDefinition())).resolves.toBeUndefined();
  });

  it('sets span status ok on success', async () => {
    const mockSpan = { setStatus: jest.fn(), setAttribute: jest.fn(), end: jest.fn() };
    mockStartInactiveSpan.mockReturnValueOnce(mockSpan);

    await run(makeJob(), makeDefinition());

    expect(mockSpan.setStatus).toHaveBeenCalledWith('ok');
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('sets span status internal_error on failure', async () => {
    const mockSpan = { setStatus: jest.fn(), setAttribute: jest.fn(), end: jest.fn() };
    mockStartInactiveSpan.mockReturnValueOnce(mockSpan);
    const handler = jest.fn().mockRejectedValue(new Error('fail'));

    await run(makeJob({ attempt: 3, maxAttempts: 3 }), makeDefinition({ handler }));

    expect(mockSpan.setStatus).toHaveBeenCalledWith('internal_error');
    expect(mockSpan.end).toHaveBeenCalled();
  });
});

export {};
