// InferenceQueue.test.ts — unit tests for lib/inference/InferenceQueue.ts
// All jest.mock() BEFORE imports.

const mockDequeueJob = jest.fn();
const mockGetQueueStats = jest.fn();
const mockGetFailedJobs = jest.fn();
const mockRecoverCrashedJobs = jest.fn();
const mockPruneCompletedJobs = jest.fn();
const mockPurgeFailedJobs = jest.fn();
const mockGetActiveTopicGenFactIds = jest.fn();

jest.mock('../../database/services/inference-job-service', () => ({
  dequeueJob: (...args: unknown[]) => mockDequeueJob(...args),
  getQueueStats: (...args: unknown[]) => mockGetQueueStats(...args),
  getFailedJobs: (...args: unknown[]) => mockGetFailedJobs(...args),
  recoverCrashedJobs: (...args: unknown[]) => mockRecoverCrashedJobs(...args),
  pruneCompletedJobs: (...args: unknown[]) => mockPruneCompletedJobs(...args),
  purgeFailedJobs: (...args: unknown[]) => mockPurgeFailedJobs(...args),
  getActiveTopicGenFactIds: (...args: unknown[]) => mockGetActiveTopicGenFactIds(...args),
}));

const mockMarkOrphanedFactsAsFailed = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  markOrphanedFactsAsFailed: (...args: unknown[]) => mockMarkOrphanedFactsAsFailed(...args),
}));

const mockHandleTopicGenJob = jest.fn();

jest.mock('../handlers/topic-gen-handler', () => ({
  handleTopicGenJob: (...args: unknown[]) => mockHandleTopicGenJob(...args),
}));

const mockHandlePersonaSummaryJob = jest.fn();
jest.mock('../handlers/persona-summary-handler', () => ({
  handlePersonaSummaryJob: (...args: unknown[]) => mockHandlePersonaSummaryJob(...args),
}));

const mockResetContext = jest.fn();

jest.mock('../../mera-protocol-toolkit', () => ({
  resetContext: (...args: unknown[]) => mockResetContext(...args),
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureMessage: jest.fn(),
    captureException: jest.fn(),
  },
}));

jest.useFakeTimers();

import { inferenceQueue } from '../InferenceQueue';

