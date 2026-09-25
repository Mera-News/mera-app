// Topic-Planning Service (Wave 11 U-B2) — the "generate more topics" action for
// the in-chat cards and the Profile. Mints ADDITIONAL topics for one fact; the
// job itself excludes the texts the fact already owns and every declined one. Respects the
// user's processing-mode privacy choice: cloud mode runs the one-shot cloud
// generation inline; on-device mode enqueues an append job on the inference
// queue (so it never contends with chat for llama.rn on the main thread).
//
// Both paths reuse handleTopicGenJob, which does the legacy metadata dual-write
// AND the Wave-11 `topics`-row minting (via topic-service.syncLlmTopicsForFact),
// so the new rows reach the feed and the widget's observeByFact query updates
// reactively.

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
  /** Rows added by an inline run; 0 for queued and skipped. */
  added: number;
}

/**
 * Generate additional topics for ONE fact, isolated (ux2 F1): the job reads
 * this fact's own topics and every declined topic itself, at run time, so no
 * exclusion snapshot is passed. `skillId` is optional; the handler derives one
 * from the fact's attribute. Never throws: a failure is `skipped`.
 */
export async function generateMoreTopicsForFact(
  factId: string,
  factStatement: string,
  opts: { skillId?: string; count?: number } = {},
): Promise<GenerateMoreOutcome> {
  const extra = {
    ...(opts.skillId ? { skillId: opts.skillId } : {}),
    ...(opts.count ? { totalCount: opts.count } : {}),
  };
  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  if (useCloud) {
    try {
      const out = await handleTopicGenJob({
        factId,
        factStatement,
        useCloud: true,
        mode: 'append',
        ...extra,
      });
      return { mode: 'inline', added: out.topics.length };
    } catch (err) {
      logger.warn('[topic-planning] cloud generate-more failed', {
        factId,
        error: String(err),
      });
      return { mode: 'skipped', added: 0 };
    }
  }

  // On-device: enqueue an append job (deduped against an in-flight one).
  if (await hasPendingJob('topic_gen', 'factId', factId)) {
    return { mode: 'skipped', added: 0 };
  }
  await enqueueJob('topic_gen', {
    factId,
    factStatement,
    useCloud: false,
    mode: 'append',
    ...extra,
  });
  inferenceQueue.notify();
  return { mode: 'queued', added: 0 };
}
