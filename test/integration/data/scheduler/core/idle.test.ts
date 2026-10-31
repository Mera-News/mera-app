// The cooperative-yield helpers (idle.ts) and the maintenance idle guard (background-idle.ts).
import '@/test/helpers';

import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { backgroundWorkIsIdle } from '@/lib/scheduler/background-idle';
import {
  runWhenIdle,
  yieldToEventLoop,
  yieldToInteractions,
  yieldToInteractionsWithTimeout,
} from '@/lib/scheduler/idle';
import { sleep } from '@/lib/utils/sleep';
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

describe('yieldToInteractions', () => {
  it('resolves on the next macrotask', async () => {
    const yielded = track(yieldToInteractions());
    await Promise.resolve();
    expect(yielded.settled).toBe(false);

    await settle(50);

    expect(yielded.settled).toBe(true);
  });
});

describe('runWhenIdle', () => {
  it('runs on the next macrotask, and not once cancelled', async () => {
    const ran = jest.fn();
    runWhenIdle(ran);
    const cancel = runWhenIdle(ran);
    cancel();
    expect(ran).not.toHaveBeenCalled();

    await settle(0);

    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('yieldToInteractionsWithTimeout', () => {
  it('resolves on the next macrotask, ahead of a long ceiling', async () => {
    const yielded = track(yieldToInteractionsWithTimeout(60_000));
    await Promise.resolve();
    expect(yielded.settled).toBe(false);

    await settle(0);

    expect(yielded.settled).toBe(true);
  });

  it('still resolves at the ceiling when the yield is slower', async () => {
    const yielded = track(Promise.race([new Promise<void>(() => {}), sleep(200)]));
    await settle(150);
    expect(yielded.settled).toBe(false);
    await settle(100);

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
