// inference-job-service at its seam: the persistent job TABLE's own rules, over the in-memory DB.
// Replaces lib/database/services/__tests__/inference-job-service.test.ts, whose mock ignored every
// Q.where, so "dequeue returns the first row" and the NOT IN clause could only be pinned by
// inspecting query arguments. Here the head row, the deferral exclusion and the status filters run
// against real rows.
//
// The status writers (markRunning / markDone / markFailed / markUnrunnable / markDeferred) are
// @writer methods on the InferenceJob MODEL, not InferenceQueue code, so the attempt rules are
// covered here through the rows dequeueJob hands back. The queue loop that calls them
// (lib/inference/InferenceQueue.ts) is chat-owned and not covered. The combo-job rules live in
// test/integration/data/services/topics.
//
// 'failed' is only ever written by recoverCrashedJobs (markFailed destroys at max attempts), so
// failed rows are seeded through it.
//
// Not carried over: "calls query once", "calls database.batch" and "calls prepareDestroyPermanently
// on each": each only counted mock calls; the rows that are left (or gone) are asserted instead.
import {
  countActiveJobsExcluding,
  dequeueJob,
  enqueueJob,
  getActiveTopicGenFactIds,
  getFailedJobs,
  getQueueStats,
  hasPendingJob,
  pruneCompletedJobs,
  purgeFailedJobs,
  recoverCrashedJobs,
} from '@/lib/database/services/inference-job-service';
import type { InferenceJobType } from '@/lib/database/models/InferenceJob';
import { corruptColumn, countRows, countWrites, DAY, freezeClock, restoreFaults, rowById, T0 } from './support';

beforeEach(() => freezeClock());
afterEach(restoreFaults);

const tick = (ms = 1000) => jest.advanceTimersByTime(ms);
const job = (id: string) => rowById('inference_jobs', id);

/** Enqueue then take the row to `running`, as the queue does. */
async function enqueueRunning(type: InferenceJobType, payload: Record<string, unknown> = {}, opts?: { maxAttempts?: number }) {
  const id = await enqueueJob(type, payload, opts);
  await (await job(id)).markRunning();
  return id;
}

/** A job the sweep turned 'failed': running at max attempts, then recovered. */
async function enqueueFailed(payload: Record<string, unknown> = {}) {
  const id = await enqueueRunning('topic_gen', payload, { maxAttempts: 1 });
  await recoverCrashedJobs(); // also re-pends every other running row: seed failed rows BEFORE running ones
  return id;
}

describe('enqueueJob', () => {
  it.each<[InferenceJobType, number]>([
    ['topic_gen', 10],
    ['topic_combo', 15],
    ['persona_summary', 20],
    ['story_headline', 20],
    ['tracked_story_migrate', 20],
  ])('gives %s priority %i, pending, 0 attempts and 3 max attempts', async (type, priority) => {
    const id = await enqueueJob(type, { factId: 'f1' });

    expect(await job(id)).toMatchObject({
      jobType: type,
      status: 'pending',
      priority,
      attempts: 0,
      maxAttempts: 3,
      payload: { factId: 'f1' },
    });
  });

  it('takes a custom priority and max attempts, and stores the payload whole', async () => {
    const id = await enqueueJob('topic_gen', { factId: 'f42', extra: true, nested: { a: [1] } }, { priority: 5, maxAttempts: 5 });

    expect(await job(id)).toMatchObject({ priority: 5, maxAttempts: 5, payload: { factId: 'f42', extra: true, nested: { a: [1] } } });
  });

  it('honours a custom priority of 0', async () => {
    const id = await enqueueJob('persona_summary', {}, { priority: 0 });
    expect((await job(id)).priority).toBe(0);
  });
});

