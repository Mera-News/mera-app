// inference-job-service unit tests
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  enqueueJob,
  dequeueJob,
  recoverCrashedJobs,
  getQueueStats,
  getFailedJobs,
  pruneCompletedJobs,
  purgeFailedJobs,
  hasPendingJob,
  getActiveTopicGenFactIds,
} from '../inference-job-service';

const db = database as any;

function makeJob(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `job_${Math.random().toString(36).slice(2)}`,
    jobType: 'topic_gen',
    status: 'pending',
    priority: 10,
    payload: {},
    attempts: 0,
    maxAttempts: 3,
    errorMessage: null,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('inference_jobs', []);
});

// ---------------------------------------------------------------------------
// enqueueJob
// ---------------------------------------------------------------------------

describe('enqueueJob', () => {
  it('creates a new inference job and returns its id', async () => {
    const createdRecord = makeJob({ id: 'new-job-id' });
    db._collections['inference_jobs'].create.mockResolvedValueOnce(createdRecord);

    const id = await enqueueJob('topic_gen', { factId: 'f1' });
    expect(id).toBe('new-job-id');
    expect(database.write).toHaveBeenCalledTimes(1);
  });

  it('sets default priority for topic_gen to 10', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f1' });
    expect(capturedRecord.priority).toBe(10);
  });

  it('respects a custom priority when provided', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f1' }, { priority: 5 });
    expect(capturedRecord.priority).toBe(5);
  });

  it('defaults maxAttempts to 3', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f1' });
    expect(capturedRecord.maxAttempts).toBe(3);
  });

  it('respects a custom maxAttempts option', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f1' }, { maxAttempts: 5 });
    expect(capturedRecord.maxAttempts).toBe(5);
  });

  it('sets status to pending and attempts to 0', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f1' });
    expect(capturedRecord.status).toBe('pending');
    expect(capturedRecord.attempts).toBe(0);
  });

  it('persists the payload', async () => {
    const capturedRecord: Record<string, unknown> = {};
    db._collections['inference_jobs'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeJob();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await enqueueJob('topic_gen', { factId: 'f42', extra: true });
    expect((capturedRecord.payload as any).factId).toBe('f42');
  });
});

// ---------------------------------------------------------------------------
// dequeueJob
// ---------------------------------------------------------------------------

