// CH13: a start() during a stop() that is still waiting on an in-flight job must wait for that stop,
// or it re-pends the still-`running` row and a second loop runs the job again. The real trigger is
// useModelLifecycle effect 3; the same outcome through the hook is pinned in
// local-engine/model-lifecycle-restart.test.ts.
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
  // The stop() is not awaited: the restart's start() waits for it.
  await driveDone(starting);
  await untilJob(id, ['done']);
  for (let i = 0; i < 6; i++) await tick(500);

  return { runs: job.calls.length, status: (await jobRow(id))?.status };
}

describe('a restart while a job is running', () => {
  test('CH13: a start while the previous stop waits on a job does not run that job again', async () => {
    const { runs, status } = await restartWhileJobRuns();

    expect(status).toBe('done');
    expect(runs).toBe(1);
  });

});

// The other half of CH13: chat pauses the queue for exclusive llama.rn access (`pause()`), and a
// start() during the pause (useModelLifecycle effect 3 on a model reload) must leave it paused.

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
  test('CH13: start() while chat holds the queue paused does not run jobs until resume()', async () => {
    const { handler, id, stateAfterStart } = await startWhileChatHoldsPause();

    expect(stateAfterStart).toBe('paused');
    expect(handler).not.toHaveBeenCalled();

    inferenceQueue.resume();
    await untilJob(id, ['done']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

});

// Two start() calls in flight at once (useModelLifecycle effect 3 next to another caller) share one
// start, so only one consume loop exists and a job runs once.
describe('two starts in flight', () => {
  test('two un-awaited start() calls run a queued job once', async () => {
    const job = hold();
    __setJobHandlerForTests('persona_summary', job.handler);
    const id = await enqueueJob('persona_summary', {});

    const first = inferenceQueue.start();
    const second = inferenceQueue.start();
    await driveDone(job.started);
    // A second loop's first dequeue needs fake time to move.
    for (let i = 0; i < 6; i++) await tick(500);

    job.release();
    await driveDone(Promise.all([first, second]));
    await untilJob(id, ['done']);
    for (let i = 0; i < 6; i++) await tick(500);

    expect(job.calls).toHaveLength(1);
  });
});

// CH19: stop() while start() is still in its setup (recovery, prune, sweeps) sees `stopped`, returns
// at once, and the start then goes on to run the queue the caller just stopped.
async function stopDuringStartSetup() {
  const handler = jest.fn(async (..._args: unknown[]) => ({ ran: true }));
  __setJobHandlerForTests('persona_summary', handler);

  const starting = inferenceQueue.start();
  const stopping = inferenceQueue.stop();
  await driveDone(Promise.all([starting, stopping]));

  const state = inferenceQueue.getState();
  const id = await enqueueJob('persona_summary', {});
  inferenceQueue.notify();
  for (let i = 0; i < 6; i++) await tick(500);

  return { state, handler, status: (await jobRow(id))?.status };
}

describe('a stop during start setup', () => {
  test.failing("CH19: a stop() during start()'s setup leaves the queue stopped", async () => {
    const { state, handler, status } = await stopDuringStartSetup();

    expect(state).toBe('stopped');
    expect(handler).not.toHaveBeenCalled();
    expect(status).toBe('pending');
  });

  it('CH19 today: a stop() during start()\'s setup is lost and the queue runs', async () => {
    const { state, handler, status } = await stopDuringStartSetup();

    expect(state).toBe('running');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(status).toBe('done');
  });
});
