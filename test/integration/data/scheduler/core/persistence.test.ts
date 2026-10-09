// scheduler-persistence against real `scheduler_jobs` and `settings` rows in the in-memory DB.
import '@/test/helpers';

import database from '@/lib/database';
import type SchedulerJobModel from '@/lib/database/models/SchedulerJob';
import { getSetting } from '@/lib/database/services/setting-service';
import {
  createJob,
  loadLastRunTimes,
  markCompleted,
  markFailed,
  markRunning,
  markStaleCrashedJobs,
  modelToJob,
  pruneOldJobs,
  saveLastRun,
} from '@/lib/scheduler/scheduler-persistence';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { useFakeClock } from '@/test/helpers';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const task = (over: Partial<TaskDefinition> = {}): TaskDefinition => ({
  name: 'persist-task',
  displayName: 'Persist task',
  frequency: 0,
  handler: async () => {},
  ...over,
});

const rows = () => database.get<SchedulerJobModel>('scheduler_jobs').query().fetch();
const rowById = async (id: string) => (await rows()).find((r) => r.id === id);

beforeEach(() => {
  useFakeClock(T0);
});

describe('createJob', () => {
  it('persists a pending row and returns the same job back', async () => {
    const job = await createJob(task({ maxAttempts: 5 }), { fact: 'f1' });

    expect(job).toMatchObject({
      taskName: 'persist-task',
      status: 'pending',
      attempt: 1,
      maxAttempts: 5,
      scheduledAt: T0,
      input: { fact: 'f1' },
    });
    const row = await rowById(job.id);
    expect(row).toMatchObject({
      taskName: 'persist-task',
      status: 'pending',
      attempt: 1,
      maxAttempts: 5,
      scheduledAt: T0,
      startedAt: null,
      completedAt: null,
      retryAt: null,
      errorCode: null,
      errorMessage: null,
    });
    expect(modelToJob(row!)).toEqual(job);
  });

  it('defaults maxAttempts to 3 and stores an absent input as null', async () => {
    const job = await createJob(task());

    expect(job.maxAttempts).toBe(3);
    expect(job.input).toBeUndefined();
    expect((await rowById(job.id))!.inputJson).toBeNull();
  });

  it('honours an explicit attempt on the returned job AND on the persisted row', async () => {
    const job = await createJob(task(), undefined, 3);

    expect(job.attempt).toBe(3);
    expect((await rowById(job.id))!.attempt).toBe(3);
  });

  it('mints a distinct id per job', async () => {
    const a = await createJob(task());
    const b = await createJob(task());

    expect(a.id).not.toBe(b.id);
    expect(await rows()).toHaveLength(2);
  });
});

describe('job lifecycle', () => {
  it('markRunning stamps status and startedAt', async () => {
    const job = await createJob(task());
    jest.setSystemTime(T0 + 5_000);

    await markRunning(job.id);

    expect(await rowById(job.id)).toMatchObject({ status: 'running', startedAt: T0 + 5_000 });
  });

  it('markCompleted stamps status and completedAt', async () => {
    const job = await createJob(task());

    await markCompleted(job.id, T0 + 9_000);

    expect(await rowById(job.id)).toMatchObject({ status: 'completed', completedAt: T0 + 9_000 });
  });

  it('markFailed exhausted makes the row failed with the message and no retryAt', async () => {
    const job = await createJob(task());

    await markFailed(job.id, new Error('boom'), true);

    expect(await rowById(job.id)).toMatchObject({ status: 'failed', errorMessage: 'boom', retryAt: null });
  });

  it('markFailed not exhausted makes the row retrying with its retryAt; a non-Error is stringified', async () => {
    const job = await createJob(task());

    await markFailed(job.id, 'plain string', false, T0 + 30_000);

    expect(await rowById(job.id)).toMatchObject({
      status: 'retrying',
      errorMessage: 'plain string',
      retryAt: T0 + 30_000,
    });
  });

  it('the markers do nothing, and create nothing, for an id with no row', async () => {
    await markRunning('missing');
    await markCompleted('missing', T0);
    await markFailed('missing', new Error('x'), true);

    expect(await rows()).toHaveLength(0);
  });

  it('modelToJob maps a failed row back to a Job with its optional fields', async () => {
    const job = await createJob(task(), [1, 2]);
    await markRunning(job.id);
    await markFailed(job.id, new Error('boom'), false, T0 + 30_000);

    expect(modelToJob((await rowById(job.id))!)).toEqual({
      ...job,
      status: 'retrying',
      input: [1, 2],
      startedAt: T0,
      retryAt: T0 + 30_000,
      errorMessage: 'boom',
    });
  });
});

