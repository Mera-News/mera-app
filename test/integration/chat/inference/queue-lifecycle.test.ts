// The inference queue's lifecycle over real `inference_jobs` rows: start (crash recovery, prune, the
// orphan sweeps), stop, pause/resume, notify, onDrain, and the dequeue read. Handlers are the
// queue's own test seam where a test needs a job to do something specific; the rest is real.
//
// Replaces the lifecycle half of lib/inference/__tests__/InferenceQueue.test.ts:
//   getState; start (running, idempotent, recoverCrashedJobs, pruneCompletedJobs, orphaned facts);
//   stop (idempotent, running to stopped, awaits the loop); pause/resume (4 transitions + wake);
//   notify (2); onDrain (3); pause waits for the running job; the paused loop; the state check after
//   dequeue; purge of failed jobs (2); drain callback that throws; "Failed job" start log; orphan
//   sweep error log; stop removes the AppState subscription.
import { AppState } from 'react-native';
import * as jobService from '@/lib/database/services/inference-job-service';
import * as factService from '@/lib/database/services/fact-service';
import { addFact, getFacts, getTopicsStatus } from '@/lib/database/services/fact-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import {
  T0,
  cleanup,
  completeJob,
  enqueueJob,
  hold,
  jobRow,
  jobRows,
  leaveRunning,
  prepare,
  startIdle,
  tick,
  turns,
  untilJob,
} from './kit';

beforeEach(prepare);
afterEach(cleanup);

const quick = () => jest.fn(async (..._args: unknown[]) => ({ ran: true }));

describe('start', () => {
  it('starts stopped and goes running; a second start() is a no-op that does not redo recovery', async () => {
    expect(inferenceQueue.getState()).toBe('stopped');
    await startIdle();
    expect(inferenceQueue.getState()).toBe('running');

    // A row left 'running' now would be re-pended by recoverCrashedJobs. A second start() must not.
    const id = await enqueueJob('persona_summary', {});
    await leaveRunning(id);
    await inferenceQueue.start();
    await turns();

    expect((await jobRow(id))?.status).toBe('running');
  });

  it('recovers a job a dead process left running and retries it, attempts counted', async () => {
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);
    const id = await enqueueJob('persona_summary', { n: 1 });
    await leaveRunning(id);

    await inferenceQueue.start();
    const row = await untilJob(id, ['done']);

    expect(handler).toHaveBeenCalledWith({ n: 1 }, { jobId: id });
    expect(row).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('a crashed job already at its attempt limit is failed, logged at start, and purged by the loop', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);
    const id = await enqueueJob('persona_summary', { n: 2 }, { maxAttempts: 1 });
    await leaveRunning(id);

    await inferenceQueue.start();

    expect(warn).toHaveBeenCalledWith(
      '[InferenceQueue] Failed job',
      expect.objectContaining({
        jobId: id,
        jobType: 'persona_summary',
        error: 'Crashed during execution (max attempts reached)',
        attempts: 1,
      }),
    );
    await untilJob(id, ['gone']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a failing purge of failed jobs is logged and the loop keeps serving jobs', async () => {
    const warn = jest.spyOn(logger, 'warn');
    jest.spyOn(jobService, 'purgeFailedJobs').mockRejectedValueOnce(new Error('purge failed'));
    const failed = await enqueueJob('persona_summary', {}, { maxAttempts: 1 });
    await leaveRunning(failed);
    const handler = quick();
    __setJobHandlerForTests('story_headline', handler);
    const next = await enqueueJob('story_headline', {});

    await inferenceQueue.start();
    await untilJob(next, ['done']);

    expect(warn).toHaveBeenCalledWith('[InferenceQueue] Failed to purge failed jobs', { error: 'Error: purge failed' });
    expect(inferenceQueue.getState()).toBe('running');
  });

  it('prunes finished jobs older than an hour and keeps recent ones', async () => {
    const stale = await enqueueJob('persona_summary', {});
    await completeJob(stale);
    jest.setSystemTime(T0 + 61 * 60_000);
    const recent = await enqueueJob('persona_summary', {});
    await completeJob(recent);

    await inferenceQueue.start();

    expect(await jobRow(stale)).toBeNull();
    expect((await jobRow(recent))?.status).toBe('done');
  });

  it('marks a stale pending fact with no live job as failed, and leaves one whose job is still queued', async () => {
    __setJobHandlerForTests('topic_gen', quick());
    const orphan = await addFact('Plays chess', undefined, undefined, { topicsStatus: 'pending' });
    const queued = await addFact('Plays go', undefined, undefined, { topicsStatus: 'pending' });
    await enqueueJob('topic_gen', { factId: queued.id, factStatement: 'Plays go' });
    jest.setSystemTime(T0 + 11 * 60_000);

    await inferenceQueue.start();

    expect(await getTopicsStatus(orphan.id)).toBe('error');
    const stored = (await getFacts()).find((f) => f.id === orphan.id);
    expect(stored?.metadata?.topicGenError?.[0]).toContain('Topic generation failed');
    expect(await getTopicsStatus(queued.id)).toBe('pending');
  });

  it('an orphan-fact sweep that throws is logged and the queue still starts', async () => {
    const error = jest.spyOn(logger, 'error');
    jest.spyOn(factService, 'markOrphanedFactsAsFailed').mockRejectedValueOnce(new Error('sweep error'));

    await inferenceQueue.start();

    expect(error).toHaveBeenCalledWith('[InferenceQueue] Orphan-fact sweep failed', expect.any(Error));
    expect(inferenceQueue.getState()).toBe('running');
  });

  it('destroys topics whose fact is gone and keeps the rest', async () => {
    const fact = await addFact('Plays chess');
    const [kept] = await createTopics([{ factId: fact.id, text: 'Chess news', weight: 1 }]);
    await createTopics([{ factId: 'deleted-fact', text: 'Dead topic', weight: 1 }]);

    await inferenceQueue.start();

    expect((await getByFact(fact.id)).map((t) => t.id)).toEqual([kept.id]);
    expect(await getByFact('deleted-fact')).toEqual([]);
  });
});