describe('dequeueJob', () => {
  it('returns null when no pending jobs exist', async () => {
    db._setRows('inference_jobs', []);
    const result = await dequeueJob();
    expect(result).toBeNull();
  });

  it('returns the first pending job from the query result', async () => {
    const job = makeJob({ status: 'pending' });
    db._setRows('inference_jobs', [job]);
    const result = await dequeueJob();
    expect(result).toBe(job);
  });

  it('calls query on the inference_jobs collection', async () => {
    db._setRows('inference_jobs', []);
    await dequeueJob();
    expect(db._collections['inference_jobs'].query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// recoverCrashedJobs
// ---------------------------------------------------------------------------

describe('recoverCrashedJobs', () => {
  it('returns 0 and does not write when there are no running jobs', async () => {
    db._setRows('inference_jobs', []);
    const count = await recoverCrashedJobs();
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns the count of recovered jobs', async () => {
    const job1 = makeJob({ status: 'running', attempts: 0, maxAttempts: 3 });
    const job2 = makeJob({ status: 'running', attempts: 1, maxAttempts: 3 });
    db._setRows('inference_jobs', [job1, job2]);
    const count = await recoverCrashedJobs();
    expect(count).toBe(2);
  });

  it('resets jobs to pending when under max attempts', async () => {
    const job = makeJob({ status: 'running', attempts: 1, maxAttempts: 3 });
    db._setRows('inference_jobs', [job]);
    await recoverCrashedJobs();
    // prepareUpdate is called; it mutates the record inline via mock
    expect(job.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('pending');
  });

  it('marks jobs as failed when max attempts reached', async () => {
    const job = makeJob({ status: 'running', attempts: 3, maxAttempts: 3 });
    db._setRows('inference_jobs', [job]);
    await recoverCrashedJobs();
    expect(job.status).toBe('failed');
    expect(job.errorMessage).toBe('Crashed during execution (max attempts reached)');
  });

  it('calls database.batch with the prepared updates', async () => {
    const job = makeJob({ status: 'running', attempts: 0, maxAttempts: 3 });
    db._setRows('inference_jobs', [job]);
    await recoverCrashedJobs();
    expect(database.batch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getQueueStats
// ---------------------------------------------------------------------------

describe('getQueueStats', () => {
  it('returns zero counts when the collection is empty', async () => {
    db._setRows('inference_jobs', []);
    const stats = await getQueueStats();
    expect(stats).toEqual({ pending: 0, running: 0, failed: 0 });
  });

  it('returns correct counts based on fetchCount results', async () => {
    // The fake query always returns ALL rows for fetchCount; getQueueStats
    // calls query 3 times in parallel. Use mockReturnValueOnce (not
    // mockImplementation) so the default implementation is not replaced
    // permanently (clearAllMocks only clears call counts, not implementations).
    const col = db._collections['inference_jobs'] ?? db.get('inference_jobs');
    col.query
      .mockReturnValueOnce({ fetch: jest.fn(async () => []), fetchCount: jest.fn(async () => 5) })
      .mockReturnValueOnce({ fetch: jest.fn(async () => []), fetchCount: jest.fn(async () => 2) })
      .mockReturnValueOnce({ fetch: jest.fn(async () => []), fetchCount: jest.fn(async () => 1) });

    const stats = await getQueueStats();
    expect(stats.pending).toBe(5);
    expect(stats.running).toBe(2);
    expect(stats.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getFailedJobs
// ---------------------------------------------------------------------------

describe('getFailedJobs', () => {
  it('returns an empty array when no failed jobs', async () => {
    db._setRows('inference_jobs', []);
    const result = await getFailedJobs();
    expect(result).toEqual([]);
  });

  it('maps failed jobs to the expected shape', async () => {
    const job = makeJob({
      id: 'job-1',
      jobType: 'topic_gen',
      status: 'failed',
      errorMessage: 'Some error',
      attempts: 2,
      payload: { factId: 'f1' },
    });
    db._setRows('inference_jobs', [job]);
    const result = await getFailedJobs();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'job-1',
      jobType: 'topic_gen',
      errorMessage: 'Some error',
      attempts: 2,
      payload: { factId: 'f1' },
    });
  });

  it('maps null errorMessage correctly', async () => {
    const job = makeJob({
      id: 'job-2',
      status: 'failed',
      errorMessage: null,
      payload: {},
    });
    db._setRows('inference_jobs', [job]);
    const result = await getFailedJobs();
    expect(result[0].errorMessage).toBeNull();
  });

  it('maps undefined errorMessage to null', async () => {
    const job = makeJob({
      id: 'job-3',
      status: 'failed',
      errorMessage: undefined,
      payload: {},
    });
    db._setRows('inference_jobs', [job]);
    const result = await getFailedJobs();
    expect(result[0].errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pruneCompletedJobs
// ---------------------------------------------------------------------------

describe('pruneCompletedJobs', () => {
  it('returns 0 and does not write when there are no old jobs', async () => {
    db._setRows('inference_jobs', []);
    const count = await pruneCompletedJobs(new Date());
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns the number of pruned jobs', async () => {
    const job1 = makeJob({ status: 'done' });
    const job2 = makeJob({ status: 'failed' });
    db._setRows('inference_jobs', [job1, job2]);
    const count = await pruneCompletedJobs(new Date());
    expect(count).toBe(2);
  });

  it('calls prepareDestroyPermanently on each pruned job', async () => {
    const job = makeJob({ status: 'done' });
    db._setRows('inference_jobs', [job]);
    await pruneCompletedJobs(new Date());
    expect(job.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('calls database.batch with destroy ops', async () => {
    const job = makeJob({ status: 'done' });
    db._setRows('inference_jobs', [job]);
    await pruneCompletedJobs(new Date());
    expect(database.batch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// purgeFailedJobs
// ---------------------------------------------------------------------------

describe('purgeFailedJobs', () => {
  it('returns 0 and does not write when there are no failed jobs', async () => {
    db._setRows('inference_jobs', []);
    const count = await purgeFailedJobs();
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns the number of purged jobs', async () => {
    const job1 = makeJob({ status: 'failed' });
    const job2 = makeJob({ status: 'failed' });
    db._setRows('inference_jobs', [job1, job2]);
    const count = await purgeFailedJobs();
    expect(count).toBe(2);
  });

  it('calls prepareDestroyPermanently on each failed job', async () => {
    const job = makeJob({ status: 'failed' });
    db._setRows('inference_jobs', [job]);
    await purgeFailedJobs();
    expect(job.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// hasPendingJob
// ---------------------------------------------------------------------------

describe('hasPendingJob', () => {
  it('returns false when no candidates match the type/status', async () => {
    db._setRows('inference_jobs', []);
    const result = await hasPendingJob('topic_gen', 'factId', 'f1');
    expect(result).toBe(false);
  });

  it('returns true when a candidate has a matching payload key/value', async () => {
    const job = makeJob({
      status: 'pending',
      jobType: 'topic_gen',
      payload: { factId: 'f1' },
    });
    db._setRows('inference_jobs', [job]);
    const result = await hasPendingJob('topic_gen', 'factId', 'f1');
    expect(result).toBe(true);
  });

  it('returns false when payload key matches but value differs', async () => {
    const job = makeJob({
      status: 'pending',
      jobType: 'topic_gen',
      payload: { factId: 'f2' },
    });
    db._setRows('inference_jobs', [job]);
    const result = await hasPendingJob('topic_gen', 'factId', 'f1');
    expect(result).toBe(false);
  });

  it('returns true for running jobs as well', async () => {
    const job = makeJob({
      status: 'running',
      jobType: 'topic_gen',
      payload: { factId: 'f1' },
    });
    db._setRows('inference_jobs', [job]);
    const result = await hasPendingJob('topic_gen', 'factId', 'f1');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getActiveTopicGenFactIds
// ---------------------------------------------------------------------------

describe('getActiveTopicGenFactIds', () => {
  it('returns an empty Set when no active topic_gen jobs', async () => {
    db._setRows('inference_jobs', []);
    const result = await getActiveTopicGenFactIds();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('returns a Set containing all factIds from active topic_gen jobs', async () => {
    const job1 = makeJob({ status: 'pending', payload: { factId: 'f1' } });
    const job2 = makeJob({ status: 'running', payload: { factId: 'f2' } });
    db._setRows('inference_jobs', [job1, job2]);
    const result = await getActiveTopicGenFactIds();
    expect(result.has('f1')).toBe(true);
    expect(result.has('f2')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('ignores jobs with non-string factId', async () => {
    const job = makeJob({ status: 'pending', payload: { factId: 123 } });
    db._setRows('inference_jobs', [job]);
    const result = await getActiveTopicGenFactIds();
    expect(result.size).toBe(0);
  });

  it('ignores jobs with missing factId in payload', async () => {
    const job = makeJob({ status: 'pending', payload: { otherId: 'x' } });
    db._setRows('inference_jobs', [job]);
    const result = await getActiveTopicGenFactIds();
    expect(result.size).toBe(0);
  });

  it('deduplicates factIds that appear in multiple jobs', async () => {
    const job1 = makeJob({ status: 'pending', payload: { factId: 'f1' } });
    const job2 = makeJob({ status: 'running', payload: { factId: 'f1' } });
    db._setRows('inference_jobs', [job1, job2]);
    const result = await getActiveTopicGenFactIds();
    expect(result.size).toBe(1);
    expect(result.has('f1')).toBe(true);
  });
});
