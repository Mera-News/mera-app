// Handler for topic_gen jobs: ISOLATED topics for one fact (ux2 F1), through
// the skill core on cloud and the local engine on device. Combination topics
// come only from the deferred pass (topic-combo-handler.ts), cloud only.

import { resolveUserLocationFact } from '../../news-harness/persona-management/topic-generation';
import {
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import {
  generateTopicsForFact,
  mergeTopicsAppend,
} from '../../mera-protocol/topic-generation-service';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { getByFact, normalizeTopicText, syncLlmTopicsForFact } from '../../database/services/topic-service';
import { getAllDeclinedNormalizedTexts } from '../../database/services/topic-decline-service';
import {
  completeTopicGeneration,
  failTopicGeneration,
  markTopicGenerationSettled,
} from '../../database/services/topic-generation-status-service';
import { generateTopicsForFact as generateViaSkill, topicSkillForAttribute } from '@/lib/mera-harness';
import { cloudComplete } from '../../llm/cloudComplete';
import { SMALL_MODEL } from '../../llm/constants';
import logger from '../../logger';
import type { Fact } from '../../mera-protocol-toolkit/types';

export interface TopicGenPayload {
  factId: string;
  factStatement: string;
  useCloud?: boolean;
  /** 'append' merges results into existing topics; default replaces them. */
  mode?: 'replace' | 'append';
  totalCount?: number;
  /**
   * LEGACY. Still read so a job enqueued by an older bundle drains correctly,
   * but NEW enqueues must not set it: a snapshot taken at enqueue time is
   * durable and wrong. Two facts accepted in one turn enqueue two jobs in the
   * same tick, so job 2's snapshot predates job 1's writes and job 2 happily
   * regenerates what job 1 just minted. Worse, a job enqueued before an app
   * kill would replay a stale exclusion list days later.
   *
   * The handler reads the live lists itself at RUN time instead.
   */
  excludeTopics?: string[];
  /**
   * The topic guideline chosen UPSTREAM by the chat turn, e.g.
   * `topics/residence`. Absent or unknown falls back to the group generic and
   * never fails: `inference_jobs` is durable, so a job outlives the build that
   * named its skill.
   */
  skillId?: string;
}

export interface TopicGenResult {
  topics: string[];
}

/**
 * DEPRECATE: no longer used by any generation path here (ux2 F1 isolates every
 * run). Kept only while `components/custom/facts/FactsList.tsx` still imports
 * it; delete together with that caller's migration to
 * `generateMoreTopicsForFact`.
 */
export function buildTopicGenContext(
  allFacts: Fact[],
  factId: string,
): { userLocation: string | null; otherFacts: string[] } {
  // Shared with the batch flow (news-harness topic-generation) so the two paths
  // can never disagree about what counts as "where the user lives". This used
  // to require a byte-identical canonical questionnaire attribute, which the
  // chat agent does not always mint — see resolveUserLocationFact's header.
  const userLocation = resolveUserLocationFact(allFacts, { excludeFactId: factId });

  const otherFacts = allFacts
    .filter((f) => f.id !== factId && f.id !== userLocation?.id)
    .map((f) => f.statement);

  return { userLocation: userLocation?.statement ?? null, otherFacts };
}

/**
 * The exclusion lists, read at RUN time: THIS FACT's own topics and EVERY
 * declined topic (ux2 F1). Other facts' topics are not the isolated call's
 * business; the combination pass dedupes across facts.
 *
 * NOT from the payload. A snapshot taken at enqueue is durable and wrong: a job
 * enqueued before an app kill would replay a stale list days later.
 *
 * Best-effort: a failure degrades to generating without exclusions rather than
 * failing the job, because a fact with no topics is worse than a fact with a
 * near-duplicate.
 */
async function readExclusionsNow(factId: string): Promise<{
  ownTopics: string[];
  declined: Set<string>;
}> {
  const ownTopics = await getByFact(factId)
    .then((rows) => rows.filter((r) => r.status === 'active').map((r) => r.text).filter(Boolean))
    .catch((err: unknown) => {
      logger.warn('[topic-gen] own-topic read failed', { factId, error: String(err) });
      return [] as string[];
    });
  const declined = await getAllDeclinedNormalizedTexts().catch((err: unknown) => {
    logger.warn('[topic-gen] declined-topic read failed', { factId, error: String(err) });
    return new Set<string>();
  });
  return { ownTopics, declined };
}

/** What a run may still mint: never a declined text and never one the fact
 *  already owns, both compared in topic-service's normalised form (the core's
 *  own veto only folds case and spaces). */
function freshTopics(topics: string[], ownTopics: string[], declined: Set<string>): string[] {
  const owned = new Set(ownTopics.map(normalizeTopicText));
  const seen = new Set<string>();
  return topics.filter((t) => {
    const key = normalizeTopicText(t);
    if (!key || owned.has(key) || declined.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * CLOUD: one terminal call through the skill core, isolated. The guideline is
 * the one the chat turn chose, else the one the fact's attribute implies, else
 * `topics/generic`.
 */
async function runSkillGuided(
  payload: TopicGenPayload,
  fact: Fact,
  ownTopics: string[],
  declined: Set<string>,
): Promise<string[]> {
  const out = await generateViaSkill({
    fact: { statement: fact.statement, questionnaireAttribute: fact.questionnaireAttribute ?? null },
    skillId: payload.skillId ?? topicSkillForAttribute(fact.questionnaireAttribute),
    existingTopics: ownTopics,
    declinedTopics: [...declined],
    model: SMALL_MODEL,
    ...(payload.totalCount ? { ceiling: payload.totalCount } : {}),
    deps: {
      callModel: async (req) => {
        const started = Date.now();
        const content = await cloudComplete(
          {
            systemPrompt: req.systemPrompt,
            prompt: req.messages[0]?.content ?? '',
            // The core emits a tier label; only the app knows the id.
            model: req.model === 'SMALL' || !req.model ? SMALL_MODEL : req.model,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
          },
          { lane: 'background' },
        );
        return {
          content: typeof content === 'string' ? content : String(content ?? ''),
          toolCalls: [],
          finishReason: 'stop',
          truncated: false,
          usage: null,
          modelSent: req.model,
          latencyMs: Date.now() - started,
          error: null,
        };
      },
    },
  });

  if (out.dropped.veto > 0 || out.dropped.filter > 0) {
    // Split by cause, so "generated zero" is answerable rather than looking
    // identical to a bad prompt.
    logger.warn('[topic-gen] candidates dropped', {
      factId: payload.factId,
      veto: out.dropped.veto,
      filter: out.dropped.filter,
      kept: out.topics.length,
    });
  }
  return out.topics;
}

export async function handleTopicGenJob(
  payload: TopicGenPayload,
): Promise<TopicGenResult> {
  const allFacts = await getFacts();
  const fact = allFacts.find((f) => f.id === payload.factId);
  // Deleted before its job ran: nothing to generate for and nothing to settle.
  if (!fact) return { topics: [] };
  const { ownTopics, declined } = await readExclusionsNow(payload.factId);
  const append = payload.mode === 'append';

  if (payload.useCloud) {
    try {
      const topics = freshTopics(
        await runSkillGuided(payload, fact, ownTopics, declined),
        ownTopics,
        declined,
      );
      if (topics.length === 0) {
        // "Generate more" that found nothing new leaves the fact as it was;
        // a first run with nothing usable is a failure the card can retry.
        if (append) await markTopicGenerationSettled([payload.factId]);
        else await failTopicGeneration(payload.factId, 'Topic generation returned no usable topics');
        return { topics: [] };
      }
      await completeTopicGeneration(payload.factId, topics);
      useFloatingChatStore.getState().notifyFactMutation();
      return { topics };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[topic-gen] skill-guided run failed', { factId: payload.factId, message });
      await failTopicGeneration(payload.factId, message);
      return { topics: [] };
    }
  }

  // ON-DEVICE: the local engine's own prompt, isolated the same way. No
  // location line and no other facts: a location drawn from ANOTHER fact
  // anchored a non-place fact to it, which is a combination, and on-device
  // mode has no combination pass (owner decision).
  const generated = await generateTopicsForFact({
    factStatement: fact.statement,
    userLocation: null,
    otherFacts: [],
    useCloud: false,
    totalCount: payload.totalCount,
    excludeTopics: [...ownTopics, ...declined],
  });
  const realTopics = freshTopics(generated, ownTopics, declined);

  if (realTopics.length === 0) {
    if (append) await markTopicGenerationSettled([payload.factId]);
    else await failTopicGeneration(payload.factId, 'Topic generation returned no usable topics');
    return { topics: [] };
  }

  if (append) {
    const existing = fact.metadata?.topics ?? [];
    await updateFact(payload.factId, {
      metadata: { ...(fact.metadata ?? {}), topics: mergeTopicsAppend(existing, realTopics) },
    });
  } else {
    await updateFact(payload.factId, { metadata: { ...(fact.metadata ?? {}), topics: realTopics } });
  }
  // Mint `topics` rows alongside the legacy metadata write so on-device
  // topics reach feed retrieval. Deduped per fact.
  await syncLlmTopicsForFact(payload.factId, realTopics).catch((err: unknown) =>
    logger.warn('[topic-gen] topic-row minting failed', {
      factId: payload.factId,
      error: String(err),
    }),
  );
  // Stamp-only: the rows are minted above, and `completeTopicGeneration`
  // would mint them a second time.
  await markTopicGenerationSettled([payload.factId]);
  useFloatingChatStore.getState().notifyFactMutation();
  return { topics: realTopics };
}
