// Regression coverage for the "first FAB press after a refresh no-ops, second
// press works" bug. Root cause: `scrollToTop`'s `scrollToOffset` call can be
// silently absorbed when it lands inside a window where something else is
// touching this list's scroll position/layout (see the long comment on
// `scrollToTopWithRetry` in ../scroll-to-top-with-retry.ts). The fix verifies
// the postcondition — did the offset actually move by the time the verify
// window elapses — and reissues once (unanimated) if not.
//
// This targets the extracted helper directly rather than rendering
// `<FeedScreen />`: the screen pulls in ~25 stores/hooks/gluestack components
// to render at all, none of which bear on this logic (see the module comment
// on scroll-to-top-with-retry.ts for why it's a separate file). Tested here
// against a fake ref + a controllable "current offset" + controllable
// schedule/verify callbacks, so the test drives each step deterministically
// instead of racing real rAF/timers.
import { scrollToTopWithRetry } from '../scroll-to-top-with-retry';

/** A controllable stand-in for a scheduler (`requestAnimationFrame` or a
 *  timeout) — the test decides exactly when a queued callback runs. */
function makeQueue() {
  let queue: Array<() => void> = [];
  const schedule = (cb: () => void) => {
    queue.push(cb);
  };
  const flush = () => {
    const pending = queue;
    queue = [];
    pending.forEach((cb) => cb());
  };
  return { schedule, flush };
}

describe('scrollToTopWithRetry', () => {
  it('does not retry when the offset has genuinely moved by the time the verify window elapses', () => {
    // This is the case the old one-frame check got wrong: a real animated
    // scroll doesn't necessarily report motion within a single frame (capped
    // further by scrollEventThrottle={16}), so the verify step must tolerate
    // that gap without firing a spurious retry mid-animation.
    const scrollToOffset = jest.fn();
    const ref = { current: { scrollToOffset } };
    let offset = 500;
    const initial = makeQueue();
    const verifyQueue = makeQueue();

    scrollToTopWithRetry(ref, () => offset, initial.schedule, verifyQueue.schedule);
    initial.flush(); // issues the first call, captures `before`, schedules the verify
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });

    // Time passes; the animation reports motion before the verify runs.
    offset = 120;
    verifyQueue.flush();

    expect(scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('reissues once, unanimated, when the offset never moves (the call was swallowed)', () => {
    const scrollToOffset = jest.fn();
    const ref = { current: { scrollToOffset } };
    const offset = 500; // frozen — simulates the call being absorbed by a
    // concurrent layout adjustment on the list
    const initial = makeQueue();
    const verifyQueue = makeQueue();

    scrollToTopWithRetry(ref, () => offset, initial.schedule, verifyQueue.schedule);
    initial.flush();
    expect(scrollToOffset).toHaveBeenCalledTimes(1);

    verifyQueue.flush(); // offset unchanged -> reissue
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
    // Unanimated: if the first call was actually still in flight, jumping
    // straight to 0 doesn't fight/cancel that animation.
    expect(scrollToOffset).toHaveBeenNthCalledWith(2, { offset: 0, animated: false });
  });

  it('never retries if the offset was already at rest at the top (defensive — unreachable via the FAB today)', () => {
    // The FAB only shows past SCROLL_THRESHOLD, so `before` is never 0 in
    // practice. This guards a hypothetical future consumer with a lower/no
    // threshold from retrying into a list that never needed to move.
    const scrollToOffset = jest.fn();
    const ref = { current: { scrollToOffset } };
    const offset = 0;
    const initial = makeQueue();
    const verifyQueue = makeQueue();

    scrollToTopWithRetry(ref, () => offset, initial.schedule, verifyQueue.schedule);
    initial.flush();
    verifyQueue.flush();

    expect(scrollToOffset).toHaveBeenCalledTimes(1); // the initial call only, no retry
  });

  it('is a no-op when the ref is detached, on both attempts', () => {
    const ref: { current: { scrollToOffset: (p: { offset: number; animated: boolean }) => void } | null } = {
      current: null,
    };
    const initial = makeQueue();
    const verifyQueue = makeQueue();

    expect(() => {
      scrollToTopWithRetry(ref, () => 0, initial.schedule, verifyQueue.schedule);
      initial.flush();
      verifyQueue.flush();
    }).not.toThrow();
  });

  it('uses requestAnimationFrame and a real timeout by default', () => {
    jest.useFakeTimers();
    const rafSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    const scrollToOffset = jest.fn();
    const ref = { current: { scrollToOffset } };

    // Stuck at a non-zero offset the whole time — simulates a call that never
    // took effect (as opposed to a list that was already at rest at the top).
    scrollToTopWithRetry(ref, () => 400);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);

    jest.runAllTimers();
    // Offset never moved -> the default verify timeout should have fired the
    // retry.
    expect(scrollToOffset).toHaveBeenCalledTimes(2);

    rafSpy.mockRestore();
    jest.useRealTimers();
  });
});
