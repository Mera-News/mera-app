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
const mockLogAddBreadcrumb = jest.fn();
const mockAppSchedulerTrigger = jest.fn();
const mockAppSchedulerRecordFailure = jest.fn();
const mockAppSchedulerClearFailure = jest.fn();

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
  // The REAL classifier, deliberately — not a stub. The runner used to
  // hand-repeat the 401 and cancellation checks, and the whole point of moving
  // them behind one exported function is that this path gets the same answer
  // logger.captureException would. A stub here could drift from the rule it is
  // meant to be enforcing and these tests would still pass.
  classifySuppression: (...args: any[]) =>
    (jest.requireActual('@/lib/logger') as typeof import('@/lib/logger'))
      .classifySuppression(...(args as [Error])),
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: (...args: any[]) => mockLogWarn(...args),
    addBreadcrumb: (...args: any[]) => mockLogAddBreadcrumb(...args),
    captureException: jest.fn(),
  },
}));

// AppScheduler is required dynamically inside runner.run() — on the retry path
// and on BOTH outcome paths for the failure backoff.
//
// This factory must name every export run() calls: an explicit factory returns
// undefined for anything it omits, and the failure is a TypeError at the call
// site rather than a missing-mock message.
jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: {
    trigger: (...args: any[]) => mockAppSchedulerTrigger(...args),
    recordFailure: (...args: any[]) => mockAppSchedulerRecordFailure(...args),
    clearFailure: (...args: any[]) => mockAppSchedulerClearFailure(...args),
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
        markNoOp: expect.any(Function),
      }),
    );
  });

  it('marks job completed in persistence and store on success', async () => {
    await run(makeJob(), makeDefinition());

    expect(mockMarkCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number));
    expect(mockSaveLastRun).toHaveBeenCalledWith('feed-sync', expect.any(Number));
    expect(mockSetJobCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number), true);
  });

  it('does NOT stamp lastRun when the handler called ctx.markNoOp()', async () => {
    // A handler that guarded itself out (or was aborted) must not arm the
    // task's frequency gate — otherwise one skipped cycle costs a whole
    // frequency window before the next attempt.
    const handler = jest.fn().mockImplementation(async (_input, ctx) => {
      ctx.markNoOp();
    });

    await run(makeJob(), makeDefinition({ handler }));

    expect(mockMarkCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number));
    expect(mockSaveLastRun).not.toHaveBeenCalled();
    expect(mockSetJobCompleted).toHaveBeenCalledWith('job-test-1', expect.any(Number), false);
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

  it.each([
    ['a bare ServerError', { statusCode: 401 }],
    ['a wrapped network error', { networkError: { statusCode: 401 } }],
    ['a fetch-style response', { response: { status: 401 } }],
  ])(
    'does NOT capture a 401 to Sentry (%s) — breadcrumb only',
    async (_label, shape) => {
      const err = Object.assign(new Error('Response not successful: Received status code 401'), shape);
      const job = makeJob({ attempt: 1, maxAttempts: 3 });
      await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

      expect(mockCaptureException).not.toHaveBeenCalled();
      // Assert the STRUCTURED class, not the prose. The breadcrumb text is now
      // generated from the shared classifier's verdict, so pinning the wording
      // would make this test a copy of a string rather than of the rule.
      expect(mockLogAddBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('Sentry capture suppressed'),
        'scheduler',
        expect.objectContaining({ jobId: 'job-test-1', suppressed: 'auth' }),
        'warning',
      );
    },
  );

  // This capture calls Sentry DIRECTLY (withScope, for the scheduler.* tags), so
  // it cannot go through logger.captureException — it asks the shared
  // classifier for the same verdict instead. A feed-sync step torn down
  // mid-flight throws createCancellationError(); reporting that spends an issue
  // on a non-event.
  it('does NOT capture a cancellation to Sentry — breadcrumb only', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLogAddBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('Sentry capture suppressed'),
      'scheduler',
      expect.objectContaining({ jobId: 'job-test-1', suppressed: 'cancelled' }),
      'info',
    );
  });

  // A class the runner never knew about reaches it for free now. This is the
  // regression guard for the refactor: before it, a new class at the choke
  // point left this path reporting, and nothing failed.
  it('does NOT capture a no-credential error to Sentry — breadcrumb only', async () => {
    const err = Object.assign(new Error('no device keypair'), {
      name: 'NoCredentialError',
    });
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLogAddBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('Sentry capture suppressed'),
      'scheduler',
      expect.objectContaining({ jobId: 'job-test-1', suppressed: 'no-credential' }),
      'info',
    );
  });

  it('still records the failure and its retry bookkeeping for a 401', async () => {
    const err = Object.assign(new Error('401'), { statusCode: 401 });
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    // Suppressing the Sentry event must not turn the failure into a success:
    // a 401 is a non-retryable 4xx, so it is marked failed AND exhausted.
    expect(mockMarkFailed).toHaveBeenCalled();
    expect(mockMarkFailed.mock.calls[0][2]).toBe(true);
    expect(mockSetJobFailed).toHaveBeenCalled();
  });

  it('schedules retry via AppScheduler.trigger when retryAt is set', async () => {
    const err = new Error('retry me');
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    // There should be a setTimeout call for retry
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(30_000);
    // The opts are the whole contract of the retry path, so assert them rather
    // than just the task name: attempt+1 is what makes the ladder terminate,
    // and bypassDebounce is what keeps a machine retry from consuming the
    // window that bounds a human pull.
    expect(mockAppSchedulerTrigger).toHaveBeenCalledWith('feed-sync', undefined, {
      bypassDebounce: true,
      attempt: 2,
    });
  });

  it('does NOT schedule retry when job is exhausted', async () => {
    const err = new Error('exhausted');
    const job = makeJob({ attempt: 3, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockAppSchedulerTrigger).not.toHaveBeenCalled();
  });

  // ── Non-retryable errors are terminal: no reschedule even with attempts left.
  it('does NOT reschedule a non-retryable error even on attempt 1', async () => {
    // A BAD_USER_INPUT GraphQL error (server rejected the request) — retrying
    // just re-runs the same doomed request storm.
    const err = { errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] };
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    // Marked terminal (exhausted=true, no retryAt) and no timer scheduled.
    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, true, undefined);
    expect(mockSetJobFailed).toHaveBeenCalledWith('job-test-1', true, undefined);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockAppSchedulerTrigger).not.toHaveBeenCalled();
    expect(mockLogAddBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('non-retryable'),
      'scheduler',
      expect.objectContaining({ jobId: 'job-test-1', attempt: 1 }),
      'warning',
    );
  });

  it('does NOT reschedule a 4xx network error', async () => {
    const err = { statusCode: 400, message: 'Bad Request' };
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, true, undefined);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockAppSchedulerTrigger).not.toHaveBeenCalled();
  });

  it('still reschedules a transient (5xx) error with attempts left', async () => {
    const err = { statusCode: 503, message: 'Service Unavailable' };
    const job = makeJob({ attempt: 1, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, false, expect.any(Number));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockAppSchedulerTrigger).toHaveBeenCalledWith('feed-sync', undefined, {
      bypassDebounce: true,
      attempt: 2,
    });
  });

  // ── the ladder must TERMINATE ───────────────────────────────────────────
  // createJob used to hardcode attempt: 1, and the runner reschedules through
  // AppScheduler.trigger() — so every retry minted a fresh attempt-1 job,
  // `job.attempt >= maxAttempts` was never true, and this "3 attempts then give
  // up" ladder was really an unbounded 30s loop. Asserting that the attempt
  // increments is NOT enough: that passes on the broken code too, because the
  // increment happened and was then thrown away. The terminal case is the test.
  it('is TERMINAL on the third failure: no further retry is scheduled', async () => {
    const err = new Error('still broken');
    const job = makeJob({ attempt: 3, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, true, undefined);

    await jest.advanceTimersByTimeAsync(300_000);
    expect(mockAppSchedulerTrigger).not.toHaveBeenCalled();
  });

  it('still reschedules on the second failure (the rung before terminal)', async () => {
    const err = new Error('transient');
    const job = makeJob({ attempt: 2, maxAttempts: 3 });
    await run(job, makeDefinition({ handler: jest.fn().mockRejectedValue(err) }));

    expect(mockMarkFailed).toHaveBeenCalledWith('job-test-1', err, false, expect.any(Number));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockAppSchedulerTrigger).toHaveBeenCalledWith('feed-sync', undefined, {
      bypassDebounce: true,
      attempt: 3,
    });
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

// ── failure backoff bookkeeping ────────────────────────────────────────────
// Set and clear both live HERE, symmetric with saveLastRun, and not in
// AppScheduler._enqueueAndRun. run() catches without rethrowing, so its promise
// resolves on every outcome — a clear placed at the call site would fire
// immediately after the record and the tick gate would never bite.
describe('run — failure backoff bookkeeping', () => {
  it('clears the failure backoff on a successful run', async () => {
    const task = makeDefinition({ name: 'ok-task' });
    await run(makeJob({ taskName: 'ok-task' }), task);

    expect(mockAppSchedulerClearFailure).toHaveBeenCalledWith('ok-task');
    expect(mockAppSchedulerRecordFailure).not.toHaveBeenCalled();
  });

  it('records the failure when the handler throws', async () => {
    const task = makeDefinition({
      name: 'bad-task',
      handler: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await run(makeJob({ taskName: 'bad-task' }), task);

    expect(mockAppSchedulerRecordFailure).toHaveBeenCalledWith('bad-task');
    expect(mockAppSchedulerClearFailure).not.toHaveBeenCalled();
  });

  // A no-op is not a failure: the cycle was skipped, not broken, and it must
  // stay free to retry on the next tick.
  it('clears rather than records when the handler called markNoOp', async () => {
    const task = makeDefinition({
      name: 'noop-task',
      handler: jest.fn(async (_i: unknown, ctx: any) => { ctx.markNoOp(); }),
    });
    await run(makeJob({ taskName: 'noop-task' }), task);

    expect(mockAppSchedulerClearFailure).toHaveBeenCalledWith('noop-task');
    expect(mockAppSchedulerRecordFailure).not.toHaveBeenCalled();
  });

  it('records the failure even when the error is non-retryable', async () => {
    const err = Object.assign(new Error('bad input'), { statusCode: 400 });
    const task = makeDefinition({
      name: 'terminal-task',
      handler: jest.fn().mockRejectedValue(err),
    });
    await run(makeJob({ taskName: 'terminal-task' }), task);

    expect(mockAppSchedulerRecordFailure).toHaveBeenCalledWith('terminal-task');
  });
});
