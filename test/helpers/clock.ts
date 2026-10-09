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