describe('last-run times', () => {
  it('saveLastRun writes one settings row per task that loadLastRunTimes reads back as numbers', async () => {
    await saveLastRun('alpha', T0 - 1_000);
    await saveLastRun('beta', T0 - 2_000);

    expect(await getSetting('scheduler_last_run_alpha')).toBe(String(T0 - 1_000));
    expect(await loadLastRunTimes(['alpha', 'beta'].values())).toEqual({
      alpha: T0 - 1_000,
      beta: T0 - 2_000,
    });
  });

  it('omits a task with no stored time, and an empty task list loads nothing', async () => {
    await saveLastRun('alpha', T0);

    expect(await loadLastRunTimes(['alpha', 'never-ran'].values())).toEqual({ alpha: T0 });
    expect(await loadLastRunTimes([].values())).toEqual({});
  });

  it('keeps the latest stamp when a task saves twice', async () => {
    await saveLastRun('alpha', T0);
    await saveLastRun('alpha', T0 + 1_000);

    expect(await loadLastRunTimes(['alpha'].values())).toEqual({ alpha: T0 + 1_000 });
  });
});

describe('markStaleCrashedJobs', () => {
  it('turns a job that has been running for over 2 hours into stale and leaves a younger one running', async () => {
    const old = await createJob(task());
    await markRunning(old.id);
    jest.setSystemTime(T0 + 90 * 60_000);
    const young = await createJob(task());
    await markRunning(young.id);
    jest.setSystemTime(T0 + 2 * HOUR + 60_000);

    await markStaleCrashedJobs();

    expect((await rowById(old.id))!.status).toBe('stale');
    expect((await rowById(young.id))!.status).toBe('running');
  });

  it('leaves jobs in any other status alone', async () => {
    const pending = await createJob(task());
    jest.setSystemTime(T0 + 5 * HOUR);

    await markStaleCrashedJobs();

    expect((await rowById(pending.id))!.status).toBe('pending');
  });
});

describe('pruneOldJobs', () => {
  /** A job created `ageMs` before T0 and then moved to the given state, all at that past moment. */
  async function jobAged(ageMs: number, state: 'pending' | 'running' | 'completed' | 'failed' | 'retrying') {
    jest.setSystemTime(T0 - ageMs);
    const job = await createJob(task());
    if (state === 'running') await markRunning(job.id);
    if (state === 'completed') await markCompleted(job.id, Date.now());
    if (state === 'failed') await markFailed(job.id, new Error('x'), true);
    if (state === 'retrying') await markFailed(job.id, new Error('x'), false, Date.now() + 30_000);
    return job.id;
  }

  it('drops finished jobs older than 7 days and keeps recent ones and every unfinished one', async () => {
    const oldCompleted = await jobAged(8 * DAY, 'completed');
    const oldFailed = await jobAged(8 * DAY, 'failed');
    const oldPending = await jobAged(8 * DAY, 'pending');
    const oldRunning = await jobAged(8 * DAY, 'running');
    const recentCompleted = await jobAged(6 * DAY, 'completed');
    const recentFailed = await jobAged(1 * DAY, 'failed');
    jest.setSystemTime(T0);

    await pruneOldJobs();

    const left = (await rows()).map((r) => r.id).sort();
    expect(left).toEqual([oldPending, oldRunning, recentCompleted, recentFailed].sort());
    expect(left).not.toContain(oldCompleted);
    expect(left).not.toContain(oldFailed);
  });

  it('drops a stale-marked job past the window too', async () => {
    jest.setSystemTime(T0 - 9 * DAY);
    const job = await createJob(task());
    await markRunning(job.id);
    jest.setSystemTime(T0 - 8 * DAY);
    await markStaleCrashedJobs();
    expect((await rowById(job.id))!.status).toBe('stale');
    jest.setSystemTime(T0);

    await pruneOldJobs();

    expect(await rows()).toHaveLength(0);
  });

  it('drops a retrying job whose retry was lost more than 2 hours ago, but keeps a live one', async () => {
    const dead = await jobAged(3 * HOUR, 'retrying');
    const live = await jobAged(10 * 60_000, 'retrying');
    jest.setSystemTime(T0);

    await pruneOldJobs();

    expect((await rows()).map((r) => r.id)).toEqual([live]);
    expect(dead).not.toBe(live);
  });

  it('takes a custom window', async () => {
    const twoMinOld = await jobAged(2 * 60_000, 'completed');
    const fresh = await jobAged(10_000, 'completed');
    jest.setSystemTime(T0);

    await pruneOldJobs(60_000);

    expect((await rows()).map((r) => r.id)).toEqual([fresh]);
    expect(twoMinOld).not.toBe(fresh);
  });
});
