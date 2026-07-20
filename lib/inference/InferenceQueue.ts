// InferenceQueue — Singleton FIFO consumer for on-device LLM jobs.
// Serializes all non-chat llama.rn access. Supports pause/resume for chat priority.

import {
  dequeueJob,
  getQueueStats,
  getFailedJobs,
  recoverCrashedJobs,
  pruneCompletedJobs,
  purgeFailedJobs,
  getActiveTopicGenFactIds,
} from '../database/services/inference-job-service';
import { markOrphanedFactsAsFailed } from '../database/services/fact-service';
import { handleTopicGenJob } from './handlers/topic-gen-handler';
import { handlePersonaSummaryJob } from './handlers/persona-summary-handler';
import { handleStoryHeadlineJob } from './handlers/story-headline-handler';
import { handleTrackProposalJob } from './handlers/track-proposal-handler';
import { resetContext } from '../mera-protocol-toolkit';
import type { InferenceJobType } from '../database/models/InferenceJob';
import logger from '../logger';

type QueueState = 'stopped' | 'running' | 'paused';

type JobHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

// Adapt a strongly-typed handler to the generic JobHandler map signature.
// The payload/result shapes are validated by the handler itself; the queue
// only needs the Record<string, unknown> contract for storage/serialization.
function adaptHandler<P, R>(
  handler: (payload: P) => Promise<R>,
): JobHandler {
  return (p) => handler(p as P) as Promise<Record<string, unknown>>;
}

const JOB_HANDLERS: Record<InferenceJobType, JobHandler> = {
  topic_gen: adaptHandler(handleTopicGenJob),
  persona_summary: adaptHandler(handlePersonaSummaryJob),
  story_headline: adaptHandler(handleStoryHeadlineJob),
  track_proposal: adaptHandler(handleTrackProposalJob),
};

/** Delay between queue polls when no jobs are available (ms). */
const POLL_INTERVAL = 2000;

/** Prune completed jobs older than this (ms). */
const PRUNE_AGE_MS = 60 * 60 * 1000; // 1 hour

class InferenceQueueImpl {
  private state: QueueState = 'stopped';
  private loopPromise: Promise<void> | null = null;
  private wakeResolver: (() => void) | null = null;
  private currentJobPromise: Promise<void> | null = null;
  private drainCallbacks: Array<() => void> = [];

  /**
   * Start the queue consumer loop.
   * Recovers crashed jobs from previous session, then begins processing.
   * Idempotent — safe to call multiple times.
   */
  async start(): Promise<void> {
    if (this.state === 'running') return;

    // Recover any jobs that were 'running' when the app crashed
    await recoverCrashedJobs();
    // Prune old completed jobs
    const pruneDate = new Date(Date.now() - PRUNE_AGE_MS);
    await pruneCompletedJobs(pruneDate).catch(() => {});

    // Rescue facts whose topic_gen job died without setting topicGenError
    // (e.g. max retries exhausted → job destroyed, crash before markFailed).
    // Without this the UI spins on "Generating topics..." forever and the
    // fact becomes effectively undeletable from the user's perspective.
    try {
      const activeFactIds = await getActiveTopicGenFactIds();
      const orphaned = await markOrphanedFactsAsFailed(
        activeFactIds,
        'Topic generation failed — please delete and retry.',
      );
      if (orphaned > 0) {
        logger.warn('[InferenceQueue] Marked orphaned facts as failed', { count: orphaned });
      }
    } catch (err) {
      logger.error('[InferenceQueue] Orphan-fact sweep failed', err);
    }

    const stats = await getQueueStats();
    this.state = 'running';
    this.loopPromise = this.consumeLoop();

    // Log details of any failed jobs for debugging
    if (stats.failed > 0) {
      const failedJobs = await getFailedJobs();
      for (const job of failedJobs) {
        logger.warn('[InferenceQueue] Failed job', {
          jobId: job.id,
          jobType: job.jobType,
          error: job.errorMessage,
          attempts: job.attempts,
          payload: JSON.stringify(job.payload).slice(0, 300),
        });
      }
    }
  }

