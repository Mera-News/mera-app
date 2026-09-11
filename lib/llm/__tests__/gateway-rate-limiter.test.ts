// gateway-rate-limiter.test.ts — unit tests for lib/llm/gateway-rate-limiter.ts

import {
  acquire,
  pauseFor,
  tryTakeImmediate,
  _resetForTests,
  MIN_GATEWAY_INTERVAL_MS,
  MIN_INTERACTIVE_INTERVAL_MS,
  INTERACTIVE_MAX_PAUSE_MS,
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

// ─── Two lanes ───────────────────────────────────────────────────────────────
// Everything above this line predates the interactive lane and passes
// UNMODIFIED, which is the proof that the background lane is untouched.

describe('lanes', () => {
  it('grants a queued interactive caller ahead of queued background callers', async () => {
    const order: string[] = [];
    // Spend the cold-start slot so everyone below has to queue.
    await acquireGranted();

    acquire('background').then(() => order.push('bg1'));
    acquire('background').then(() => order.push('bg2'));
    acquire('interactive').then(() => order.push('ui'));

    // The interactive caller arrived LAST and is granted FIRST.
    await jest.advanceTimersByTimeAsync(MIN_INTERACTIVE_INTERVAL_MS);
    expect(order).toEqual(['ui']);

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(order).toEqual(['ui', 'bg1']);

    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(order).toEqual(['ui', 'bg1', 'bg2']);
  });

  it('anchors an interactive grant on the last grant, not the background cadence', async () => {
    // A background submit takes a slot, then a chat turn arrives 100ms later.
    expect(tryTakeImmediate('background')).toBe(true);
    await jest.advanceTimersByTimeAsync(100);

    const resolved = jest.fn();
    acquire('interactive').then(resolved);

    // 900ms more completes the 1s interactive spacing. The background lane
    // would still be 2s away.
    await jest.advanceTimersByTimeAsync(MIN_INTERACTIVE_INTERVAL_MS - 100 - 1);
    expect(resolved).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalled();

    // ... and the background lane really was still waiting at that moment.
    expect(tryTakeImmediate('background')).toBe(false);
  });

  it('spaces two interactive grants by MIN_INTERACTIVE_INTERVAL_MS', async () => {
    const first = acquire('interactive');
    await jest.advanceTimersByTimeAsync(0);
    await first;

    const second = jest.fn();
    acquire('interactive').then(second);
    await jest.advanceTimersByTimeAsync(MIN_INTERACTIVE_INTERVAL_MS - 1);
    expect(second).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalled();
  });

  // THE CEILING. This is the property the per-user throttle actually cares
  // about, so it is asserted directly over a mixed workload rather than
  // inferred from the two spacings.
  it('never issues two grants closer than MIN_INTERACTIVE_INTERVAL_MS, mixed lanes', async () => {
    const grantTimes: number[] = [];
    const lanes = [
      'interactive', 'background', 'interactive', 'interactive',
      'background', 'interactive', 'background', 'interactive',
    ] as const;
    for (const lane of lanes) {
      acquire(lane).then(() => grantTimes.push(Date.now()));
    }

    // Well past what the whole mix needs.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(grantTimes).toHaveLength(lanes.length);

    for (let i = 1; i < grantTimes.length; i++) {
      expect(grantTimes[i] - grantTimes[i - 1]).toBeGreaterThanOrEqual(
        MIN_INTERACTIVE_INTERVAL_MS,
      );
    }
    // 60 grants/minute is the implied device ceiling.
    const span = grantTimes[grantTimes.length - 1] - grantTimes[0];
    expect(grantTimes.length / Math.max(span, 1) * 60_000).toBeLessThanOrEqual(60);
  });
});

describe('pauseFor and the interactive lane', () => {
  it('caps an interactive wait at INTERACTIVE_MAX_PAUSE_MS while background serves the full pause', async () => {
    pauseFor(60_000);

    const ui = jest.fn();
    const bg = jest.fn();
    acquire('interactive').then(ui);
    acquire('background').then(bg);

    await jest.advanceTimersByTimeAsync(INTERACTIVE_MAX_PAUSE_MS - 1);
    expect(ui).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(ui).toHaveBeenCalled();
    expect(bg).not.toHaveBeenCalled();

    // Background keeps honouring the whole Retry-After.
    await jest.advanceTimersByTimeAsync(60_000 - INTERACTIVE_MAX_PAUSE_MS - 1);
    expect(bg).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(bg).toHaveBeenCalled();
  });

  it('honours a pause SHORTER than the interactive cap in full', async () => {
    pauseFor(500);
    const ui = jest.fn();
    acquire('interactive').then(ui);

    await jest.advanceTimersByTimeAsync(499);
    expect(ui).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(ui).toHaveBeenCalled();
  });
});

describe('acquire abort', () => {
  it('rejects an aborted waiter and does not consume its grant', async () => {
    await acquireGranted();

    const controller = new AbortController();
    const rejected = jest.fn();
    acquire('background', controller.signal).catch((err: Error) => rejected(err.name));

    const after = jest.fn();
    acquire('background').then(after);

    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith('AbortError');

    // The abandoned waiter burned nothing: the next caller grants on the
    // ORIGINAL schedule, not one interval later.
    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(after).toHaveBeenCalled();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquire('interactive', controller.signal)).rejects.toThrow();
  });

  it('does not let an abandoned interactive waiter hold up a background caller', async () => {
    await acquireGranted();

    const controller = new AbortController();
    acquire('interactive', controller.signal).catch(() => undefined);
    const bg = jest.fn();
    acquire('background').then(bg);

    controller.abort();
    await jest.advanceTimersByTimeAsync(MIN_GATEWAY_INTERVAL_MS);
    expect(bg).toHaveBeenCalled();
  });
});
