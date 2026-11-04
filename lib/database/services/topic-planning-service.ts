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

import { enqueueJob, getActiveTopicGenFactIds, hasPendingJob } from './inference-job-service';
import { getByFact } from './topic-service';
import { getFacts, isRemovableEmptyFact, patchMetadata, removeEmptyFact, EMPTY_FACT_MIN_AGE_MS, EMPTY_FACT_REQUIRED_RUNS } from './fact-service';
import { countEmptyFactRemovals } from './persona-change-log-service';
import {
  LEGACY_EMPTY_ERROR,
  SECOND_RETRY_GAP_MS,
  TOPICS_EMPTY_RUNS,
  TOPICS_EMPTY_SINCE,
  TOPICS_RETRY_AT,
  markTopicGenerationSettled,
  settleEmptyTopicGeneration,
} from './topic-generation-status-service';
import { useNetworkStore } from '../../stores/network-store';
import { useSchedulerStore } from '../../scheduler/scheduler-store';
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
      if (out.outcome === 'error') return { mode: 'skipped', added: 0 };
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

/** shortcut: a queue that never drains (a type deferred for long) ends the wait
 *  here and reads as what has landed so far; a real error on device reads as
 *  nothing new. Upgrade by reading the job row's outcome. */
const QUEUED_RUN_WAIT_MS = 90_000;

/**
 * Generate more as both surfaces need it: resolves when the run is over, with
 * the rows it added, on either engine. An on-device run is a queued job, so its
 * count is the difference in rows once the queue drains.
 */
export async function generateMoreAndWait(
  factId: string,
  factStatement: string,
  opts: { skillId?: string; count?: number } = {},
): Promise<GenerateMoreOutcome> {
  const before = (await getByFact(factId)).length;
  const out = await generateMoreTopicsForFact(factId, factStatement, opts);
  if (out.mode !== 'queued') return out;
  await new Promise<void>((resolve) => {
    inferenceQueue.onDrain(resolve);
    setTimeout(resolve, QUEUED_RUN_WAIT_MS);
  });
  return { mode: 'queued', added: Math.max(0, (await getByFact(factId)).length - before) };
}

/** T9 is the staging proof. Off, the sweep still retries and settles; it removes nothing. */
const AUTO_DELETE_ENABLED = false;
const MAX_LADDERS_PER_SWEEP = 3;
const MAX_REMOVALS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A device clock set back and forward again can leave a stamp in the future. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

const onScreen = new Map<string, number>();

/** A fact on screen is never removed under the reader. Returns the release. */
export function holdFactOnScreen(factId: string): () => void {
  onScreen.set(factId, (onScreen.get(factId) ?? 0) + 1);
  return () => {
    const left = (onScreen.get(factId) ?? 1) - 1;
    if (left > 0) onScreen.set(factId, left);
    else onScreen.delete(factId);
  };
}

let sweeping = false;

/**
 * The empty-fact lifecycle, one pass per foreground. Stuck facts move onto it,
 * due facts get a background ladder, and only a sweep that ran no ladder may
 * remove a fact, so nothing goes in the session that last asked about it.
 */
export async function sweepTopicLifecycle(
  { now = Date.now(), autoDelete = AUTO_DELETE_ENABLED }: { now?: number; autoDelete?: boolean } = {},
): Promise<{ ladders: number; removed: number }> {
  if (sweeping || useSchedulerStore.getState().isRunning('feed-sync')) return { ladders: 0, removed: 0 };
  sweeping = true;
  try {
    const facts = await getFacts();
    const live = await getActiveTopicGenFactIds();

    for (const fact of facts) {
      if (fact.topicsStatus !== 'error' || fact.metadata?.topicGenError?.[0] !== LEGACY_EMPTY_ERROR) continue;
      if (live.has(fact.id)) continue;
      if ((await getByFact(fact.id)).length > 0) await markTopicGenerationSettled([fact.id]);
      else await settleEmptyTopicGeneration(fact.id, fact.statement);
    }

    const useCloud = useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;
    const online = useNetworkStore.getState().isConnected;
    const clocked = (await getFacts()).filter(
      (f) => f.topicsStatus === 'done' && f.metadata?.[TOPICS_EMPTY_SINCE] != null && !live.has(f.id),
    );

    let ladders = 0;
    for (const fact of clocked) {
      const meta = fact.metadata as unknown as Record<string, number | boolean | undefined>;
      if (meta.news_stopped === true) continue;
      const since = Number(meta[TOPICS_EMPTY_SINCE]);
      const retryAt = Number(meta[TOPICS_RETRY_AT] ?? 0);
      const runs = Number(meta[TOPICS_EMPTY_RUNS] ?? 0);
      if (since > now + CLOCK_TOLERANCE_MS || retryAt > now + SECOND_RETRY_GAP_MS + CLOCK_TOLERANCE_MS) {
        await patchMetadata(fact.id, {
          ...(since > now + CLOCK_TOLERANCE_MS ? { [TOPICS_EMPTY_SINCE]: now } : {}),
          [TOPICS_RETRY_AT]: now,
        });
        continue;
      }
      if (runs >= EMPTY_FACT_REQUIRED_RUNS || now < retryAt || ladders >= MAX_LADDERS_PER_SWEEP) continue;
      if (useCloud && !online) continue;
      await enqueueJob('topic_gen', { factId: fact.id, factStatement: fact.statement, useCloud, background: true });
      ladders++;
    }
    if (ladders > 0) inferenceQueue.notify();

    if (!autoDelete || ladders > 0) return { ladders, removed: 0 };
    if ((await countEmptyFactRemovals(now - DAY_MS)) >= MAX_REMOVALS_PER_DAY) return { ladders, removed: 0 };
    for (const fact of clocked) {
      if (!isRemovableEmptyFact(fact) || onScreen.has(fact.id)) continue;
      if (Number(fact.metadata?.[TOPICS_EMPTY_RUNS] ?? 0) < EMPTY_FACT_REQUIRED_RUNS) continue;
      if (now - Number(fact.metadata?.[TOPICS_EMPTY_SINCE]) < EMPTY_FACT_MIN_AGE_MS) continue;
      // One per sweep: the inbox row names one fact and its Add it back one draft.
      if (await removeEmptyFact(fact.id, fact.statement, now)) return { ladders, removed: 1 };
    }
    return { ladders, removed: 0 };
  } finally {
    sweeping = false;
  }
}
