// scheduler-runner.run(), reached the way the app reaches it: AppScheduler.trigger() enqueues a
// real job row and the runner drives the handler, the persistence layer, the store and the retry
// ladder. Sentry and the logger are the observed edges.
import '@/test/helpers';

import * as Sentry from '@sentry/react-native';

import { getSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, setAppState, useFakeClock } from '@/test/helpers';

import { addTask, jobRows, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

const run = (name: string) =>
  advanceUntilDone(AppScheduler.trigger(name, undefined, { bypassDebounce: true }));

const lastRunRow = (name: string) => getSetting(`scheduler_last_run_${name}`);

describe('success', () => {
  it('stamps lastRun in both the persisted settings row and the store, and completes the job row', async () => {
    const task = addTask();

    await run(task.name);

    expect(await lastRunRow(task.name)).toBe(String(T0));
    expect(useSchedulerStore.getState().getLastRun(task.name)).toBe(T0);
    const [row] = await jobRows(task.name);
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBe(T0);
    expect(useSchedulerStore.getState().taskCurrentStatus[task.name]).toBe('completed');
  });

  it('does NOT stamp lastRun when the handler called markNoOp, but still completes the job', async () => {
    const task = addTask({ noOp: true });

    await run(task.name);

    expect(await lastRunRow(task.name)).toBeNull();
    expect(useSchedulerStore.getState().getLastRun(task.name)).toBeNull();
    expect((await jobRows(task.name))[0].status).toBe('completed');
  });

  it('hands the handler its job id, attempt and a live abort signal, and reports progress to the store', async () => {
    const task = addTask({ hang: true });
    const running = AppScheduler.trigger(task.name, { a: 1 }, { bypassDebounce: true });
    await settle(100);

    const { ctx } = task.runs[0];
    const [row] = await jobRows(task.name);
    expect(ctx.jobId).toBe(row.id);
    expect(ctx.attempt).toBe(1);
    expect(ctx.signal.aborted).toBe(false);
    expect(row.status).toBe('running');
    expect(useSchedulerStore.getState().isRunning(task.name)).toBe(true);

    ctx.reportProgress({ step: 'fetch', current: 2, total: 5 });
    expect(useSchedulerStore.getState().taskProgress[task.name]).toEqual({ step: 'fetch', current: 2, total: 5 });
    const info = jest.spyOn(logger, 'info');
    ctx.log('halfway');
    expect(info).toHaveBeenCalledWith(`[${task.name}] halfway`);

    task.release();
    await advanceUntilDone(running);
  });
});

describe('failure', () => {
  it('does not stamp lastRun, records the failure on the job row and keeps the task re-triggerable', async () => {
    const task = addTask({ maxAttempts: 1, failWith: new Error('upstream exploded') });

    await run(task.name);

    expect(await lastRunRow(task.name)).toBeNull();
    expect(useSchedulerStore.getState().getLastRun(task.name)).toBeNull();
    const [row] = await jobRows(task.name);
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'upstream exploded' });
    expect(useSchedulerStore.getState().failedCount).toBe(1);
  });

  it('records lastFailureAt, which holds the 5s tick off the task for the next 60s', async () => {
    const task = addTask({ frequency: 10_000, maxAttempts: 1, failWith: new Error('boom') });
    await run(task.name);
    expect(task.runs).toHaveLength(1);

    await advanceUntilDone(AppScheduler.init());
    await settle(30_000);

    // Due by cadence (never succeeded), yet not fired: only the recorded failure explains it.
    expect(task.runs).toHaveLength(1);
  });

  it('schedules a retry at the default 30s rung and marks the row retrying with its retryAt', async () => {
    const task = addTask({ failWith: new Error('flaky') });

    await run(task.name);

    const [row] = await jobRows(task.name);
    expect(row).toMatchObject({ status: 'retrying', attempt: 1 });
    expect(row.retryAt).toBe(T0 + 30_000);
    await settle(29_000);
    expect(task.runs).toHaveLength(1);
    await settle(2_000);
    expect(task.runs).toHaveLength(2);
  });

  it('uses the task retryDelay when it has one', async () => {
    const task = addTask({ failWith: new Error('flaky'), retryDelay: () => 5_000 });

    await run(task.name);
    await settle(6_000);

    expect(task.runs).toHaveLength(2);
    expect((await jobRows(task.name))[0].retryAt).toBe(T0 + 5_000);
  });

  // The guard for trigger() threading `attempt` into createJob. Mint a retry job at attempt 1 and
  // `job.attempt >= maxAttempts` is never true: the ladder becomes an unbounded 30s loop. The
  // assertion is on the PERSISTED rows, because that is where the missing attempt shows.
  it('TERMINATES at maxAttempts: the ladder runs 30s then 60s apart and stops, on the persisted rows', async () => {
    const task = addTask({ failWith: new Error('always down'), maxAttempts: 3 });

    await run(task.name);
    await settle(31_000);
    expect(task.runs).toHaveLength(2);
    await settle(61_000);
    expect(task.runs).toHaveLength(3);
    // Far past the 120s rung a fourth attempt would have waited for.
    await settle(600_000);

    const rows = await jobRows(task.name);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
      [3, 'failed'],
    ]);
    expect(task.runs).toHaveLength(3);
    expect(rows[1].retryAt).toBe(rows[1].scheduledAt + 60_000);
    expect(task.runs.map((r) => r.ctx.attempt)).toEqual([1, 2, 3]);
  });

  it('treats a non-retryable error (a 4xx) as terminal at once, with no retry scheduled', async () => {
    const task = addTask({ failWith: Object.assign(new Error('bad request'), { statusCode: 400 }) });

    await run(task.name);
    await settle(600_000);

    expect(task.runs).toHaveLength(1);
    const rows = await jobRows(task.name);
    expect(rows.map((r) => [r.attempt, r.status, r.retryAt])).toEqual([[1, 'failed', null]]);
  });

  it('still retries a transient 5xx while attempts remain', async () => {
    const task = addTask({ failWith: Object.assign(new Error('bad gateway'), { statusCode: 502 }) });

    await run(task.name);
    await settle(31_000);

    expect(task.runs).toHaveLength(2);
  });

  it('a retry is skipped when the task was paused meanwhile (the retry goes through trigger)', async () => {
    const task = addTask({ failWith: new Error('flaky') });
    await run(task.name);

    AppScheduler.pauseTask(task.name);
    await settle(31_000);

    expect(task.runs).toHaveLength(1);
  });
});

