// A fake clock that moves ONLY when the test drives it.
//
// The harness's useFakeClock passes `advanceTimers: true`, so fake time also follows wall time.
// Under a loaded full run every driver step takes longer in real time and that real time leaks into
// the fake clock, so a bound such as "the idle window fired within 30s + 3s of fake time" drifts and
// fails one run in many. Chat tests that assert on fake-time windows use this clock and a driver that
// yields one real event-loop turn per step (streaming/support.ts `drive` / `advanceUntil`), which keeps
// MSW's stream plumbing moving without letting wall time in.
export function useStrictClock(now: string | number | Date): void {
  jest.useFakeTimers({
    advanceTimers: false,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: new Date(now),
  });
}
