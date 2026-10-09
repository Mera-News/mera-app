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
  }
  return promise;
}
