// Fake clock. Time moves only when the test drives it (advanceTimers false): with wall time
// leaking in, an upper bound on fake time flaked under a loaded full run. Drive it with
// advanceUntil / advanceUntilDone, which yield a real event-loop turn per step. Pass
// { advanceTimers: true } only for a test that needs wall time to move fake time (a real wait on
// a fake timer). nextTick, setImmediate and queueMicrotask stay real so promise chains and MSW's
// stream plumbing keep flowing. The integration setup calls jest.useRealTimers() after each test.
export function useFakeClock(now: string | number | Date, opts: { advanceTimers?: boolean } = {}): void {
  jest.useFakeTimers({
    advanceTimers: opts.advanceTimers ?? false,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: new Date(now),
  });
}

/** The strict clock under its earlier name; useFakeClock is now strict by default. */
export function useStrictClock(now: string | number | Date): void {
  useFakeClock(now);
}

/** Advances fake time in small steps until no timer is pending or maxMs has elapsed. */
export async function advanceUntilSettled(maxMs = 60_000, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && jest.getTimerCount() > 0; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
}

/** Advances fake time until `promise` settles (or maxMs), then returns it. Use it right after
 *  starting an async chain: advanceUntilSettled() would return at once while no timer is
 *  pending yet. */
export async function advanceUntilDone<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 50): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let elapsed = 0; !done && elapsed < maxMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await realTurn();
  }
  return promise;
}

// One REAL event-loop turn (setImmediate stays unfaked). advanceTimersByTimeAsync drains only
// microtasks, and a request through MSW needs real macrotask turns to answer, so a long virtual
// wait could otherwise be stepped through before the network ever replied.
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

// After the virtual budget, real turns with the clock still: up to this many, or this much wall time.
const SETTLE_TURNS = 500;
const SETTLE_NS = 2_000_000_000n;

/** Advances fake time in small steps, with a real event-loop turn per step, until `cond()` holds;
 *  throws if it never does within maxMs of virtual time plus a settle phase.
 *  The budget is virtual but the work it waits on (MSW, E2EE, an abort reaching the mock) needs REAL
 *  turns, and a loaded machine can spend the whole budget before that work lands. So the settle
 *  phase yields real turns without moving the clock, and only then gives up. */
export async function advanceUntil(cond: () => boolean, maxMs = 120_000, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !cond(); elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await realTurn();
  }
  // hrtime, not Date.now(): the fake clock owns Date.
  const start = process.hrtime.bigint();
  for (let turn = 0; turn < SETTLE_TURNS && !cond() && process.hrtime.bigint() - start < SETTLE_NS; turn++) {
    await jest.advanceTimersByTimeAsync(0);
    await realTurn();
  }
  if (!cond()) throw new Error(`advanceUntil: condition not met within ${maxMs}ms virtual: ${String(cond).slice(0, 200)}`);
}
