// AppScheduler.trigger(): the manual path (pull-to-refresh, tab re-tap, the runner's retry ladder).
// It bypasses every condition and cadence gate and carries a 3s debounce, so its outcome and its
// debounce bookkeeping are the contract.
import '@/test/helpers';

import { AppScheduler, TRIGGER_DEBOUNCE_MS } from '@/lib/scheduler/AppScheduler';
import * as persistence from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
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

/** `trigger()` under the fake clock: the run and its job rows need timers to turn. */
const trigger = (...args: Parameters<typeof AppScheduler.trigger>) =>
  advanceUntilDone(AppScheduler.trigger(...args));

describe('trigger', () => {
  it('throws for a task that was never registered', async () => {
    await expect(AppScheduler.trigger('no-such-task')).rejects.toThrow('Unknown task: no-such-task');
  });

  it('runs the task at once with its input and reports "ran"', async () => {
    const task = addTask({ frequency: 3_600_000 });

    const outcome = await trigger(task.name, { fact: 'f1' });

    expect(outcome).toBe('ran');
    expect(task.runs.map((r) => r.input)).toEqual([{ fact: 'f1' }]);
    const [row] = await jobRows(task.name);
    expect(row).toMatchObject({ status: 'completed', attempt: 1 });
    expect(JSON.parse(row.inputJson ?? 'null')).toEqual({ fact: 'f1' });
  });

  it('bypasses conditions entirely: a task whose conditions all fail still runs', async () => {
    const task = addTask({
      frequency: 3_600_000,
      conditions: [{ type: 'custom', check: () => false }, { type: 'db-ready' }, { type: 'network' }],
    });
    expect(useDatabaseStore.getState().ready).toBe(false);

    expect(await trigger(task.name)).toBe('ran');

    expect(task.runs).toHaveLength(1);
  });

  it('bypasses the tick\'s foreground-only gate: it runs while the app is backgrounded', async () => {
    const task = addTask({ frequency: 3_600_000 });
    setAppState('background');

    expect(await trigger(task.name)).toBe('ran');

    expect(task.runs).toHaveLength(1);
  });

  it('reports "paused" for a paused task, runs nothing, and does not consume the debounce window', async () => {
    const task = addTask({ frequency: 3_600_000 });
    AppScheduler.pauseTask(task.name);

    expect(await trigger(task.name)).toBe('paused');
    expect(task.runs).toHaveLength(0);

    AppScheduler.resumeTask(task.name);
    expect(await trigger(task.name)).toBe('ran');
  });

  it('reports "busy" for an exclusive task that is already running', async () => {
    const task = addTask({ frequency: 3_600_000, exclusive: true, hang: true });
    const first = AppScheduler.trigger(task.name);
    await settle(100);
    expect(task.runs).toHaveLength(1);

    expect(await trigger(task.name)).toBe('busy');

    expect(task.runs).toHaveLength(1);
    task.release();
    await advanceUntilDone(first);
  });

  it('reports "debounced" inside the 3s window for a non-exclusive task, and runs again after it', async () => {
    const task = addTask({ frequency: 3_600_000 });
    expect(await trigger(task.name)).toBe('ran');

    await settle(1_000);
    expect(await trigger(task.name)).toBe('debounced');
    expect(task.runs).toHaveLength(1);

    await settle(TRIGGER_DEBOUNCE_MS);
    expect(await trigger(task.name)).toBe('ran');
    expect(task.runs).toHaveLength(2);
  });

  it('debounces per task: another task is unaffected', async () => {
    const a = addTask({ frequency: 3_600_000 });
    const b = addTask({ frequency: 3_600_000 });
    await trigger(a.name);

    expect(await trigger(b.name)).toBe('ran');
  });

  it('keys the debounce on trigger time: a scheduled run a second ago does not swallow a pull', async () => {
    const task = addTask({ frequency: 10_000 });
    await advanceUntilDone(AppScheduler.init());
    await settle(500);
    expect(task.runs).toHaveLength(1);

    await settle(1_000);

    expect(await trigger(task.name)).toBe('ran');
    expect(task.runs).toHaveLength(2);
  });

  it('exempts a trigger after a FAILED run: the retry is not debounced', async () => {
    const task = addTask({ frequency: 3_600_000, maxAttempts: 1, failWith: new Error('boom') });
    expect(await trigger(task.name)).toBe('ran');

    await settle(500);

    expect(await trigger(task.name)).toBe('ran');
    expect(task.runs).toHaveLength(2);
  });

  it('stops exempting once a later run succeeded and cleared the failure', async () => {
    const task = addTask({ frequency: 3_600_000, maxAttempts: 1, failWith: new Error('boom') });
    await trigger(task.name);

    // The recovery run does no real work (markNoOp), so it never stamps lastRun: only the
    // runner's clearFailure can tell the next pull that the failure is behind it.
    task.failWith = null;
    task.noOp = true;
    await settle(500);
    expect(await trigger(task.name)).toBe('ran');

    await settle(500);
    expect(await trigger(task.name)).toBe('debounced');
  });

  it('bypassDebounce runs inside the window and neither checks nor consumes it', async () => {
    const task = addTask({ frequency: 3_600_000 });

    expect(await trigger(task.name, undefined, { bypassDebounce: true })).toBe('ran');
    // The bypassed run stamped nothing, so a human pull straight after is not debounced...
    expect(await trigger(task.name)).toBe('ran');
    // ...and a bypassed run inside the human's window still goes through.
    expect(await trigger(task.name, undefined, { bypassDebounce: true })).toBe('ran');
    // The human's own stamp is intact.
    expect(await trigger(task.name)).toBe('debounced');
    expect(task.runs).toHaveLength(3);
  });

  it('dispose() forgets the debounce window', async () => {
    const task = addTask({ frequency: 3_600_000 });
    await trigger(task.name);
    AppScheduler.dispose();

    expect(await trigger(task.name)).toBe('ran');
  });

  it('threads opts.attempt into the persisted job and the handler context (default 1)', async () => {
    const task = addTask({ frequency: 3_600_000, maxAttempts: 4 });

    await trigger(task.name, undefined, { bypassDebounce: true, attempt: 3 });
    await trigger(task.name, undefined, { bypassDebounce: true });

    expect((await jobRows(task.name)).map((r) => [r.attempt, r.maxAttempts])).toEqual([
      [3, 4],
      [1, 4],
    ]);
    expect(task.runs.map((r) => r.ctx.attempt)).toEqual([3, 1]);
  });

  it('releases an exclusive reservation when the job row cannot be created, so the task is not stuck', async () => {
    const task = addTask({ frequency: 3_600_000, exclusive: true });
    // R23: one failing call on a real function, restored by mockRestore.
    const createJob = jest
      .spyOn(persistence, 'createJob')
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(trigger(task.name)).rejects.toThrow('disk full');
    createJob.mockRestore();

    expect(useSchedulerStore.getState().isRunning(task.name)).toBe(false);
    await settle(TRIGGER_DEBOUNCE_MS);
    expect(await trigger(task.name)).toBe('ran');
  });
});