  /**
   * Stop the queue consumer loop.
   * Waits for the current job to finish, then stops.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;

    this.state = 'stopped';
    this.wake(); // unblock any sleep
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  /**
   * Pause processing and wait for the current job to finish.
   * Used when chat needs exclusive llama.rn access.
   * Must be awaited to guarantee no concurrent llamaContext usage.
   */
  async pause(): Promise<void> {
    if (this.state === 'running') {
      this.state = 'paused';
      if (this.currentJobPromise) {
        await this.currentJobPromise;
      }
    }
  }

  /**
   * Resume processing after a pause.
   */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      this.wake(); // unblock the sleep so it picks up jobs immediately
    }
  }

  /**
   * Notify the queue that a new job was enqueued.
   * Wakes the loop from its poll sleep so it picks up the job faster.
   */
  notify(): void {
    this.wake();
  }

  /** Current queue state. */
  getState(): QueueState {
    return this.state;
  }

  /**
   * Register a callback to be invoked once when the queue has no more pending jobs.
   * Callbacks are one-shot — they fire once and are removed.
   */
  onDrain(callback: () => void): void {
    this.drainCallbacks.push(callback);
  }

  // ── Internal ────────────────────────────────────────────────

  private async consumeLoop(): Promise<void> {
    while (this.state !== 'stopped') {
      // If paused, sleep until resumed or stopped
      if (this.state === 'paused') {
        await this.sleep(POLL_INTERVAL);
        continue;
      }

      const stats = await getQueueStats();
      if (stats.pending > 0 || stats.running > 0 || stats.failed > 0) {
        logger.debug('[InferenceQueue] Queue stats', stats);
      }

      // Auto-delete any lingering failed jobs
      if (stats.failed > 0) {
        await purgeFailedJobs().catch((e) =>
          logger.warn('[InferenceQueue] Failed to purge failed jobs', { error: String(e) }),
        );
      }

      const job = await dequeueJob();
      if (!job) {
        // No pending jobs — fire drain callbacks if any
        if (this.drainCallbacks.length > 0) {
          const callbacks = this.drainCallbacks.splice(0);
          for (const cb of callbacks) {
            try { cb(); } catch (err) {
              logger.error('[InferenceQueue] Drain callback failed', err);
            }
          }
        }
        // Wait before polling again
        await this.sleep(POLL_INTERVAL);
        continue;
      }

      // Check state again after dequeue (might have been paused/stopped while querying)
      if (this.state !== 'running') continue;

      const handler = JOB_HANDLERS[job.jobType];
      if (!handler) {
        logger.error('[InferenceQueue] Unknown job type', { jobType: job.jobType, jobId: job.id });
        await job.markFailed(`Unknown job type: ${job.jobType}`);
        continue;
      }

      const jobExec = (async () => {
        try {
          await job.markRunning();

          const result = await handler(job.payload);
          await job.markDone(result);
        } catch (err) {
          const errorMsg =
            (err as Error)?.message ||
            (err ? String(err) : 'Native crash (no error message)');
          logger.error('[InferenceQueue] Job failed', err, {
            jobId: job.id,
            jobType: job.jobType,
            attempt: job.attempts,
            error: errorMsg,
          });
          await job.markFailed(errorMsg);

          // Native crash (no error message) likely corrupts the llama context.
          // Reset it so the next job gets a fresh context.
          if (!(err as Error)?.message) {
            logger.warn(
              '[InferenceQueue] Native crash detected, resetting llama context',
            );
            await resetContext().catch((e) =>
              logger.error('[InferenceQueue] Context reset failed', e),
            );
          }
        }
      })();

      this.currentJobPromise = jobExec;
      await jobExec;
      this.currentJobPromise = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeResolver = resolve;
      setTimeout(() => {
        this.wakeResolver = null;
        resolve();
      }, ms);
    });
  }

  private wake(): void {
    if (this.wakeResolver) {
      this.wakeResolver();
      this.wakeResolver = null;
    }
  }
}

/** Singleton instance. Import this everywhere. */
export const inferenceQueue = new InferenceQueueImpl();
