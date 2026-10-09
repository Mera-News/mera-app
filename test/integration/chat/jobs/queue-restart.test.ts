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