// Helper to build fake job objects
function makeFakeJob(opts: {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  attempts?: number;
}) {
  return {
    id: opts.id,
    jobType: opts.jobType,
    payload: opts.payload,
    attempts: opts.attempts ?? 0,
    markRunning: jest.fn().mockResolvedValue(undefined),
    markDone: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
}

// Helper: flush several microtask ticks
async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

// Stop the queue; the loop may be sleeping — advance timers to unblock it
async function safeStop() {
  // Issue stop, then fire all timers so the sleep() resolves
  const stopPromise = inferenceQueue.stop();
  jest.runAllTimers();
  // Flush microtasks so the loop exits cleanly
  await flushMicrotasks(10);
  await stopPromise;
}

describe('InferenceQueue', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await safeStop();
    jest.clearAllTimers();

    // Default safe mocks
    mockRecoverCrashedJobs.mockResolvedValue(undefined);
    mockPruneCompletedJobs.mockResolvedValue(undefined);
    mockGetActiveTopicGenFactIds.mockResolvedValue([]);
    mockMarkOrphanedFactsAsFailed.mockResolvedValue(0);
    mockGetQueueStats.mockResolvedValue({ pending: 0, running: 0, failed: 0, completed: 0 });
    mockGetFailedJobs.mockResolvedValue([]);
    mockDequeueJob.mockResolvedValue(null);
    mockPurgeFailedJobs.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Stop the queue after each test — fire timers to unblock any sleep
    await safeStop();
    jest.clearAllTimers();
  }, 30000);

  describe('getState()', () => {
    it('returns "stopped" initially after stop()', () => {
      expect(inferenceQueue.getState()).toBe('stopped');
    });
  });

  describe('start()', () => {
    it('transitions to running state', async () => {
      // dequeueJob resolves immediately to null (no jobs → sleep) to keep loop alive
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(5);

      expect(inferenceQueue.getState()).toBe('running');
    });

    it('is idempotent — second call is no-op while running', async () => {
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await inferenceQueue.start();

      expect(mockRecoverCrashedJobs).toHaveBeenCalledTimes(1);
    });

    it('calls recoverCrashedJobs on start', async () => {
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();

      expect(mockRecoverCrashedJobs).toHaveBeenCalledTimes(1);
    });

    it('calls pruneCompletedJobs on start', async () => {
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();

      expect(mockPruneCompletedJobs).toHaveBeenCalledTimes(1);
    });

    it('marks orphaned facts as failed on startup', async () => {
      mockGetActiveTopicGenFactIds.mockResolvedValue(['fact-1', 'fact-2']);
      mockMarkOrphanedFactsAsFailed.mockResolvedValue(2);
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();

      expect(mockMarkOrphanedFactsAsFailed).toHaveBeenCalledWith(
        ['fact-1', 'fact-2'],
        expect.stringContaining('Topic generation failed'),
      );
    });
  });

  describe('stop()', () => {
    it('is idempotent when already stopped', async () => {
      expect(inferenceQueue.getState()).toBe('stopped');
      await safeStop();
      expect(inferenceQueue.getState()).toBe('stopped');
    });

    it('transitions from running to stopped', async () => {
      // stop() synchronously sets state='stopped' — just verify that
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await flushMicrotasks(5); // let the loop reach sleep()

      inferenceQueue.stop(); // sets state synchronously

      expect(inferenceQueue.getState()).toBe('stopped');
      jest.runAllTimers();
      await flushMicrotasks(5);
    });
  });

  describe('pause() / resume()', () => {
    it('pause() transitions running → paused', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await flushMicrotasks(5);

      await inferenceQueue.pause();

      expect(inferenceQueue.getState()).toBe('paused');
    });

    it('pause() is a no-op when stopped', async () => {
      await inferenceQueue.pause();
      expect(inferenceQueue.getState()).toBe('stopped');
    });

    it('resume() transitions paused → running', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await inferenceQueue.pause();

      inferenceQueue.resume();

      expect(inferenceQueue.getState()).toBe('running');
    });

    it('resume() is a no-op when stopped', async () => {
      inferenceQueue.resume();
      expect(inferenceQueue.getState()).toBe('stopped');
    });

    it('resume() wakes the loop (state stays running)', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await inferenceQueue.pause();
      expect(inferenceQueue.getState()).toBe('paused');

      inferenceQueue.resume();

      expect(inferenceQueue.getState()).toBe('running');
    });
  });

  describe('notify()', () => {
    it('does not throw when queue is stopped', () => {
      expect(() => inferenceQueue.notify()).not.toThrow();
    });

    it('does not throw when queue is running', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();

      expect(() => inferenceQueue.notify()).not.toThrow();
    });
  });

  describe('onDrain()', () => {
    it('fires drain callback when no pending jobs exist', async () => {
      const drainCb = jest.fn();
      inferenceQueue.onDrain(drainCb);

      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(15);

      expect(drainCb).toHaveBeenCalledTimes(1);
    });

    it('drain callbacks are one-shot (removed after firing)', async () => {
      const drainCb = jest.fn();
      inferenceQueue.onDrain(drainCb);

      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(10);

      // Advance past sleep, trigger second iteration
      jest.runAllTimers();
      await flushMicrotasks(10);

      // Still only 1 call — one-shot
      expect(drainCb).toHaveBeenCalledTimes(1);
    });

    it('can register multiple drain callbacks', async () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      inferenceQueue.onDrain(cb1);
      inferenceQueue.onDrain(cb2);

      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(15);

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('job execution', () => {
    // In each of these tests: first dequeueJob call returns the job, subsequent calls return null
    // (no more jobs). The handler completes synchronously so currentJobPromise settles before
    // the next dequeueJob. The loop then sees null, fires drain, and goes to sleep — at which
    // point safeStop() can cleanly terminate it.

    it('executes a topic_gen job via handleTopicGenJob', async () => {
      const job = makeFakeJob({
        id: 'j1',
        jobType: 'topic_gen',
        payload: { factId: 'f1', factStatement: 'test' },
      });
      mockHandleTopicGenJob.mockResolvedValue({ topics: ['topicA'] });

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      expect(job.markRunning).toHaveBeenCalled();
      expect(mockHandleTopicGenJob).toHaveBeenCalledWith(job.payload);
      expect(job.markDone).toHaveBeenCalledWith({ topics: ['topicA'] });
    });

    it('marks job as failed when handler throws an Error', async () => {
      const job = makeFakeJob({
        id: 'j2',
        jobType: 'topic_gen',
        payload: { factId: 'f1', factStatement: 'test' },
      });
      mockHandleTopicGenJob.mockRejectedValue(new Error('inference crashed'));

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      expect(job.markFailed).toHaveBeenCalledWith('inference crashed');
    });

    it('resets llama context when error has no .message (native crash)', async () => {
      const job = makeFakeJob({
        id: 'j3',
        jobType: 'topic_gen',
        payload: { factId: 'f1', factStatement: 'test' },
      });
      // Error.message is empty string — falsy → triggers native crash path
      const nativeCrash = new Error('');
      mockHandleTopicGenJob.mockRejectedValue(nativeCrash);
      mockResetContext.mockResolvedValue(undefined);

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      // When err.message is falsy the queue calls resetContext
      expect(mockResetContext).toHaveBeenCalled();
    });

    it('marks job as failed for unknown job type without calling any handler', async () => {
      const job = makeFakeJob({
        id: 'j4',
        jobType: 'unknown_type',
        payload: {},
      });

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      expect(job.markFailed).toHaveBeenCalledWith(
        expect.stringContaining('Unknown job type: unknown_type'),
      );
      expect(mockHandleTopicGenJob).not.toHaveBeenCalled();
    });

    it('purges failed jobs when stats.failed > 0', async () => {
      mockGetQueueStats.mockResolvedValue({ pending: 0, running: 0, failed: 3, completed: 0 });
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(15);

      expect(mockPurgeFailedJobs).toHaveBeenCalled();
    });

    it('handles purgeFailedJobs errors gracefully (catch lambda on line 177)', async () => {
      mockGetQueueStats.mockResolvedValue({ pending: 0, running: 0, failed: 1, completed: 0 });
      mockPurgeFailedJobs.mockRejectedValueOnce(new Error('purge failed'));
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(15);

      // Should not throw — error is caught and logged
      expect(inferenceQueue.getState()).toBe('running');
    });

    it('handles drain callback that throws without crashing the loop (line 188)', async () => {
      const throwingCb = jest.fn().mockImplementation(() => {
        throw new Error('drain cb error');
      });
      inferenceQueue.onDrain(throwingCb);
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(15);

      // Callback was called, error was swallowed
      expect(throwingCb).toHaveBeenCalled();
      expect(inferenceQueue.getState()).toBe('running');
    });

    it('handles resetContext error after native crash (catch lambda on line 232)', async () => {
      const job = makeFakeJob({
        id: 'j-crash',
        jobType: 'topic_gen',
        payload: { factId: 'f1', factStatement: 'test' },
      });
      // Error with empty .message to trigger native crash path
      const nativeCrash = new Error('');
      mockHandleTopicGenJob.mockRejectedValue(nativeCrash);
      // resetContext also throws
      mockResetContext.mockRejectedValueOnce(new Error('context reset failed'));

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(30);

      // resetContext was called and its error was swallowed
      expect(mockResetContext).toHaveBeenCalled();
    });
  });

  describe('start() with failed jobs logging', () => {
    it('logs each failed job when stats.failed > 0 on startup (line 88)', async () => {
      mockGetQueueStats.mockResolvedValue({ pending: 0, running: 0, failed: 2, completed: 0 });
      mockGetFailedJobs.mockResolvedValue([
        {
          id: 'fj1',
          jobType: 'topic_gen',
          errorMessage: 'crashed',
          attempts: 3,
          payload: { factId: 'f1' },
        },
      ]);
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(5);

      // logger.warn called for the failed job
      const logger = require('../../logger').default;
      expect(logger.warn).toHaveBeenCalledWith(
        '[InferenceQueue] Failed job',
        expect.objectContaining({ jobId: 'fj1' }),
      );
    });

    it('logs orphan-fact sweep errors on start (line 77)', async () => {
      mockGetActiveTopicGenFactIds.mockResolvedValue(['fact-1']);
      mockMarkOrphanedFactsAsFailed.mockRejectedValueOnce(new Error('sweep error'));
      mockDequeueJob.mockResolvedValue(null);

      await inferenceQueue.start();
      await flushMicrotasks(5);

      const logger = require('../../logger').default;
      expect(logger.error).toHaveBeenCalledWith(
        '[InferenceQueue] Orphan-fact sweep failed',
        expect.any(Error),
      );
    });
  });

  describe('pause() with currentJobPromise (line 123)', () => {
    it('waits for currentJobPromise when pausing mid-job', async () => {
      let resolveJob!: () => void;
      const jobPromise = new Promise<void>((r) => { resolveJob = r; });

      const job = makeFakeJob({ id: 'j-long', jobType: 'topic_gen', payload: {} });
      mockHandleTopicGenJob.mockImplementation(() => jobPromise);

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(10); // let the loop pick up the job

      // Pause while the job is running (currentJobPromise is set)
      const pausePromise = inferenceQueue.pause();
      // Resolve the job
      resolveJob();
      await pausePromise;

      expect(inferenceQueue.getState()).toBe('paused');
    });
  });

  describe('consumeLoop paused branch (lines 165-166)', () => {
    it('loop sleeps and continues when paused', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await flushMicrotasks(5);

      await inferenceQueue.pause();
      expect(inferenceQueue.getState()).toBe('paused');

      // Advance timers so the paused sleep resolves
      jest.runAllTimers();
      await flushMicrotasks(5);

      // Resume so the loop can exit cleanly
      inferenceQueue.resume();
      expect(inferenceQueue.getState()).toBe('running');
    });
  });

  describe('stop() awaits loopPromise (line 108)', () => {
    it('awaits loopPromise when stopping a running queue', async () => {
      mockDequeueJob.mockResolvedValue(null);
      await inferenceQueue.start();
      await flushMicrotasks(5);

      expect(inferenceQueue.getState()).toBe('running');

      // stop() sets state=stopped, wakes the loop, then awaits loopPromise
      const stopPromise = inferenceQueue.stop();
      jest.runAllTimers();
      await flushMicrotasks(10);
      await stopPromise;

      expect(inferenceQueue.getState()).toBe('stopped');
    });
  });

  describe('consumeLoop state-check after dequeue (line 198)', () => {
    it('skips job execution when state becomes non-running after dequeue', async () => {
      const job = makeFakeJob({ id: 'j-skip', jobType: 'topic_gen', payload: {} });
      let callCount = 0;

      mockDequeueJob.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Pause the queue right after dequeue returns the job
          inferenceQueue.stop();
          return job;
        }
        return null;
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(15);

      // Job was dequeued but not executed (state was no longer 'running')
      expect(job.markRunning).not.toHaveBeenCalled();
    });
  });

  describe('job error handling with non-Error thrown values (line 216)', () => {
    it('converts thrown string to error message', async () => {
      const job = makeFakeJob({ id: 'j-str-err', jobType: 'topic_gen', payload: {} });
      // Throw a non-Error truthy value (string)
      mockHandleTopicGenJob.mockRejectedValue('string error');

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      // `err` has no .message but is truthy → String(err) is used
      expect(job.markFailed).toHaveBeenCalledWith('string error');
    });

    it('uses "Native crash" fallback message when err is null/undefined', async () => {
      const job = makeFakeJob({ id: 'j-null-err', jobType: 'topic_gen', payload: {} });
      // Throw null/falsy — covers the `(err ? String(err) : 'Native crash...')` branch
      mockHandleTopicGenJob.mockRejectedValue(null);
      mockResetContext.mockResolvedValue(undefined);

      let callCount = 0;
      mockDequeueJob.mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? job : null);
      });
      mockGetQueueStats.mockResolvedValue({ pending: 1, running: 0, failed: 0, completed: 0 });

      await inferenceQueue.start();
      await flushMicrotasks(25);

      expect(job.markFailed).toHaveBeenCalledWith('Native crash (no error message)');
    });
  });
});
