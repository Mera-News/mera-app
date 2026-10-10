// The idle poll cadence and the foreground gate. Observed through the loop's own reads: every pass
// asks `dequeueJob` for its next job, so the fake-clock offsets of those calls ARE the cadence
// (a pass-through spy on the real service, no behaviour changed).
//
// Replaces the "idle poll backoff + AppState gate (B1.3)" describe of
// lib/inference/__tests__/InferenceQueue.test.ts: doubles 2s to 30s and caps; notify() resets;
// the paused branch does not back off; stop() removes the subscription (see queue-lifecycle);
// backgrounding pins the sleep to the cap and foregrounding resets it.
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { setAppState } from '@/test/helpers';
import { cleanup, enqueueJob, jobRow, prepare, startIdle, stopQueue, tick, turns, watchPolls } from './kit';

beforeEach(prepare);
afterEach(async () => {
  setAppState('active');
  await cleanup();
});

describe('the idle sleep', () => {
  it('doubles from 2 s to a 30 s cap while the queue stays empty', async () => {
    const polls = watchPolls();
    await startIdle();

    await tick(125_000);

    expect(polls).toEqual([0, 2_000, 6_000, 14_000, 30_000, 60_000, 90_000, 120_000]);
  });

  it('notify() drops it back to 2 s: an immediate pass, then the short cadence again', async () => {
    const polls = watchPolls();
    await startIdle();
    await tick(15_000);
    expect(polls).toEqual([0, 2_000, 6_000, 14_000]);

    inferenceQueue.notify();
    await tick(7_000);

    expect(polls).toEqual([0, 2_000, 6_000, 14_000, 15_000, 17_000, 21_000]);
  });

  it('backgrounding pins the next sleep to the cap; coming back wakes the loop at once and resets it', async () => {
    const polls = watchPolls();
    await startIdle();

    // Lands while the first 2 s sleep is pending; the write must survive the loop resuming.
    setAppState('background');
    await tick(2_000);
    expect(polls).toEqual([0, 2_000]);
    await tick(3_000);
    expect(polls).toEqual([0, 2_000]); // asleep for 30 s

    setAppState('active');
    await tick(6_000);

    expect(polls).toEqual([0, 2_000, 5_000, 7_000, 11_000]);
  });

  it('a job enqueued while backgrounded still runs at once when notified', async () => {
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('persona_summary', handler);
    await startIdle();
    setAppState('background');
    await tick(2_000);

    const id = await enqueueJob('persona_summary', {});
    inferenceQueue.notify();
    await tick(100);

    expect((await jobRow(id))?.status).toBe('done');
  });
});

describe('a notify() lost to an earlier sleep timer', () => {
  /** Poll at 0 (timer A, 2 s) -> notify at 1 s wakes it -> poll at 1 s (timer B, ends at 3 s)
   *  -> timer A fires at 2 s. Then a job is enqueued and the queue notified. */
  async function scenario(then: (s: { id: string; handler: jest.Mock }) => Promise<void>) {
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('persona_summary', handler);
    try {
      await startIdle();
      await tick(1_000);
      inferenceQueue.notify();
      await tick(1_000);
      const id = await enqueueJob('persona_summary', {});
      inferenceQueue.notify();
      await tick(100);
      await then({ id, handler });
    } finally {
      // Stop while the clock is still fake.
      await stopQueue();
    }
  }

  test('a notify() right after an earlier, already-woken sleep timer fired runs the job now', async () => {
    await scenario(async ({ id }) => {
      expect((await jobRow(id))?.status).toBe('done');
    });
  });
});

describe('the paused loop', () => {
  it('the paused loop keeps the fixed 2 s cadence and does not poll for jobs', async () => {
    const polls = watchPolls();
    await startIdle();
    await tick(7_000); // polls at 0, 2 s, 6 s; now inside the 8 s sleep that ends at 14 s
    await inferenceQueue.pause();
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms >= 1_000) delays.push(ms);
      return real(fn, ms);
    }) as never);

    await tick(20_000);
    // Restored here, not in afterEach: the setup puts real timers back first, and restoring after
    // that would reinstall the dead fake setTimeout for the next test.
    spy.mockRestore();

    expect(polls).toEqual([0, 2_000, 6_000]);
    // Woke at 14 s, saw it was paused, then slept the minimum every time: never the backoff.
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(new Set(delays)).toEqual(new Set([2_000]));
  });
});
