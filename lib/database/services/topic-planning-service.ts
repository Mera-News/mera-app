// Topic-Planning Service (Wave 11 U-B2) — the "generate more topics" action for
// the in-chat TopicPlanCard. Mints ADDITIONAL topics for one fact, excluding the
// texts the fact already owns (so the model never repeats them). Respects the
// user's processing-mode privacy choice: cloud mode runs the one-shot cloud
// generation inline; on-device mode enqueues an append job on the inference
// queue (so it never contends with chat for llama.rn on the main thread).
//
// Both paths reuse handleTopicGenJob, which does the legacy metadata dual-write
// AND the Wave-11 `topics`-row minting (via topic-service.syncLlmTopicsForFact),
// so the new rows reach the feed and the widget's observeByFact query updates
// reactively.

import { getByFact } from './topic-service';
import { enqueueJob, hasPendingJob } from './inference-job-service';
import { handleTopicGenJob } from '../../inference/handlers/topic-gen-handler';
import { inferenceQueue } from '../../inference/InferenceQueue';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import logger from '../../logger';

export interface GenerateMoreOutcome {
  /** 'inline' when cloud generation completed synchronously (rows already
   *  minted); 'queued' when an on-device job was enqueued (rows arrive async). */
  mode: 'inline' | 'queued' | 'skipped';
}

/**
 * Generate additional topics for a fact, excluding its existing topic texts.
 * Fire-and-forget-safe: cloud errors are logged and surfaced as a 'skipped'
 * outcome rather than thrown, so the widget never crashes on a transient error.
 */
export async function generateMoreTopicsForFact(
  factId: string,
  factStatement: string,
): Promise<GenerateMoreOutcome> {
  const existing = await getByFact(factId);
  const excludeTopics = existing.map((t) => t.text);

  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  if (useCloud) {
    try {
      await handleTopicGenJob({
        factId,
        factStatement,
        useCloud: true,
        mode: 'append',
        excludeTopics,
      });
      return { mode: 'inline' };
    } catch (err) {
      logger.warn('[topic-planning] cloud generate-more failed', {
        factId,
        error: String(err),
      });
      return { mode: 'skipped' };
    }
  }

  // On-device: enqueue an append job (deduped against an in-flight one).
  if (await hasPendingJob('topic_gen', 'factId', factId)) {
    return { mode: 'skipped' };
  }
  await enqueueJob('topic_gen', {
    factId,
    factStatement,
    useCloud: false,
    mode: 'append',
    excludeTopics,
  });
  inferenceQueue.notify();
  return { mode: 'queued' };
}
