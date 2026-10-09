// The cooperative-yield helpers (idle.ts) and the maintenance idle guard (background-idle.ts).
// React Native's InteractionManager is the native edge for the first.
import '@/test/helpers';

import { InteractionManager } from 'react-native';

import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { backgroundWorkIsIdle } from '@/lib/scheduler/background-idle';
import {
  yieldToEventLoop,
  yieldToInteractions,
  yieldToInteractionsWithTimeout,
} from '@/lib/scheduler/idle';
import { advanceUntilDone, useFakeClock } from '@/test/helpers';

import { resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
});

/** Resolves a promise into a flag so a test can ask "has it settled yet". */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(() => (state.settled = true));
  return state;
}

// react-native 0.83 ships InteractionManager as a stub that runs every task on setImmediate and
// ignores interaction handles, so a leaked handle cannot be made from the real thing. The native
// edge is replaced per test with the behaviours the platform has: slow, never, early.
type Callback = () => void;
let interactionSpy: jest.SpyInstance | undefined;
const interactions = (onRun: (cb: Callback) => void) => {
  interactionSpy = jest
    .spyOn(InteractionManager, 'runAfterInteractions')
    .mockImplementation(((cb: Callback) => {
      onRun(cb);
      return { then: () => Promise.resolve(), cancel: () => {} };
    }) as never);
};

afterEach(() => {
  interactionSpy?.mockRestore();
  interactionSpy = undefined;
});

describe('yieldToInteractions', () => {
  it('resolves on the next macrotask with the stock InteractionManager', async () => {
    const yielded = track(yieldToInteractions());
    await Promise.resolve();
    expect(yielded.settled).toBe(false);

    await settle(50);

    expect(yielded.settled).toBe(true);
  });

  it('resolves when the interactions finish, not before', async () => {
    let finish!: Callback;
    interactions((cb) => (finish = cb));
    const yielded = track(yieldToInteractions());

    await settle(5_000);
    expect(yielded.settled).toBe(false);

    finish();
    await settle(0);

    expect(yielded.settled).toBe(true);
  });

  it('waits indefinitely on a leaked interaction (the behaviour the timeout variant guards)', async () => {
    interactions(() => {});
    const yielded = track(yieldToInteractions());

    await settle(600_000);

    expect(yielded.settled).toBe(false);
  });
});

describe('yieldToInteractionsWithTimeout', () => {
  it('resolves at the timeout when interactions never finish', async () => {
    interactions(() => {});
    const yielded = track(yieldToInteractionsWithTimeout(200));

    await settle(150);
    expect(yielded.settled).toBe(false);
    await settle(100);

    expect(yielded.settled).toBe(true);
  });

  it('resolves early when the interactions finish before the timeout', async () => {
    let finish!: Callback;
    interactions((cb) => (finish = cb));
    const yielded = track(yieldToInteractionsWithTimeout(60_000));
    await settle(10);
    expect(yielded.settled).toBe(false);

    finish();
    await settle(0);

    expect(yielded.settled).toBe(true);
  });
});

describe('yieldToEventLoop', () => {
  it('resolves on the next macrotask, not synchronously', async () => {
    const yielded = track(yieldToEventLoop());
    await Promise.resolve();
    expect(yielded.settled).toBe(false);

    await settle(0);

    expect(yielded.settled).toBe(true);
  });
});

describe('backgroundWorkIsIdle', () => {
  it('is idle when nothing is running and the inference queue is empty', () => {
    expect(backgroundWorkIsIdle()).toBe(true);
  });

  it('is busy while feed-sync is running, and idle again when the run ends', async () => {
    let release!: () => void;
    AppScheduler.register({
      name: 'feed-sync',
      displayName: 'Feed sync',
      frequency: 0,
      handler: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const running = AppScheduler.trigger('feed-sync');
    await settle(100);

    expect(backgroundWorkIsIdle()).toBe(false);

    release();
    await advanceUntilDone(running);
    expect(backgroundWorkIsIdle()).toBe(true);
  });

  it('is not held up by another task running', async () => {
    let release!: () => void;
    AppScheduler.register({
      name: 'some-other-task',
      displayName: 'Other',
      frequency: 0,
      handler: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const running = AppScheduler.trigger('some-other-task');
    await settle(100);

    expect(backgroundWorkIsIdle()).toBe(true);

    release();
    await advanceUntilDone(running);
  });

  it('is busy while the real inference queue is paused (chat holds it), and idle once it resumes', async () => {
    await advanceUntilDone(inferenceQueue.start());
    try {
      await inferenceQueue.pause();
      expect(backgroundWorkIsIdle()).toBe(false);

      inferenceQueue.resume();
      expect(backgroundWorkIsIdle()).toBe(true);
    } finally {
      const stopping = inferenceQueue.stop();
      await advanceUntilDone(stopping);
    }
  });
});
