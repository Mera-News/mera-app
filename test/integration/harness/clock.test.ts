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

// The virtual budget spends one real turn per step; work that needs more real turns than that
// (a loaded machine) still lands, in the settle phase, with the clock standing still.
describe('the settle phase after a spent virtual budget', () => {
  const afterRealTurns = (n: number, then: () => void) => {
    let left = n;
    const tick = () => (--left > 0 ? setImmediate(tick) : then());
    setImmediate(tick);
  };

  it('advanceUntil: a condition that holds only after more real turns than the budget gives is met, and the clock stays put', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    let ready = false;
    afterRealTurns(50, () => (ready = true));
    const t0 = Date.now();
    await advanceUntil(() => ready, 100);
    expect(ready).toBe(true);
    expect(Date.now() - t0).toBe(100);
  });

  it('advanceUntil: a condition that never holds still throws, naming the budget and the condition', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const neverReady = false;
    await expect(advanceUntil(() => neverReady, 100)).rejects.toThrow(
      /condition not met within 100ms virtual: .*neverReady/,
    );
  });

  it('advanceUntilDone: a chain that reaches a zero-delay fake timer after the budget still settles', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const p = new Promise<string>((resolve) => afterRealTurns(50, () => setTimeout(() => resolve('done'), 0)));
    const stalled = realWait(2000).then(() => 'stalled');
    await expect(Promise.race([advanceUntilDone(p, 100), stalled])).resolves.toBe('done');
  });
});
