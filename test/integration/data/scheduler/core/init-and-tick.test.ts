// AppScheduler.init / dispose and the 5s tick, driven through the real singleton, the real
// scheduler-runner, real `scheduler_jobs` and `settings` rows in the in-memory DB and the real
// scheduler store. Only the clock and AppState are faked.
import '@/test/helpers';

import database from '@/lib/database';
import type SchedulerJobModel from '@/lib/database/models/SchedulerJob';
import { AppScheduler, FAILURE_TICK_BACKOFF_MS } from '@/lib/scheduler/AppScheduler';
import * as persistence from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, setAppState, useFakeClock } from '@/test/helpers';

import { addTask, jobRows, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3_600_000;

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

const init = () => advanceUntilDone(AppScheduler.init());

describe('init', () => {
  it('loads the last-run times persisted by earlier sessions into the store', async () => {
    const task = addTask({ frequency: HOUR });
    await persistence.saveLastRun(task.name, T0 - 90_000);

    await init();

    expect(useSchedulerStore.getState().getLastRun(task.name)).toBe(T0 - 90_000);
    expect(useSchedulerStore.getState().status).toBe('running');
  });

  it('marks a job left running by a crash as stale, and leaves a recent running job alone', async () => {
    const task = addTask({ frequency: 0 });
    const crashed = await persistence.createJob(task.def);
    await persistence.markRunning(crashed.id);
    // Three hours later: the job's startedAt is now older than the two-hour cutoff.
    jest.setSystemTime(T0 + 3 * HOUR);
    const recent = await persistence.createJob(task.def);
    await persistence.markRunning(recent.id);

    await init();

    const status = Object.fromEntries((await jobRows(task.name)).map((r) => [r.id, r.status]));
    expect(status[crashed.id]).toBe('stale');
    expect(status[recent.id]).toBe('running');
  });

  it('replays a foreground that arrives while init is still loading, instead of losing it', async () => {
    const task = addTask({
      frequency: 5 * 60_000,
      triggers: ['app-foreground'],
      exclusive: true,
    });
    // 2 minutes ago: past the warm 60s foreground floor, not due for the 5 minute tick.
    await persistence.saveLastRun(task.name, T0 - 120_000);

    const initializing = AppScheduler.init();
    // The change listener is attached before init's first await, so this lands in the window.
    setAppState('background');
    setAppState('active');
    expect(useSchedulerStore.getState().status).toBe('initializing');
    expect(task.runs).toHaveLength(0);

    await advanceUntilDone(initializing);
    await settle(500);

    expect(task.runs).toHaveLength(1);
  });

  it('dispose removes the AppState and network listeners and stops the tick', async () => {
    const task = addTask({
      frequency: 10_000,
      triggers: ['app-foreground', 'network-reconnect'],
    });
    await init();
    await settle(500);
    expect(task.runs).toHaveLength(1);

    AppScheduler.dispose();
    // Due again by every measure: an old last run, no failure on record.
    useSchedulerStore.getState().setLastRun(task.name, T0 - HOUR);

    setAppState('background');
    setAppState('active');
    useNetworkStore.getState().setIsConnected(false);
    useNetworkStore.getState().setIsConnected(true);
    await settle(20_000);

    expect(task.runs).toHaveLength(1);
    expect(useSchedulerStore.getState().status).toBe('paused');
  });
});

describe('tick', () => {
  it('fires a due timer task on the first tick after init', async () => {
    const task = addTask({ frequency: 10_000 });

    await init();
    await settle(500);

    expect(task.runs).toHaveLength(1);
  });

  it('fires nothing while backgrounded, then fires on the first tick once active again', async () => {
    const task = addTask({ frequency: 10_000 });
    setAppState('background');
    await init();

    await settle(30_000);
    expect(task.runs).toHaveLength(0);

    setAppState('active');
    await settle(5_100);
    expect(task.runs).toHaveLength(1);
  });

  it('never fires a frequency 0 task from the tick', async () => {
    const eventOnly = addTask({ frequency: 0, triggers: ['app-foreground'] });
    const noTriggers = addTask({ frequency: 0 });

    await init();
    await settle(30_000);

    expect(eventOnly.runs).toHaveLength(0);
    expect(noTriggers.runs).toHaveLength(0);
  });

  it('does not start a second run of an exclusive task while one is running, but does for a non-exclusive one', async () => {
    const exclusive = addTask({ frequency: 10_000, exclusive: true, hang: true });
    const concurrent = addTask({ frequency: 10_000, hang: true });

    await init();
    await settle(30_000);

    expect(exclusive.runs).toHaveLength(1);
    expect(concurrent.runs.length).toBeGreaterThan(1);
    exclusive.release();
    concurrent.release();
    await settle(500);
  });

  it('skips a paused task and runs it on the next tick after it is resumed', async () => {
    const task = addTask({ frequency: 10_000 });
    AppScheduler.pauseTask(task.name);

    await init();
    await settle(30_000);
    expect(task.runs).toHaveLength(0);
    expect(AppScheduler.isPaused(task.name)).toBe(true);

    AppScheduler.resumeTask(task.name);
    await settle(5_100);
    expect(task.runs).toHaveLength(1);
  });

  it('skips a task whose last run is inside its (jittered) cadence', async () => {
    const task = addTask({ frequency: 10 * 60_000 });
    await persistence.saveLastRun(task.name, T0 - 60_000);

    await init();
    await settle(30_000);

    expect(task.runs).toHaveLength(0);
  });

  it('does not re-fire a failed task inside FAILURE_TICK_BACKOFF_MS, and re-fires it after', async () => {
    // maxAttempts 1: the failure is terminal, so only the tick can start another run.
    const task = addTask({ frequency: 10_000, maxAttempts: 1, failWith: new Error('boom') });

    await init();
    await settle(500);
    expect(task.runs).toHaveLength(1);

    // A failed run does not stamp lastRun, so the task is "due" on every tick; the backoff alone holds it.
    expect(useSchedulerStore.getState().getLastRun(task.name)).toBeNull();
    await settle(FAILURE_TICK_BACKOFF_MS - 5_000);
    expect(task.runs).toHaveLength(1);

    await settle(10_000);
    expect(task.runs).toHaveLength(2);
  });

  it('records a completed job row per run', async () => {
    const task = addTask({ frequency: 10_000 });

    await init();
    await settle(500);

    const rows: SchedulerJobModel[] = await database
      .get<SchedulerJobModel>('scheduler_jobs')
      .query()
      .fetch();
    expect(rows.map((r) => [r.taskName, r.status])).toEqual([[task.name, 'completed']]);
  });
});
