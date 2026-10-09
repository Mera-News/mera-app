// Fake clock. nextTick, setImmediate and queueMicrotask stay real so promise
// chains and MSW's stream plumbing keep flowing. The integration setup calls
// jest.useRealTimers() after each test.
export function useFakeClock(now: string | number | Date): void {
  jest.useFakeTimers({
    advanceTimers: true,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: new Date(now),
  });
}

/**
 * Opt-in strict fake clock: time moves ONLY when the test drives it (`advanceTimers: false`).
 * useFakeClock follows wall time too, so under a loaded full run real time leaks into fake-time
 * windows and an upper-bound assertion on fake time ("fired within 30s + 3s") flakes. Use this for
 * any test that asserts a fake-time bound, and drive it with advanceUntil / advanceUntilDone, which
 * yield one real event-loop turn per step so MSW's streams keep moving.
 * ponytail: opt-in; making it the default for every test is a P4/P5 candidate (it would change
 * every existing test's timing mid-wave).
 */
export function useStrictClock(now: string | number | Date): void {
  jest.useFakeTimers({
    advanceTimers: false,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: new Date(now),
  });
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

/** Advances fake time in small steps, with a real event-loop turn per step, until `cond()` holds;
 *  throws if it never does within maxMs of virtual time. */
export async function advanceUntil(cond: () => boolean, maxMs = 120_000, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !cond(); elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await realTurn();
  }
  if (!cond()) throw new Error('advanceUntil: condition not met');
}