describe('dequeueJob', () => {
  it('is null when there is no pending job, and ignores running, done and failed rows', async () => {
    expect(await dequeueJob()).toBeNull();

    await enqueueFailed(); // first: the sweep re-pends any row that is running when it runs
    await enqueueRunning('topic_gen');
    const done = await enqueueJob('topic_gen', {});
    await (await job(done)).markDone({ ok: true });

    expect(await dequeueJob()).toBeNull();
  });

  it('takes the lowest priority number first, whatever the age', async () => {
    await enqueueJob('persona_summary', {});
    tick();
    const gen = await enqueueJob('topic_gen', {});
    tick();
    await enqueueJob('topic_combo', {});

    expect((await dequeueJob())?.id).toBe(gen);
  });

  it('takes the oldest row among equal priorities', async () => {
    const first = await enqueueJob('story_headline', { n: 1 });
    tick();
    await enqueueJob('story_headline', { n: 2 });
    tick();
    await enqueueJob('persona_summary', { n: 3 });

    const head = await dequeueJob();
    expect(head?.id).toBe(first);
    expect(head?.payload).toEqual({ n: 1 });
  });

  it('does not take the row: it stays pending until the caller marks it', async () => {
    const id = await enqueueJob('topic_gen', {});
    expect((await dequeueJob())?.id).toBe(id);
    expect((await dequeueJob())?.id).toBe(id);
    expect((await job(id)).status).toBe('pending');
  });

  describe('excludeTypes (the in-memory deferral gate)', () => {
    it('returns the next row of ANOTHER type when the head type is excluded, never one of the excluded type', async () => {
      await enqueueJob('topic_combo', { n: 1 }); // head: priority 15, oldest
      tick();
      await enqueueJob('topic_combo', { n: 2 });
      tick();
      const nicety = await enqueueJob('persona_summary', {}); // priority 20

      const next = await dequeueJob({ excludeTypes: ['topic_combo'] });

      expect(next?.id).toBe(nicety);
      expect(next?.jobType).toBe('persona_summary');
    });

    it('does not starve lower-priority work behind an excluded head', async () => {
      await enqueueJob('topic_gen', {});
      tick();
      const low = await enqueueJob('story_headline', {});

      // The head is topic_gen; excluding it must surface the story_headline row, not an empty queue.
      expect((await dequeueJob({ excludeTypes: ['topic_gen'] }))?.id).toBe(low);
    });

    it('is null when every pending row is of an excluded type', async () => {
      await enqueueJob('topic_combo', {});
      await enqueueJob('topic_gen', {});
      expect(await dequeueJob({ excludeTypes: ['topic_combo', 'topic_gen'] })).toBeNull();
    });

    it('filters nothing for an empty list or no option', async () => {
      const head = await enqueueJob('topic_gen', {});
      await enqueueJob('persona_summary', {});

      expect((await dequeueJob({ excludeTypes: [] }))?.id).toBe(head);
      expect((await dequeueJob())?.id).toBe(head);
    });
  });
});

describe('hasPendingJob', () => {
  it('matches on a payload key and value for that type', async () => {
    await enqueueJob('topic_gen', { factId: 'f1' });

    expect(await hasPendingJob('topic_gen', 'factId', 'f1')).toBe(true);
    expect(await hasPendingJob('topic_gen', 'factId', 'f2')).toBe(false);
    expect(await hasPendingJob('topic_gen', 'otherKey', 'f1')).toBe(false);
    expect(await hasPendingJob('topic_combo', 'factId', 'f1')).toBe(false);
  });

  it('counts a running job and neither a done nor a failed one', async () => {
    await enqueueFailed({ factId: 'failed' });
    await enqueueRunning('topic_gen', { factId: 'run' });
    const done = await enqueueJob('topic_gen', { factId: 'done' });
    await (await job(done)).markDone({});

    expect(await hasPendingJob('topic_gen', 'factId', 'run')).toBe(true);
    expect(await hasPendingJob('topic_gen', 'factId', 'done')).toBe(false);
    expect(await hasPendingJob('topic_gen', 'factId', 'failed')).toBe(false);
  });

  it('does not match a value of another type (a number is not its string)', async () => {
    await enqueueJob('topic_gen', { factId: 7 });
    expect(await hasPendingJob('topic_gen', 'factId', '7')).toBe(false);
  });
});

