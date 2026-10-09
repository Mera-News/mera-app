// CO4 (owner ruling): a background task that gets a 408 or 429 is retried with a growing delay,
// and once a run succeeds the task is back on its normal frequency. Today
// isNonRetryableError (lib/utils/retry.ts) files every 4xx, 408 and 429 included, as permanent,
// so the scheduler runner gives up after the first throttled run.
//
// Reached the way the app reaches it: AppScheduler.trigger() enqueues a real job row, the real
// runner drives the handler, the retry ladder and the persistence layer. The synthetic task and
// the per-test scheduler reset are the scheduler seam tests' own (data's support.ts). P3 flips the
// test.failing to test and deletes the "today" sibling in the same commit (R14).
import '@/test/helpers';

import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { jitteredInterval } from '@/lib/scheduler/jitter';
import { advanceUntilDone } from '@/test/helpers';

import { addTask, advanceUntil, jobRows, resetScheduler, settle } from '../../data/scheduler/core/support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const FREQUENCY_MS = 10_000; // shorter than the 60s failure gate, so a gate left armed would show

// Fake time moves only when the test advances it: the assertions below compare exact retryAt
// stamps, which wall time leaking into fake time (useFakeClock's advanceTimers) would skew.
function useStrictClock(now: number): void {
  jest.useFakeTimers({
    advanceTimers: false,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: new Date(now),
  });
}

beforeEach(() => {
  useStrictClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

const run = (name: string) =>
  advanceUntilDone(AppScheduler.trigger(name, undefined, { bypassDebounce: true }));

const throttled = (statusCode: number) =>
  Object.assign(new Error(statusCode === 429 ? 'Too Many Requests' : 'Request Timeout'), { statusCode });

describe.each([408, 429])('a background task answered %i', (statusCode) => {
  test.failing(
    'CO4: is retried with a growing delay, and a success puts it back on its normal frequency',
    async () => {
      const task = addTask({ frequency: FREQUENCY_MS, maxAttempts: 3, failWith: throttled(statusCode) });

      await run(task.name);
      let rows = await jobRows(task.name);
      expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'retrying']]);
      expect(rows[0].retryAt).toBe(T0 + 30_000);

      // Second throttled run: retried again, and the wait grows.
      await settle(31_000);
      expect(task.runs).toHaveLength(2);
      rows = await jobRows(task.name);
      expect(rows[1]).toMatchObject({ attempt: 2, status: 'retrying' });
      expect(rows[1].retryAt! - rows[1].scheduledAt).toBeGreaterThan(rows[0].retryAt! - rows[0].scheduledAt);

      // The server lets it through: the third run succeeds.
      task.failWith = null;
      await settle(61_000);
      expect(task.runs).toHaveLength(3);
      rows = await jobRows(task.name);
      expect(rows[2]).toMatchObject({ attempt: 3, status: 'completed' });
      const successAt = task.runs[2].at;

      // Back on its normal frequency: the tick fires it one jittered interval after the success,
      // not after the 60s failure gate.
      await advanceUntilDone(AppScheduler.init());
      await advanceUntil(() => task.runs.length === 4, 'the next scheduled run', 120_000);
      const gap = task.runs[3].at - successAt;
      expect(gap).toBeGreaterThanOrEqual(jitteredInterval(task.name, FREQUENCY_MS));
      expect(gap).toBeLessThan(60_000);
    },
  );

  test('CO4 (today): the first throttled run is terminal and nothing is retried', async () => {
    const task = addTask({ frequency: FREQUENCY_MS, maxAttempts: 3, failWith: throttled(statusCode) });

    await run(task.name);
    await settle(600_000);

    expect(task.runs).toHaveLength(1);
    const rows = await jobRows(task.name);
    expect(rows.map((r) => [r.attempt, r.status, r.retryAt])).toEqual([[1, 'failed', null]]);
  });
});