describe('stop', () => {
  it('is a no-op when already stopped', async () => {
    await inferenceQueue.stop();
    expect(inferenceQueue.getState()).toBe('stopped');
  });

  it('goes running to stopped, waits for the loop to leave, and removes its AppState subscription', async () => {
    const removed = jest.fn();
    const real = AppState.addEventListener.bind(AppState);
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: 'change', cb: Parameters<typeof AppState.addEventListener>[1]) => {
      const sub = real(type, cb);
      return { remove: () => (removed(), sub.remove()) };
    }) as never);
    await startIdle();
    expect(removed).not.toHaveBeenCalled();

    const stopped = inferenceQueue.stop();
    expect(inferenceQueue.getState()).toBe('stopped');
    await tick(0);
    await stopped;

    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('a job dequeued as the queue stops is left pending, not run', async () => {
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);
    const id = await enqueueJob('persona_summary', {});
    const real = jobService.dequeueJob;
    jest.spyOn(jobService, 'dequeueJob').mockImplementation(async (...args) => {
      const job = await real(...args);
      if (job) void inferenceQueue.stop();
      return job;
    });

    await inferenceQueue.start();
    await turns(10);

    expect(handler).not.toHaveBeenCalled();
    expect(await jobRow(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('pause and resume', () => {
  it('pause() moves running to paused and resume() back; both are no-ops when stopped', async () => {
    await inferenceQueue.pause();
    inferenceQueue.resume();
    expect(inferenceQueue.getState()).toBe('stopped');

    await startIdle();
    await inferenceQueue.pause();
    expect(inferenceQueue.getState()).toBe('paused');
    inferenceQueue.resume();
    expect(inferenceQueue.getState()).toBe('running');
  });

  it('pause() waits for the job in flight, and isBusy() reports it', async () => {
    const parked = hold({ done: 1 });
    __setJobHandlerForTests('persona_summary', parked.handler);
    const id = await enqueueJob('persona_summary', {});
    expect(inferenceQueue.isBusy()).toBe(false);
    await inferenceQueue.start();
    await parked.started;
    expect(inferenceQueue.isBusy()).toBe(true);

    let paused = false;
    const pausing = inferenceQueue.pause().then(() => (paused = true));
    await turns(10);
    expect(paused).toBe(false);
    expect(inferenceQueue.getState()).toBe('paused');

    parked.release();
    await pausing;

    expect((await jobRow(id))?.status).toBe('done');
    // Paused for chat's exclusive llama.rn access still counts as busy.
    expect(inferenceQueue.isBusy()).toBe(true);
    inferenceQueue.resume();
    await tick(0);
    expect(inferenceQueue.isBusy()).toBe(false);
  });

  it('a paused queue runs nothing, even when notified, until resume() wakes it at once', async () => {
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);
    await startIdle();
    await inferenceQueue.pause();
    const id = await enqueueJob('persona_summary', {});
    inferenceQueue.notify();

    await tick(10_000);
    expect(handler).not.toHaveBeenCalled();
    expect((await jobRow(id))?.status).toBe('pending');

    inferenceQueue.resume();
    // Well inside the 2 s idle sleep: resume wakes the loop, it does not wait the sleep out.
    await untilJob(id, ['done'], 500);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('notify', () => {
  it('does not throw while stopped', () => {
    expect(() => inferenceQueue.notify()).not.toThrow();
  });

  it('wakes the idle sleep: a job enqueued with notify() runs now, one without waits for the poll', async () => {
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);
    await startIdle();

    const quiet = await enqueueJob('persona_summary', { n: 'quiet' });
    await tick(1_500);
    expect((await jobRow(quiet))?.status).toBe('pending');

    const woken = await enqueueJob('persona_summary', { n: 'woken' });
    inferenceQueue.notify();
    await untilJob(woken, ['done'], 200);
    // The woken pass drained the queue in priority-then-age order, so the older one ran first.
    expect(handler.mock.calls.map((c) => (c[0] as { n: string }).n)).toEqual(['quiet', 'woken']);
  });
});

describe('onDrain', () => {
  it('fires once when no work is left, is then removed, and every registered callback fires', async () => {
    const first = jest.fn();
    const second = jest.fn();
    inferenceQueue.onDrain(first);
    inferenceQueue.onDrain(second);

    await inferenceQueue.start();
    await turns(10);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('a callback that throws is logged and does not stop the loop', async () => {
    const error = jest.spyOn(logger, 'error');
    inferenceQueue.onDrain(() => {
      throw new Error('drain cb error');
    });
    const handler = quick();
    __setJobHandlerForTests('persona_summary', handler);

    await startIdle();
    const id = await enqueueJob('persona_summary', {});
    inferenceQueue.notify();
    await untilJob(id, ['done']);

    expect(error).toHaveBeenCalledWith('[InferenceQueue] Drain callback failed', expect.any(Error));
    expect(inferenceQueue.getState()).toBe('running');
  });
});

describe('dequeueJob', () => {
  // Today's behaviour, documented: a take-1 READ. It does not claim the row, so two consumers
  // asking in a row get the same job (the queue is the single consumer, which is why this holds).
  it('reads the head job without claiming it: highest priority first, oldest within one, type exclusions applied', async () => {
    const older = await enqueueJob('persona_summary', { n: 'older' });
    await tick(5); // created_at is the fake clock: rows made in one millisecond tie
    await enqueueJob('persona_summary', { n: 'newer' });
    const urgent = await enqueueJob('topic_gen', { factId: 'f' });

    const first = await jobService.dequeueJob();
    const again = await jobService.dequeueJob();
    expect(first?.id).toBe(urgent);
    expect(again?.id).toBe(urgent);
    expect(first?.status).toBe('pending');
    expect((await jobRow(urgent))?.status).toBe('pending');

    expect((await jobService.dequeueJob({ excludeTypes: ['topic_gen'] }))?.id).toBe(older);
    expect(await jobService.dequeueJob({ excludeTypes: ['topic_gen', 'persona_summary'] })).toBeNull();
    expect((await jobRows()).map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
  });
});
