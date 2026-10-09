// CH13: InferenceQueue.stop() sets `stopped` at once but then waits for the in-flight job, and
// start() only returns early on `running`. A start() during that wait re-pends the still-`running`
// row (recoverCrashedJobs), and a second consume loop dequeues it (dequeueJob is a read, not a
// claim), so the handler runs twice. The real trigger is useModelLifecycle effect 3; the same
// outcome through the hook is pinned in local-engine/model-lifecycle-restart.test.ts.
//
// Real queue, real in-memory DB; the only fake is the handler, through the queue's own seam.
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { cleanup, driveDone, enqueueJob, hold, jobRow, prepare, startIdle, tick, untilJob } from '../inference/kit';

beforeEach(prepare);
afterEach(cleanup);

/** Starts the queue, holds one job's handler open, restarts the queue (stop NOT awaited), lets the
 *  restart run, then releases the handler and lets every loop settle. Returns how often it ran. */
async function restartWhileJobRuns(): Promise<{ runs: number; status: string | undefined }> {
  const job = hold();
  __setJobHandlerForTests('persona_summary', job.handler);
  await startIdle();
  const id = await enqueueJob('persona_summary', {});
  inferenceQueue.notify();
  await driveDone(job.started);

  void inferenceQueue.stop();
  const starting = inferenceQueue.start();
  // The restart's recovery and the second loop's first dequeue need fake time to move.
  for (let i = 0; i < 6; i++) await tick(500);

  job.release();
  // The stop() is not awaited: with the bug the old loop never sees `stopped` again (the restart
  // set `running`), so that promise never settles.
  await driveDone(starting);
  await untilJob(id, ['done']);
  for (let i = 0; i < 6; i++) await tick(500);

  return { runs: job.calls.length, status: (await jobRow(id))?.status };
}

describe('a restart while a job is running', () => {
  test.failing('CH13: a start while the previous stop waits on a job does not run that job again', async () => {
    const { runs, status } = await restartWhileJobRuns();

    expect(status).toBe('done');
    expect(runs).toBe(1);
  });

  it('CH13 today: a start while the previous stop waits on a job runs that job twice', async () => {
    const { runs, status } = await restartWhileJobRuns();

    expect(status).toBe('done');
    expect(runs).toBe(2);
  });
});

// The other half of CH13: chat pauses the queue for exclusive llama.rn access (`pause()`), and
// start() only returns early on `running`, so a start() during the pause (useModelLifecycle effect
// 3 on a model reload) flips `paused` to `running` and a second loop runs jobs under chat.

/** Queue started and paused the way chat does, one job already in the table (no notify()), then a
 *  start() lands. Ticks pass with chat still holding the pause. */
async function startWhileChatHoldsPause() {
  const handler = jest.fn(async (..._args: unknown[]) => ({ ran: true }));
  __setJobHandlerForTests('persona_summary', handler);
  await startIdle();
  await driveDone(inferenceQueue.pause());
  const id = await enqueueJob('persona_summary', {});

  await driveDone(inferenceQueue.start());
  for (let i = 0; i < 6; i++) await tick(500);

  return { handler, id, stateAfterStart: inferenceQueue.getState() };
}

describe('a start while chat holds the queue paused', () => {
  test.failing('CH13: start() while chat holds the queue paused does not run jobs until resume()', async () => {
    const { handler, id, stateAfterStart } = await startWhileChatHoldsPause();

    expect(stateAfterStart).toBe('paused');
    expect(handler).not.toHaveBeenCalled();

    inferenceQueue.resume();
    await untilJob(id, ['done']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('CH13 today: start() while chat holds the queue paused runs the job under chat', async () => {
    const { handler, id, stateAfterStart } = await startWhileChatHoldsPause();

    expect(stateAfterStart).toBe('running');
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await jobRow(id))?.status).toBe('done');
  });
});
