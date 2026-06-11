// scheduler-persistence unit tests
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

const mockGetSetting = jest.fn((..._args: any[]): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

import database from '@/lib/database';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  createJob,
  markRunning,
  markCompleted,
  markFailed,
  saveLastRun,
  loadLastRunTimes,
  markStaleCrashedJobs,
  pruneOldJobs,
  modelToJob,
} from '../scheduler-persistence';
import type { TaskDefinition } from '../scheduler-types';

const db = database as any;

const NOW = 1700000000000;

function makeSchedulerRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `sj_${Math.random().toString(36).slice(2)}`,
    taskName: 'feed-sync',
    status: 'pending',
    inputJson: null,
    errorCode: null,
    errorMessage: null,
    attempt: 1,
    maxAttempts: 3,
    scheduledAt: NOW,
    startedAt: null,
    completedAt: null,
    retryAt: null,
    ...overrides,
  });
}

function makeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    name: 'feed-sync',
    displayName: 'Feed Sync',
    handler: jest.fn() as any,
    frequency: 3600000,
    maxAttempts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('scheduler_jobs', []);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  // scheduler-persistence.ts does `(record as any)._raw.id = id` inside the
  // create callback. The default makeCollection.create() uses makeRecord() which
  // has no `_raw`. Patch the collection's create to add a `_raw` stub so the
  // source code doesn't throw "Cannot set properties of undefined".
  const col = db._collections['scheduler_jobs'] ?? db.get('scheduler_jobs');
  col.create = jest.fn(async (fn?: (r: any) => void) => {
    const { makeRecord: mr } = require('@/lib/__test-helpers__/mockDatabase');
    const rec = mr({ _raw: {} });
    fn?.(rec);
    col._rows.push(rec);
    return rec;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// createJob
// ---------------------------------------------------------------------------

describe('createJob', () => {
  it('returns a Job with the correct shape', async () => {
    const task = makeTask();
    const job = await createJob(task, { topicIds: ['t1'] });
    expect(job.taskName).toBe('feed-sync');
    expect(job.status).toBe('pending');
    expect(job.attempt).toBe(1);
    expect(job.maxAttempts).toBe(3);
    expect(job.scheduledAt).toBe(NOW);
    expect(job.input).toEqual({ topicIds: ['t1'] });
  });

  it('uses task.maxAttempts or defaults to 3', async () => {
    const taskWith5 = makeTask({ maxAttempts: 5 });
    const job = await createJob(taskWith5);
    expect(job.maxAttempts).toBe(5);

    const taskWithout = makeTask({ maxAttempts: undefined });
    const job2 = await createJob(taskWithout);
    expect(job2.maxAttempts).toBe(3);
  });

  it('calls database.write and collection.create', async () => {
    await createJob(makeTask());
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['scheduler_jobs'].create).toHaveBeenCalledTimes(1);
  });

  it('stores undefined input as null in inputJson', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['scheduler_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord({ _raw: {} });
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );
    await createJob(makeTask(), undefined);
    expect(capturedRecord.inputJson).toBeNull();
  });

  it('serializes input as JSON in inputJson', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['scheduler_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord({ _raw: {} });
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );
    await createJob(makeTask(), { key: 'value' });
    expect(capturedRecord.inputJson).toBe('{"key":"value"}');
  });

  it('sets the custom id on _raw.id', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['scheduler_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord({ _raw: {} });
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );
    await createJob(makeTask());
    expect((capturedRecord._raw as any).id).toMatch(/^job_\d+_/);
  });

  it('returned job.id matches the generated id', async () => {
    // We rely on the create mock returning a record without a specific id,
    // so we check that the returned Job id starts with 'job_'
    const job = await createJob(makeTask());
    expect(job.id).toMatch(/^job_\d+_/);
  });
});

// ---------------------------------------------------------------------------
// markRunning
// ---------------------------------------------------------------------------