// 'pending' is one word in two vocabularies: this one is the job's, and it must stay in the match
// or a fact waiting behind the queue is stamped 'error' and then flipped back.
describe('getActiveTopicGenFactIds', () => {
  it('is an empty set when there are no topic_gen jobs', async () => {
    const result = await getActiveTopicGenFactIds();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('covers a fact whose job is only pending', async () => {
    await enqueueJob('topic_gen', { factId: 'queued' });
    expect([...(await getActiveTopicGenFactIds())]).toEqual(['queued']);
  });

  it('covers a fact whose job is running', async () => {
    await enqueueRunning('topic_gen', { factId: 'running' });
    expect([...(await getActiveTopicGenFactIds())]).toEqual(['running']);
  });

  it('never covers done or failed jobs, or other job types', async () => {
    const done = await enqueueJob('topic_gen', { factId: 'done' });
    await (await job(done)).markDone({});
    await enqueueFailed({ factId: 'failed' });
    await enqueueJob('topic_combo', { factId: 'combo' });
    await enqueueJob('persona_summary', { factId: 'summary' });
    await enqueueJob('topic_gen', { factId: 'live' });

    expect([...(await getActiveTopicGenFactIds())]).toEqual(['live']);
  });

  it('ignores a non-string or missing factId and dedupes a fact with two live jobs', async () => {
    await enqueueJob('topic_gen', { factId: 123 });
    await enqueueJob('topic_gen', { otherId: 'x' });
    await enqueueJob('topic_gen', { factId: 'f1' });
    await enqueueRunning('topic_gen', { factId: 'f1' });

    const result = await getActiveTopicGenFactIds();
    expect(result.size).toBe(1);
    expect(result.has('f1')).toBe(true);
  });
});

describe('countActiveJobsExcluding', () => {
  it('counts pending and running rows of every OTHER type', async () => {
    await enqueueFailed();
    await enqueueJob('topic_gen', {});
    await enqueueRunning('topic_gen');
    await enqueueJob('topic_combo', {});
    const done = await enqueueJob('story_headline', {});
    await (await job(done)).markDone({});

    expect(await countActiveJobsExcluding(['topic_combo'])).toBe(2);
  });

  it('counts every active row when nothing is excluded, and zero when everything is', async () => {
    await enqueueJob('topic_gen', {});
    await enqueueJob('topic_combo', {});

    expect(await countActiveJobsExcluding([])).toBe(2);
    expect(await countActiveJobsExcluding(['topic_gen', 'topic_combo'])).toBe(0);
  });
});

describe('recoverCrashedJobs', () => {
  it('returns 0 and writes nothing when no job is running', async () => {
    await enqueueJob('topic_gen', {});
    const writes = countWrites();

    expect(await recoverCrashedJobs()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('re-pends a running row with attempts left, however long ago it started', async () => {
    const id = await enqueueRunning('topic_gen', { factId: 'f1' });
    tick(30 * DAY); // a crash long ago

    expect(await recoverCrashedJobs()).toBe(1);

    expect(await job(id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await dequeueJob())?.id).toBe(id);
  });

  it('fails a running row that has used its attempts, with the crash message', async () => {
    const id = await enqueueRunning('topic_gen', {}, { maxAttempts: 1 });

    expect(await recoverCrashedJobs()).toBe(1);

    expect(await job(id)).toMatchObject({ status: 'failed', errorMessage: 'Crashed during execution (max attempts reached)' });
    expect(await dequeueJob()).toBeNull();
  });

  it('counts both outcomes and leaves pending, done and failed rows alone', async () => {
    const retry = await enqueueRunning('topic_gen');
    const dead = await enqueueRunning('topic_gen', {}, { maxAttempts: 1 });
    const pending = await enqueueJob('topic_gen', {});
    const done = await enqueueJob('topic_gen', {});
    await (await job(done)).markDone({});

    expect(await recoverCrashedJobs()).toBe(2);

    expect((await job(retry)).status).toBe('pending');
    expect((await job(dead)).status).toBe('failed');
    expect((await job(pending)).attempts).toBe(0);
    expect((await job(done)).status).toBe('done');
    expect(await recoverCrashedJobs()).toBe(0);
  });
});

describe('getQueueStats', () => {
  it('is all zero for an empty table', async () => {
    expect(await getQueueStats()).toEqual({ pending: 0, running: 0, failed: 0 });
  });

  it('counts each status, and not done rows', async () => {
    await enqueueFailed();
    await enqueueJob('topic_gen', {});
    await enqueueJob('topic_combo', {});
    await enqueueJob('persona_summary', {});
    await enqueueRunning('topic_gen');
    const done = await enqueueJob('topic_gen', {});
    await (await job(done)).markDone({});

    expect(await getQueueStats()).toEqual({ pending: 3, running: 1, failed: 1 });
  });
});

describe('getFailedJobs', () => {
  it('is empty when nothing failed', async () => {
    await enqueueJob('topic_gen', {});
    expect(await getFailedJobs()).toEqual([]);
  });

  it('maps a failed row to the diagnostic shape and skips the rest', async () => {
    await enqueueJob('topic_gen', {});
    const id = await enqueueFailed({ factId: 'f1' });

    expect(await getFailedJobs()).toEqual([
      { id, jobType: 'topic_gen', errorMessage: 'Crashed during execution (max attempts reached)', attempts: 1, payload: { factId: 'f1' } },
    ]);
  });
});

describe('getFailedJobs, a failed row with no message', () => {
  // recoverCrashedJobs always writes one, so this stands in for a row an older build left.
  it('reads the missing message as null', async () => {
    const id = await enqueueFailed();
    await corruptColumn('inference_jobs', id, 'errorMessage', null);

    expect((await getFailedJobs())[0].errorMessage).toBeNull();
  });
});

describe('pruneCompletedJobs', () => {
  it('removes done and failed rows older than the cutoff, and keeps recent ones', async () => {
    const oldDone = await enqueueJob('topic_gen', {});
    await (await job(oldDone)).markDone({});
    const oldFailed = await enqueueFailed();
    tick(10 * DAY);
    const recentDone = await enqueueJob('topic_gen', {});
    await (await job(recentDone)).markDone({});

    const removed = await pruneCompletedJobs(new Date(T0 + 5 * DAY));

    expect(removed).toBe(2);
    expect(await job(oldDone)).toBeNull();
    expect(await job(oldFailed)).toBeNull();
    expect(await job(recentDone)).not.toBeNull();
  });

  it('never touches pending or running rows, however old', async () => {
    const pending = await enqueueJob('topic_gen', {});
    const running = await enqueueRunning('topic_combo');
    tick(90 * DAY);

    expect(await pruneCompletedJobs(new Date(T0 + 80 * DAY))).toBe(0);
    expect(await job(pending)).not.toBeNull();
    expect(await job(running)).not.toBeNull();
  });

  it('keys on the last update, not the creation: a row finished recently survives', async () => {
    const id = await enqueueJob('topic_gen', {});
    tick(20 * DAY);
    await (await job(id)).markDone({}); // created 20 days ago, finished now

    expect(await pruneCompletedJobs(new Date(T0 + 10 * DAY))).toBe(0);
    expect(await job(id)).not.toBeNull();
  });

  it('returns 0 and writes nothing when there is nothing old', async () => {
    const writes = countWrites();
    expect(await pruneCompletedJobs(new Date(T0))).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('purgeFailedJobs', () => {
  it('deletes every failed row at once, whatever its age, and keeps the rest', async () => {
    const failedA = await enqueueFailed();
    const failedB = await enqueueFailed();
    const pending = await enqueueJob('topic_gen', {});
    const done = await enqueueJob('topic_gen', {});
    await (await job(done)).markDone({});

    expect(await purgeFailedJobs()).toBe(2);

    expect(await job(failedA)).toBeNull();
    expect(await job(failedB)).toBeNull();
    expect(await job(pending)).not.toBeNull();
    expect(await job(done)).not.toBeNull();
    expect(await countRows('inference_jobs')).toBe(2);
  });

  it('returns 0 and writes nothing when no job failed', async () => {
    const writes = countWrites();
    expect(await purgeFailedJobs()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

// The status writers are model methods; the queue calls them on the row dequeueJob returns.
describe('status writers on a dequeued row', () => {
  it('markRunning takes an attempt', async () => {
    const id = await enqueueJob('topic_gen', {});
    await (await dequeueJob())!.markRunning();
    expect(await job(id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('markDone stores the result (an unfinished row reads an empty one)', async () => {
    const id = await enqueueRunning('topic_gen');
    expect((await job(id)).result).toEqual({});
    await (await job(id)).markDone({ topics: 3 });
    expect(await job(id)).toMatchObject({ status: 'done', result: { topics: 3 } });
  });

  it('markFailed re-pends with the error while attempts remain, then destroys the row at the cap', async () => {
    const id = await enqueueJob('topic_gen', {}, { maxAttempts: 2 });

    await (await job(id)).markRunning();
    await (await job(id)).markFailed('boom 1');
    expect(await job(id)).toMatchObject({ status: 'pending', attempts: 1, errorMessage: 'boom 1' });

    await (await job(id)).markRunning();
    await (await job(id)).markFailed('boom 2');
    expect(await job(id)).toBeNull();
  });

  // An OTA rollback leaves a job type this bundle has no handler for. The old path never moved
  // `attempts`, so the job re-pended on every loop forever.
  describe('markUnrunnable (a type with no handler)', () => {
    it('counts an attempt, re-pends with the message and keeps the row in the queue', async () => {
      const id = await enqueueJob('topic_gen', {});

      await (await dequeueJob())!.markUnrunnable('Unknown job type: topic_gen');

      expect(await job(id)).toMatchObject({ status: 'pending', attempts: 1, errorMessage: 'Unknown job type: topic_gen' });
      expect((await dequeueJob())?.id).toBe(id);
    });

    it('is destroyed once the loop has spent max attempts, so the queue cannot spin forever', async () => {
      const id = await enqueueJob('topic_gen', {}, { maxAttempts: 3 });
      const attemptsSeen: number[] = [];

      for (let i = 0; i < 10; i++) {
        const head = await dequeueJob();
        if (!head) break;
        await head.markUnrunnable('no handler');
        attemptsSeen.push((await job(id))?.attempts ?? -1);
      }

      expect(attemptsSeen).toEqual([1, 2, -1]);
      expect(await job(id)).toBeNull();
      expect(await dequeueJob()).toBeNull();
    });
  });

  // A deferral is not a failure: offline, no credential, 503, 429.
  describe('markDeferred', () => {
    it('re-pends and gives back the attempt markRunning took', async () => {
      const id = await enqueueJob('topic_combo', {});
      const row = (await dequeueJob())!;
      await row.markRunning();
      expect((await job(id)).attempts).toBe(1);

      await row.markDeferred('offline');

      expect(await job(id)).toMatchObject({ status: 'pending', attempts: 0, errorMessage: 'offline' });
    });

    it('cannot burn attempts: any number of run-then-defer rounds leaves the job runnable', async () => {
      const id = await enqueueJob('topic_combo', {}, { maxAttempts: 3 });
      for (let i = 0; i < 6; i++) {
        const row = (await dequeueJob())!;
        await row.markRunning();
        await row.markDeferred('503');
      }
      expect(await job(id)).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('never takes attempts below zero', async () => {
      const id = await enqueueJob('topic_combo', {});
      await (await job(id)).markDeferred('offline');
      expect((await job(id)).attempts).toBe(0);
    });
  });
});
