// The two fake clocks and the real-turn drivers.
import { advanceUntil, advanceUntilDone, useFakeClock, useStrictClock } from '@/test/helpers';

const realWait = (ms: number) => new Promise((r) => jest.requireActual<typeof globalThis>('timers').setTimeout(r, ms));

describe('fake clocks', () => {
  it('useFakeClock and useStrictClock do not move with wall time; the advanceTimers opt-in does', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const t0 = Date.now();
    await realWait(60);
    expect(Date.now() - t0).toBe(0);

    useFakeClock('2026-10-09T00:00:00Z');
    const t2 = Date.now();
    await realWait(60);
    expect(Date.now() - t2).toBe(0);

    useFakeClock('2026-10-09T00:00:00Z', { advanceTimers: true });
    const t1 = Date.now();
    await realWait(60);
    expect(Date.now() - t1).toBeGreaterThan(0);
  });

  it('advanceUntil steps fake time, with real turns, until a timer-driven condition holds', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    let fired = false;
    setTimeout(() => (fired = true), 30_000);
    await advanceUntil(() => fired, 60_000);
    expect(fired).toBe(true);
    await expect(advanceUntil(() => false, 200)).rejects.toThrow('advanceUntil: condition not met');
  });

  it('concurrent DB writes finish under the strict clock without driving it (WorkQueue on both clocks)', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    const database = require('@/lib/database').default;
    const writes = Promise.all([1, 2, 3].map((n) => database.write(async () => n)));
    const timeout = realWait(2000).then(() => 'stalled');
    await expect(Promise.race([writes, timeout])).resolves.toEqual([1, 2, 3]);
  });

  it('an app setTimeout(0) stays on the fake clock', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    let fired = false;
    setTimeout(() => (fired = true), 0);
    await realWait(20);
    expect(fired).toBe(false);
    await advanceUntil(() => fired, 100);
  });

  it('advanceUntilDone settles a promise that needs fake time and a real macrotask', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const p = new Promise<string>((resolve) =>
      setTimeout(() => setImmediate(() => resolve('done')), 10_000),
    );
    await expect(advanceUntilDone(p)).resolves.toBe('done');
  });
});