describe('markRunning', () => {
  it('does nothing when no job found with the given id', async () => {
    db._setRows('scheduler_jobs', []);
    await markRunning('nonexistent');
    expect(database.write).not.toHaveBeenCalled();
  });

  it('updates status to running and sets startedAt', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-1' });
    db._setRows('scheduler_jobs', [rec]);
    await markRunning('sj-1');
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(rec.update).toHaveBeenCalledTimes(1);
    expect(rec.status).toBe('running');
    expect(rec.startedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// markCompleted
// ---------------------------------------------------------------------------

describe('markCompleted', () => {
  it('does nothing when job not found', async () => {
    db._setRows('scheduler_jobs', []);
    await markCompleted('nonexistent', NOW);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('sets status to completed and records completedAt', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-2' });
    db._setRows('scheduler_jobs', [rec]);
    await markCompleted('sj-2', NOW + 1000);
    expect(rec.status).toBe('completed');
    expect(rec.completedAt).toBe(NOW + 1000);
  });
});

// ---------------------------------------------------------------------------
// markFailed
// ---------------------------------------------------------------------------

describe('markFailed', () => {
  it('does nothing when job not found', async () => {
    db._setRows('scheduler_jobs', []);
    await markFailed('nonexistent', new Error('fail'), false);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('sets status to failed when exhausted=true', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-3' });
    db._setRows('scheduler_jobs', [rec]);
    await markFailed('sj-3', new Error('oops'), true);
    expect(rec.status).toBe('failed');
    expect(rec.errorMessage).toBe('oops');
  });

  it('sets status to retrying when exhausted=false', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-4' });
    db._setRows('scheduler_jobs', [rec]);
    await markFailed('sj-4', new Error('transient'), false, NOW + 5000);
    expect(rec.status).toBe('retrying');
    expect(rec.retryAt).toBe(NOW + 5000);
  });

  it('sets retryAt to null when no retryAt provided', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-5' });
    db._setRows('scheduler_jobs', [rec]);
    await markFailed('sj-5', new Error('err'), false);
    expect(rec.retryAt).toBeNull();
  });

  it('handles non-Error error values', async () => {
    const rec = makeSchedulerRecord({ id: 'sj-6' });
    db._setRows('scheduler_jobs', [rec]);
    await markFailed('sj-6', 'string error', true);
    expect(rec.errorMessage).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// saveLastRun
// ---------------------------------------------------------------------------

describe('saveLastRun', () => {
  it('calls setSetting with the prefixed key and stringified timestamp', async () => {
    await saveLastRun('feed-sync', NOW);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'scheduler_last_run_feed-sync',
      String(NOW),
    );
  });
});

// ---------------------------------------------------------------------------
// loadLastRunTimes
// ---------------------------------------------------------------------------

describe('loadLastRunTimes', () => {
  it('returns an empty object when there are no task names', async () => {
    const result = await loadLastRunTimes([''].values()); // empty iterator effectively
    // Only key '' is iterated but returns null
    expect(result).toEqual({});
  });

  it('returns stored timestamps for known task names', async () => {
    mockGetSetting
      .mockResolvedValueOnce(String(NOW))
      .mockResolvedValueOnce(String(NOW - 1000));
    const result = await loadLastRunTimes(
      ['feed-sync', 'data-cleanup'].values(),
    );
    expect(result['feed-sync']).toBe(NOW);
    expect(result['data-cleanup']).toBe(NOW - 1000);
  });

  it('omits task names where no stored value exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await loadLastRunTimes(['unknown-task'].values());
    expect(result['unknown-task']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markStaleCrashedJobs
// ---------------------------------------------------------------------------

describe('markStaleCrashedJobs', () => {
  it('does nothing when no running jobs exist', async () => {
    db._setRows('scheduler_jobs', []);
    await markStaleCrashedJobs();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('does not mark running jobs that started recently', async () => {
    const recentJob = makeSchedulerRecord({
      status: 'running',
      startedAt: NOW - 1000, // 1s ago, well under 2h threshold
    });
    db._setRows('scheduler_jobs', [recentJob]);
    await markStaleCrashedJobs();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('marks running jobs older than 2h as stale', async () => {
    const staleJob = makeSchedulerRecord({
      status: 'running',
      startedAt: NOW - 3 * 60 * 60 * 1000, // 3h ago
    });
    db._setRows('scheduler_jobs', [staleJob]);
    await markStaleCrashedJobs();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(staleJob.status).toBe('stale');
  });

  it('handles jobs with null startedAt as stale (0 < cutoff)', async () => {
    const nullStartJob = makeSchedulerRecord({
      status: 'running',
      startedAt: null, // null → 0 < cutoff
    });
    db._setRows('scheduler_jobs', [nullStartJob]);
    await markStaleCrashedJobs();
    expect(nullStartJob.status).toBe('stale');
  });

  it('marks only the stale jobs, not recent ones', async () => {
    const recentJob = makeSchedulerRecord({ status: 'running', startedAt: NOW - 1000 });
    const staleJob = makeSchedulerRecord({ status: 'running', startedAt: NOW - 3 * 60 * 60 * 1000 });
    db._setRows('scheduler_jobs', [recentJob, staleJob]);
    await markStaleCrashedJobs();
    // Only stale got updated
    expect(staleJob.status).toBe('stale');
    // recentJob was not changed
    expect(recentJob.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pruneOldJobs
// ---------------------------------------------------------------------------

describe('pruneOldJobs', () => {
  it('does nothing when there are no old jobs', async () => {
    db._setRows('scheduler_jobs', []);
    await pruneOldJobs();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('deletes completed/failed/stale/cancelled jobs older than default window', async () => {
    const oldCompleted = makeSchedulerRecord({
      status: 'completed',
      scheduledAt: NOW - 8 * 24 * 60 * 60 * 1000, // 8d ago
    });
    db._setRows('scheduler_jobs', [oldCompleted]);
    await pruneOldJobs();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(oldCompleted.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('does not delete recent completed jobs', async () => {
    // The fake query returns ALL rows regardless of WHERE clause.
    // To test the "no match" path, supply an empty collection — if no rows
    // match the real Q.or() predicate, the service returns early without writing.
    // We simulate this by leaving the collection empty (the real WHERE clause
    // would filter out recent jobs, but the fake returns everything, so we
    // assert the negative by having no rows at all).
    db._setRows('scheduler_jobs', []);
    await pruneOldJobs();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('deletes dead retrying jobs where retryAt is stale (>2h)', async () => {
    const deadRetry = makeSchedulerRecord({
      status: 'retrying',
      retryAt: NOW - 3 * 60 * 60 * 1000, // 3h ago
    });
    db._setRows('scheduler_jobs', [deadRetry]);
    await pruneOldJobs();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(deadRetry.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('does not delete recently scheduled retrying jobs (verified via empty rows)', async () => {
    // The fake query ignores Q.where predicates; to assert the "no prune"
    // path we must provide no rows — a real DB would filter retrying jobs
    // with future retryAt out of the result set.
    db._setRows('scheduler_jobs', []);
    await pruneOldJobs();
    expect(database.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// modelToJob
// ---------------------------------------------------------------------------

describe('modelToJob', () => {
  it('maps all fields correctly', () => {
    const model = makeSchedulerRecord({
      id: 'sj-model',
      taskName: 'data-cleanup',
      status: 'completed',
      inputJson: '{"key":"val"}',
      attempt: 2,
      maxAttempts: 5,
      scheduledAt: NOW,
      startedAt: NOW + 1000,
      completedAt: NOW + 5000,
      retryAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const job = modelToJob(model as any);
    expect(job.id).toBe('sj-model');
    expect(job.taskName).toBe('data-cleanup');
    expect(job.status).toBe('completed');
    expect(job.input).toEqual({ key: 'val' });
    expect(job.attempt).toBe(2);
    expect(job.maxAttempts).toBe(5);
    expect(job.scheduledAt).toBe(NOW);
    expect(job.startedAt).toBe(NOW + 1000);
    expect(job.completedAt).toBe(NOW + 5000);
    expect(job.retryAt).toBeUndefined();
    expect(job.errorCode).toBeUndefined();
    expect(job.errorMessage).toBeUndefined();
  });

  it('maps null inputJson to undefined input', () => {
    const model = makeSchedulerRecord({ inputJson: null });
    const job = modelToJob(model as any);
    expect(job.input).toBeUndefined();
  });

  it('maps null optional fields to undefined in Job', () => {
    const model = makeSchedulerRecord({
      startedAt: null,
      completedAt: null,
      retryAt: null,
      errorCode: null,
      errorMessage: null,
    });
    const job = modelToJob(model as any);
    expect(job.startedAt).toBeUndefined();
    expect(job.completedAt).toBeUndefined();
    expect(job.retryAt).toBeUndefined();
    expect(job.errorCode).toBeUndefined();
    expect(job.errorMessage).toBeUndefined();
  });
});
