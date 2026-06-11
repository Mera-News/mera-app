// visibility-tick uses requestAnimationFrame — polyfill it in the test env.

let rafCallback: FrameRequestCallback | null = null;

beforeEach(() => {
  rafCallback = null;
  jest.clearAllMocks();
  // Reset module state between tests by re-requiring
  jest.resetModules();

  // Polyfill requestAnimationFrame so the module can be imported in Node
  global.requestAnimationFrame = jest.fn((cb: FrameRequestCallback) => {
    rafCallback = cb;
    return 1;
  });
});

afterEach(() => {
  // Clean up global polyfill
  // @ts-ignore
  delete global.requestAnimationFrame;
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

  it('adds a listener that is called when a scroll tick is triggered', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick();
    // flush the rAF
    if (rafCallback) rafCallback(0);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple listeners are all called on scroll tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const l1 = jest.fn();
    const l2 = jest.fn();
    subscribeScrollTick(l1);
    subscribeScrollTick(l2);

    notifyScrollTick();
    if (rafCallback) rafCallback(0);

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the listener — it is not called on next tick', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    const unsub = subscribeScrollTick(listener);
    unsub();

    notifyScrollTick();
    if (rafCallback) rafCallback(0);

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

describe('notifyScrollTick', () => {
  it('coalesces multiple rapid calls into one rAF (pending flag)', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick();
    notifyScrollTick();
    notifyScrollTick();

    // Only one rAF should have been scheduled
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1);

    // flush the rAF
    if (rafCallback) rafCallback(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('allows a second tick after the first rAF fires', () => {
    const { subscribeScrollTick, notifyScrollTick } = loadModule();
    const listener = jest.fn();
    subscribeScrollTick(listener);

    notifyScrollTick();
    if (rafCallback) rafCallback(0);

    // Second round
    rafCallback = null;
    notifyScrollTick();
    if (rafCallback) (rafCallback as FrameRequestCallback)(0);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does nothing (no crash) when there are no listeners', () => {
    const { notifyScrollTick } = loadModule();
    expect(() => {
      notifyScrollTick();
      if (rafCallback) rafCallback(0);
    }).not.toThrow();
  });
});
