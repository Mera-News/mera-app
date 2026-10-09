// Promoted to test/helpers/clock.ts; kept so chat's imports still resolve.
export { useStrictClock } from '@/test/helpers/clock';

/** Steps the strict clock until `promise` settles (or `maxMs` of fake time), yielding one REAL
 *  event-loop turn per step so MSW's request and stream plumbing can progress. */
export async function driveUntilDone<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 50): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let elapsed = 0; !done && elapsed < maxMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((r) => setImmediate(r));
  }
  return promise;
}
