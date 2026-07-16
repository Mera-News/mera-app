// gateway-rate-limiter.test.ts — unit tests for lib/llm/gateway-rate-limiter.ts

import {
  acquire,
  pauseFor,
  tryTakeImmediate,
  _resetForTests,
  MIN_GATEWAY_INTERVAL_MS,
} from '../gateway-rate-limiter';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  _resetForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

// `acquire()` schedules its grant via setTimeout, even when the wait is 0ms —
// under fake timers nothing fires until timers are advanced. This helper
// grants an immediately-available slot and returns once it has resolved.
async function acquireGranted(): Promise<void> {
  const p = acquire();
  await jest.advanceTimersByTimeAsync(0);
  return p;
}

describe('acquire', () => {
  it('grants immediately on a cold start', async () => {
    const resolved = jest.fn();
    acquire().then(resolved);
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalled();
  });

  it('spaces two sequential grants by at least MIN_GATEWAY_INTERVAL_MS', async () => {
    const order: string[] = [];

    await acquireGranted();
    order.push(`first@${Date.now() - NOW}`);

    const secondResolved = jest.fn();
    acquire().then(() => {
      secondResolved();
      order.push(`second@${Date.now() - NOW}`);
    });

    // Not yet elapsed — second must not have granted.
    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS - 1);
    expect(secondResolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(secondResolved).toHaveBeenCalled();
  });

  it('serves concurrent callers in FIFO order, one per interval', async () => {
    const grantedOrder: number[] = [];
    const p1 = acquire().then(() => grantedOrder.push(1));
    const p2 = acquire().then(() => grantedOrder.push(2));
    const p3 = acquire().then(() => grantedOrder.push(3));

    await jest.advanceTimersByTimeAsync(0);
    expect(grantedOrder).toEqual([1]);

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(grantedOrder).toEqual([1, 2]);

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(grantedOrder).toEqual([1, 2, 3]);

    await Promise.all([p1, p2, p3]);
  });

  it('does not grant early when called well before the window elapses', async () => {
    await acquireGranted();

    // Advance halfway — well short of the required spacing.
    await jest.advanceTimersByTimeAsync(500);

    const resolved = jest.fn();
    acquire().then(resolved);
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS - 500);
    expect(resolved).toHaveBeenCalled();
  });
});

describe('pauseFor', () => {
  it('delays the next acquire by at least the given ms', async () => {
    await acquireGranted();

    pauseFor(10_000);

    const resolved = jest.fn();
    acquire().then(resolved);

    // Normal spacing would have granted by now, but the pause should still
    // be blocking it.
    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(resolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000 - MIN_GATEWAY_INTERVAL_MS);
    expect(resolved).toHaveBeenCalled();
  });

  it('does not stack repeated pauses — takes the max', async () => {
    pauseFor(5_000);
    pauseFor(3_000); // shorter — should not shrink or add to the existing pause

    const resolved = jest.fn();
    acquire().then(resolved);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(resolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalled();
  });

  it('a longer subsequent pause extends the wait', async () => {
    pauseFor(2_000);
    pauseFor(8_000); // longer — should extend

    const resolved = jest.fn();
    acquire().then(resolved);

    await jest.advanceTimersByTimeAsync(7_999);
    expect(resolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalled();
  });

  it('can push the next grant time even before any acquire has run', async () => {
    pauseFor(1_000);
    expect(tryTakeImmediate()).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(tryTakeImmediate()).toBe(true);
  });
});

describe('tryTakeImmediate', () => {
  it('returns true on a cold start', () => {
    expect(tryTakeImmediate()).toBe(true);
  });

  it('returns false immediately after taking a slot, then true after the interval', async () => {
    expect(tryTakeImmediate()).toBe(true);
    expect(tryTakeImmediate()).toBe(false);

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS - 1);
    expect(tryTakeImmediate()).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(tryTakeImmediate()).toBe(true);
  });

  it('does not block or consume the FIFO queue when it returns false', async () => {
    await acquireGranted(); // takes the first slot

    expect(tryTakeImmediate()).toBe(false);

    // A queued acquire should still grant on the normal schedule.
    const resolved = jest.fn();
    acquire().then(resolved);
    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(resolved).toHaveBeenCalled();
  });
});

describe('_resetForTests', () => {
  it('clears pending state so the next acquire grants immediately', async () => {
    await acquireGranted();
    pauseFor(50_000);
    _resetForTests();

    const resolved = jest.fn();
    acquire().then(resolved);
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalled();
  });
});
