// Handler for topic_combo jobs: the DEFERRED COMBINATION PASS (ux2 F3).
//
// Topic generation per fact is isolated (topic-gen-handler.ts). The topics
// that exist only because two facts sit side by side ("Portugal nurse pay
// dispute" from a nurse living in Porto) come from here, once per fact, after
// a Profile chat that changed facts closes. Cloud only: on-device mode gets
// isolated topics and nothing else (owner decision).
//
// ONE batched cloud call per run: this job's fact plus up to seven pending
// siblings of the same pass (the gateway's batch concurrency). Each fact gets
// its own call over itself plus up to 25 supporting facts, newest first, with
// no location line. Results are deduped against every topic on the device, the
// full declined list and each other, then written per fact as a diff by
// `applyComboTopicsForFact`, which also marks that fact's job done.
//
// THE QUEUE OWNS THE HEAD JOB: it marked it running and settles it from this
// handler's return or throw (a deferrable throw re-pends it with no attempt
// spent). The SIBLINGS are this handler's: claimed here, so every one not
// applied must be given back with `releaseComboJobs`, or it sits 'running'
// until the next launch and holds the pass open.

import {
  COMBO_SIBLING_LIMIT,
  applyComboTopicsForFact,
  claimSiblings,
  dropPendingComboJobs,
  readProcessingModeSetting,
  releaseComboJobs,
} from '../../database/services/combo-pass-service';
import { getFacts } from '../../database/services/fact-service';
import { getAllNormalizedTexts, normalizeTopicText } from '../../database/services/topic-service';
import { getAllDeclinedNormalizedTexts } from '../../database/services/topic-decline-service';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import { SMALL_MODEL } from '../../llm/constants';
import { ProcessingMode } from '../../generated/graphql-types';
import {
  COMBO_PASS_MAX_TOPICS,
  COMBO_PASS_TOPIC_SYSTEM_PROMPT,
  buildComboPassUserMessage,
} from '../../news-harness/prompts/persona-prompts';
import { parseTopicsFromOutput } from '../../news-harness/persona-management/topic-generation';
import { planTopupTopicRows } from '../../news-harness/persona-management/topic-topup';
import { isDeferrableError } from '../job-defer';
import logger from '../../logger';
import type { JobContext } from '../InferenceQueue';

export interface TopicComboPayload {
  factId: string;
  passId: string;
}

/** Supporting facts per call, newest first. */
export const COMBO_MAX_SUPPORTING_FACTS = 25;
const COMBO_TEMPERATURE = 0.3;
/** Four topics plus JSON is well under this; thinking is off. */
const COMBO_MAX_TOKENS = 400;

export async function handleTopicComboJob(
  payload: TopicComboPayload,
  ctx: JobContext,
): Promise<{ applied: number }> {
  // The setting row, NOT the store: the queue can run before hydration, when
  // the store still holds its cloud default.
  if ((await readProcessingModeSetting()) !== ProcessingMode.Cloud) {
    await dropPendingComboJobs();
    return { applied: 0 };
  }

  const siblings = (await claimSiblings(payload.passId, COMBO_SIBLING_LIMIT - 1)).filter(
    (s) => s.jobId !== ctx.jobId,
  );
  /** Siblings not yet applied or given back. Emptied as each settles. */
  const outstanding = new Set(siblings.map((s) => s.jobId));
  const work = [{ jobId: ctx.jobId, factId: payload.factId }, ...siblings];

  try {
    const facts = await getFacts();
    const byId = new Map(facts.map((f) => [f.id, f]));
    const calls: { id: string; system: string; prompt: string; temperature: number; maxTokens: number; enableThinking: false }[] = [];
    let applied = 0;

    for (const w of work) {
      const fact = byId.get(w.factId);
      const supporting = fact
        ? facts.filter((f) => f.id !== fact.id).slice(0, COMBO_MAX_SUPPORTING_FACTS).map((f) => f.statement)
        : [];
      if (!fact || supporting.length === 0) {
        // Deleted since the pass was queued, or nothing to combine with: an
        // empty apply clears any stale combo rows and settles the job.
        await applyComboTopicsForFact(w.factId, [], w.jobId);
        outstanding.delete(w.jobId);
        continue;
      }
      calls.push({
        id: w.jobId,
        system: COMBO_PASS_TOPIC_SYSTEM_PROMPT,
        prompt: buildComboPassUserMessage(fact.statement, supporting, COMBO_PASS_MAX_TOPICS),
        temperature: COMBO_TEMPERATURE,
        maxTokens: COMBO_MAX_TOKENS,
        enableThinking: false,
      });
    }
    if (calls.length === 0) return { applied };

    const results = await cloudBatchComplete(calls, SMALL_MODEL, { lane: 'background' });
    const byCall = new Map(results.map((r) => [r.id, r]));

    // Every topic on the device and every declined text, then each accepted
    // text as it lands, so two facts in one batch cannot mint near twins.
    const seen = new Set<string>([...(await getAllNormalizedTexts()), ...(await getAllDeclinedNormalizedTexts())]);
    let headError: string | null = null;

    for (const w of work) {
      const call = calls.find((c) => c.id === w.jobId);
      if (!call) continue;
      const result = byCall.get(w.jobId);
      const error = !result ? 'no result for this fact' : result.error ?? null;
      if (error) {
        if (w.jobId === ctx.jobId) headError = error;
        else {
          await releaseComboJobs([w.jobId], { error });
          outstanding.delete(w.jobId);
        }
        continue;
      }
      const statement = byId.get(w.factId)?.statement ?? '';
      const texts = planTopupTopicRows(seen, parseTopicsFromOutput(result!.output, statement), normalizeTopicText)
        .map((row) => row.text)
        .slice(0, COMBO_PASS_MAX_TOPICS);
      for (const t of texts) seen.add(normalizeTopicText(t));
      await applyComboTopicsForFact(w.factId, texts, w.jobId);
      outstanding.delete(w.jobId);
      applied++;
    }

    if (headError !== null) throw new Error(headError);
    return { applied };
  } catch (err: unknown) {
    if (outstanding.size > 0) {
      const outcome = isDeferrableError(err)
        ? ('defer' as const)
        : { error: err instanceof Error ? err.message : String(err) };
      await releaseComboJobs([...outstanding], outcome).catch((releaseErr: unknown) =>
        logger.error('[topic-combo] releasing siblings failed', releaseErr, { passId: payload.passId }),
      );
    }
    throw err;
  }
}
