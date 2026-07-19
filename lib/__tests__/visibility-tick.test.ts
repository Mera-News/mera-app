// visibility-tick throttles scroll notifications on a wall-clock window
// (leading + trailing edge). Fake timers drive both setTimeout AND Date.now.

beforeEach(() => {
  jest.clearAllMocks();
  // Reset module state (lastFireAt / trailingTimer) between tests.
  jest.resetModules();
  jest.useFakeTimers();
  // Anchor the fake clock well past THROTTLE_MS so the very first
  // notifyScrollTick in each test is always a fresh leading-edge fire.
  jest.setSystemTime(1_000_000);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function loadModule() {
  return require('../visibility-tick') as typeof import('../visibility-tick');
}

describe('subscribeScrollTick', () => {
  it('returns an unsubscribe function', () => {
    const { subscribeScrollTick } = loadModule();
    const unsub = subscribeScrollTick(jest.fn());
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('adds a listener that is called on the leading-edge tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick();

    // Leading edge fires synchronously — no timer flush needed.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple listeners are all called on a tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const l1 = jest.fn();
    const l2 = jest.fn();
    subscribeScrollTick(l1);
    subscribeScrollTick(l2);

    notifyScrollTick();

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the listener — it is not called on next tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    const unsub = subscribeScrollTick(listener);
    unsub();

    notifyScrollTick();

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe is idempotent (safe to call twice)', () => {
    const { subscribeScrollTick } = loadModule();
    const unsub = subscribeScrollTick(jest.fn());
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });
});

describe('notifyScrollTick throttling', () => {
  it('fires the first call immediately (leading edge)', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst inside the window into ONE trailing fire', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    // Leading fire.
    notifyScrollTick();
    expect(listener).toHaveBeenCalledTimes(1);

    // A burst of rapid calls, all inside the 150ms window.
    jest.advanceTimersByTime(20);
    notifyScrollTick();
    jest.advanceTimersByTime(20);
    notifyScrollTick();
    jest.advanceTimersByTime(20);
    notifyScrollTick();

    // No extra synchronous fires — the burst is still queued as ONE trailing.
    expect(listener).toHaveBeenCalledTimes(1);

    // Advance past the end of the window → the single trailing fire lands.
    jest.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('trailing fire gives the LAST scroll position a tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick(); // leading
    jest.advanceTimersByTime(10);
    notifyScrollTick(); // schedules trailing (final position)

    expect(listener).toHaveBeenCalledTimes(1);
    // Trailing fires ~140ms later (THROTTLE_MS - elapsed).
    jest.advanceTimersByTime(140);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('enforces a minimum 150ms gap between fires', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick(); // t=0 leading fire
    // Still inside the window — must not fire again.
    jest.advanceTimersByTime(149);
    notifyScrollTick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires immediately again once the window has fully elapsed', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick(); // leading fire at t=0
    expect(listener).toHaveBeenCalledTimes(1);

    // Idle past the window, then scroll again → fresh leading fire.
    jest.advanceTimersByTime(200);
    notifyScrollTick();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does nothing (no crash) when there are no listeners', () => {
    const { notifyScrollTick } = loadModule();
    expect(() => {
      notifyScrollTick();
      jest.advanceTimersByTime(200);
    }).not.toThrow();
  });
});
