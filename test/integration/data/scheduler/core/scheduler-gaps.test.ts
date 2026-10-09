// Scheduler-core arms the other seam files do not reach: each test drives the real AppScheduler,
// runner, persistence layer and in-memory DB. Edges only: the clock, Sentry, RN's
// InteractionManager, and llama.rn for the one module-load fault.
import '@/test/helpers';

import * as Sentry from '@sentry/react-native';
import { InteractionManager } from 'react-native';

import database from '@/lib/database';
import type SchedulerJobModel from '@/lib/database/models/SchedulerJob';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import {
  createJob,
  markStaleCrashedJobs,
  modelToJob,
  pruneOldJobs,
  saveLastRun,
} from '@/lib/scheduler/scheduler-persistence';
import { yieldToInteractions, yieldToInteractionsWithTimeout } from '@/lib/scheduler/idle';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  HttpResponse,
  http,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';

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

const run = (name: string) =>
  advanceUntilDone(AppScheduler.trigger(name, undefined, { bypassDebounce: true }));

describe('AppScheduler tick', () => {
  it('fires a due timer task that has run before, and logs how long ago (lastRun set)', async () => {
    const task = addTask({ frequency: 10_000 });
    await saveLastRun(task.name, T0 - HOUR);
    const debug = jest.spyOn(logger, 'debug');

    await advanceUntilDone(AppScheduler.init());
    await settle(0);

    expect(task.runs).toHaveLength(1);
    expect(debug).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`tick-firing task=${task.name} lastRun=3600s ago`)),
    );
  });
});

describe('authenticated pre-flight when the credential lookup itself throws', () => {
  // getJwtToken swallows a transport failure into null, but it reports it through
  // logger.captureException first. If Sentry throws from there (an SDK fault), the rejection
  // escapes getJwtToken and the condition must read it as "not authenticated", not crash the tick.
  it('skips the task quietly and keeps ticking', async () => {
    jest.useRealTimers();
    await signInFixtureAccount();
    useFakeClock(T0);
    useUserStore.setState({ userPersona: {} as never });
    server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sentry exploded');
    });
    const task = addTask({ frequency: 10_000, conditions: [{ type: 'authenticated' }] });

    await advanceUntilDone(AppScheduler.init());
    await settle(1_000);

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(task.runs).toHaveLength(0);
  });
});

describe('scheduler-runner', () => {
  it('still runs the job when Sentry cannot start a span', async () => {
    (Sentry.startInactiveSpan as jest.Mock).mockImplementationOnce(() => {
      throw new Error('no tracing');
    });
    const task = addTask();

    await run(task.name);

    expect(task.runs).toHaveLength(1);
    expect((await jobRows(task.name))[0].status).toBe('completed');
  });

  it('holds the retry delay at 120s once the ladder is past its third rung', async () => {
    const task = addTask({ failWith: new Error('down'), maxAttempts: 5 });

    await run(task.name);
    await settle(31_000);
    await settle(61_000);
    await settle(121_000);
    expect(task.runs).toHaveLength(4);

    const rows = await jobRows(task.name);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
      [3, 'retrying'],
      [4, 'retrying'],
    ]);
    expect(rows[3].retryAt).toBe(rows[3].scheduledAt + 120_000);
  });

  it('reports a thrown non-Error (a bare string) as an exhausted failure with that text', async () => {
    const task = addTask({ maxAttempts: 1, failWith: 'plain string failure' });

    await run(task.name);

    expect(Sentry.captureException).toHaveBeenCalledWith('plain string failure');
    const [row] = await jobRows(task.name);
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'plain string failure' });
  });
});

describe('scheduler-persistence', () => {
  const def = { name: 'gap-task', displayName: 'Gap', frequency: 0, handler: async () => {} };

  it('maps a job created without input back to a Job with no input', async () => {
    const job = await createJob(def);
    const row = (await database.get<SchedulerJobModel>('scheduler_jobs').query().fetch())[0];

    expect(modelToJob(row).input).toBeUndefined();
    expect(job.input).toBeUndefined();
  });

  it('treats a running row with no started_at as stale (bare row: only a pre-markRunning crash leaves one)', async () => {
    // markRunning always stamps startedAt, so the null shape is a legacy/hand-edited row.
    const bare = await database.write(() =>
      database.get<SchedulerJobModel>('scheduler_jobs').create((r) => {
        r.taskName = 'gap-task';
        r.status = 'running';
        r.inputJson = null;
        r.errorCode = null;
        r.errorMessage = null;
        r.attempt = 1;
        r.maxAttempts = 3;
        r.scheduledAt = T0;
        r.startedAt = null;
        r.completedAt = null;
        r.retryAt = null;
      }),
    );

    await markStaleCrashedJobs();

    expect((await database.get<SchedulerJobModel>('scheduler_jobs').find(bare.id)).status).toBe('stale');
  });

  it('prunes nothing, and leaves fresh rows alone, when no row qualifies', async () => {
    const job = await createJob(def);

    await expect(pruneOldJobs()).resolves.toBeUndefined();

    expect((await database.get<SchedulerJobModel>('scheduler_jobs').find(job.id)).status).toBe('pending');
  });
});

describe('idle helpers without InteractionManager.runAfterInteractions', () => {
  const track = (p: Promise<unknown>) => {
    const s = { settled: false };
    void p.then(() => (s.settled = true));
    return s;
  };

  it('falls back to the next macrotask when the platform lacks runAfterInteractions', async () => {
    const manager = InteractionManager as { runAfterInteractions?: unknown };
    const original = manager.runAfterInteractions;
    manager.runAfterInteractions = undefined;
    try {
      const plain = track(yieldToInteractions());
      const bounded = track(yieldToInteractionsWithTimeout(60_000));
      await Promise.resolve();
      expect(plain.settled).toBe(false);
      await settle(0);

      expect(plain.settled).toBe(true);
      expect(bounded.settled).toBe(true);
    } finally {
      manager.runAfterInteractions = original;
    }
  });
});

describe('backgroundWorkIsIdle when the inference queue cannot load', () => {
  // The queue is lazy-required, and its import chain opens the SQLite adapter. A wake where the
  // native adapter fails to come up must read as "idle", never wedge a maintenance task.
  // LAST in the file: resetModules drops every cached module, so nothing after it may rely on the
  // statically imported instances.
  const ADAPTER = '@nozbe/watermelondb/adapters/sqlite';

  it('reports idle', () => {
    jest.resetModules();
    jest.doMock(ADAPTER, () => {
      throw new Error('native SQLite adapter unavailable');
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { backgroundWorkIsIdle } = require('@/lib/scheduler/background-idle');

      expect(backgroundWorkIsIdle()).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      jest.doMock(ADAPTER, () => require('@/test/helpers/memory-sqlite-adapter'));
    }
  });
});
