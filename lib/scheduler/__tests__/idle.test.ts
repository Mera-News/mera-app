// idle.test.ts — the cooperative-yielding helpers. The interesting one is
// `yieldToInteractionsWithTimeout`: it is what stops a leaked
// InteractionManager handle from silently swallowing deferred work (the
// foreground sync kick, the cold-start kick). Pinned here directly rather than
// only through AppScheduler, so a change to that suite's react-native mock
// can't quietly remove the coverage.

let mockRunAfterInteractions: ((cb: () => void) => void) | undefined;

jest.mock('react-native', () => ({
  InteractionManager: {
    get runAfterInteractions() {
      return mockRunAfterInteractions;
    },
  },
}));

import {
  yieldToEventLoop,
  yieldToInteractions,
  yieldToInteractionsWithTimeout,
} from '../idle';

beforeEach(() => {
  jest.useFakeTimers();
  mockRunAfterInteractions = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('yieldToInteractions', () => {
  it('resolves via runAfterInteractions when it is available', async () => {
    let resolveInteractions: (() => void) | null = null;
    mockRunAfterInteractions = (cb) => { resolveInteractions = cb; };

    let settled = false;
    void yieldToInteractions().then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    (resolveInteractions as unknown as () => void)();
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it('falls back to a macrotask when InteractionManager is unavailable', async () => {
    let settled = false;
    void yieldToInteractions().then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it('waits indefinitely on a leaked handle (the behaviour the timeout variant guards)', async () => {
    mockRunAfterInteractions = () => { /* never calls back */ };

    let settled = false;
    void yieldToInteractions().then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
  });
});

describe('yieldToInteractionsWithTimeout', () => {
  it('resolves at the timeout when runAfterInteractions never calls back', async () => {
    mockRunAfterInteractions = () => { /* never calls back */ };

    let settled = false;
    void yieldToInteractionsWithTimeout(50).then(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('resolves early when interactions settle before the timeout', async () => {
    let resolveInteractions: (() => void) | null = null;
    mockRunAfterInteractions = (cb) => { resolveInteractions = cb; };

    let settled = false;
    void yieldToInteractionsWithTimeout(5_000).then(() => { settled = true; });

    (resolveInteractions as unknown as () => void)();
    await jest.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
  });
});

describe('yieldToEventLoop', () => {
  it('resolves on the next macrotask', async () => {
    let settled = false;
    void yieldToEventLoop().then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});

export {};