describe('timeout', () => {
  it("aborts ctx.signal with the reason 'timeout' once the task timeout elapses", async () => {
    const task = addTask({ hang: true, timeout: 1_000, maxAttempts: 1 });
    const running = AppScheduler.trigger(task.name, undefined, { bypassDebounce: true });
    await settle(900);
    const { signal } = task.runs[0].ctx;
    expect(signal.aborted).toBe(false);

    await settle(200);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('timeout');
    task.release();
    await advanceUntilDone(running);
  });

  it('never aborts the signal of a run that finished in time', async () => {
    const task = addTask({ timeout: 1_000 });

    await run(task.name);
    await settle(5_000);

    expect(task.runs[0].ctx.signal.aborted).toBe(false);
  });
});

describe('error reporting', () => {
  const breadcrumbs = () => jest.spyOn(logger, 'addBreadcrumb');

  function expectSuppressed(spy: jest.SpyInstance, why: string) {
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Sentry capture suppressed'),
      'scheduler',
      expect.objectContaining({ suppressed: why }),
      expect.anything(),
    );
  }

  it('captures an ordinary failure to Sentry with the scheduler tags and an error level once exhausted', async () => {
    const tags: Record<string, string> = {};
    const level = jest.fn();
    (Sentry.withScope as jest.Mock).mockImplementationOnce((cb: (scope: unknown) => void) =>
      cb({ setTag: (k: string, v: string) => (tags[k] = v), setLevel: level }),
    );
    const error = new Error('real defect');
    const task = addTask({ maxAttempts: 1, failWith: error });

    await run(task.name);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(tags).toMatchObject({ 'scheduler.task': task.name, 'scheduler.attempt': '1' });
    expect(level).toHaveBeenCalledWith('error');
  });

  it('reports a failure that still has retries left at warning level', async () => {
    const level = jest.fn();
    (Sentry.withScope as jest.Mock).mockImplementationOnce((cb: (scope: unknown) => void) =>
      cb({ setTag: jest.fn(), setLevel: level }),
    );
    const task = addTask({ failWith: new Error('real defect') });

    await run(task.name);

    expect(level).toHaveBeenCalledWith('warning');
  });

  it('suppresses a 401 to a breadcrumb', async () => {
    const spy = breadcrumbs();
    const task = addTask({ maxAttempts: 1, failWith: Object.assign(new Error('unauthorised'), { statusCode: 401 }) });

    await run(task.name);

    expectSuppressed(spy, 'auth');
  });

  it('suppresses a transient network error while the device is confirmed offline', async () => {
    const spy = breadcrumbs();
    useNetworkStore.getState().setIsConnected(false);
    const task = addTask({ maxAttempts: 1, failWith: new Error('Network request failed') });

    await run(task.name);

    expectSuppressed(spy, 'offline');
  });

  it('reports the same network error while the device is online: offline needs both halves', async () => {
    const error = new Error('Network request failed');
    const task = addTask({ maxAttempts: 1, failWith: error });

    await run(task.name);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('suppresses a cancellation', async () => {
    const spy = breadcrumbs();
    const task = addTask({ maxAttempts: 1, failWith: Object.assign(new Error('aborted'), { name: 'AbortError' }) });

    await run(task.name);

    expectSuppressed(spy, 'cancelled');
  });

  it('suppresses our request timeout while the app is not in the foreground', async () => {
    const spy = breadcrumbs();
    const task = addTask({
      maxAttempts: 1,
      failWith: Object.assign(new Error('request timed out'), { isRequestTimeout: true, elapsedMs: 30_000 }),
    });
    setAppState('background');

    await run(task.name);

    expectSuppressed(spy, 'backgrounded-timeout');
  });

  it('reports the same request timeout in the foreground', async () => {
    const error = Object.assign(new Error('request timed out'), { isRequestTimeout: true, elapsedMs: 30_000 });
    const task = addTask({ maxAttempts: 1, failWith: error });

    await run(task.name);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('suppresses a missing local credential', async () => {
    const spy = breadcrumbs();
    const task = addTask({ maxAttempts: 1, failWith: Object.assign(new Error('no key'), { name: 'NoCredentialError' }) });

    await run(task.name);

    expectSuppressed(spy, 'no-credential');
  });

  it('keeps the retry bookkeeping of a suppressed failure: the row is retrying and a retry follows', async () => {
    useNetworkStore.getState().setIsConnected(false);
    const task = addTask({ failWith: new Error('Network request failed') });

    await run(task.name);
    await settle(31_000);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect((await jobRows(task.name)).map((r) => [r.attempt, r.status])).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
    ]);
  });
});
