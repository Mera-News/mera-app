// The two fake clocks and the real-turn drivers.
import { advanceUntil, advanceUntilDone, useFakeClock, useStrictClock } from '@/test/helpers';

const realWait = (ms: number) => new Promise((r) => jest.requireActual<typeof globalThis>('timers').setTimeout(r, ms));

describe('fake clocks', () => {
  it('useStrictClock does not move with wall time; useFakeClock does', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const t0 = Date.now();
    await realWait(60);
    expect(Date.now() - t0).toBe(0);

    useFakeClock('2026-10-09T00:00:00Z');
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

  it('advanceUntilDone settles a promise that needs fake time and a real macrotask', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    const p = new Promise<string>((resolve) =>
      setTimeout(() => setImmediate(() => resolve('done')), 10_000),
    );
    await expect(advanceUntilDone(p)).resolves.toBe('done');
  });
});
