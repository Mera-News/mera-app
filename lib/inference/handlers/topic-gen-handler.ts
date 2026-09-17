// Handler for topic_gen jobs — runs fact-only + combo prompts (parallel on
// cloud, sequential on-device) and saves the resulting topic texts to the fact.

import { resolveUserLocationFact } from '../../news-harness/persona-management/topic-generation';
import {
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import {
  generateTopicsForFact,
  mergeTopicsAppend,
} from '../../mera-protocol/topic-generation-service';
import { syncLlmTopicsForFact } from '../../database/services/topic-service';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { getActive } from '../../database/services/topic-service';
import { getDeclinedTopicTexts } from '../../database/services/topic-decline-service';
import {
  completeTopicGeneration,
  failTopicGeneration,
} from '../../database/services/topic-generation-status-service';
import { generateTopicsForFact as generateViaSkill } from '@/lib/mera-harness';
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
 * Assemble the location + other-facts context for topic generation. The user's
 * own location (primary residence only) is used for geographic anchoring.
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
 * The exclusion lists, read at RUN time.
 *
 * NOT from the payload. A snapshot taken at enqueue is durable and wrong: two
 * facts accepted in one turn enqueue two jobs in the same tick, and the queue
 * drains serially, so only a live read lets job 2 see what job 1 minted.
 *
 * Best-effort: a failure degrades to generating without exclusions rather than
 * failing the job, because a fact with no topics is worse than a fact with a
 * near-duplicate.
 */
async function readExclusionsNow(factId: string): Promise<{
  existingTopics: string[];
  declinedTopics: string[];
}> {
  const existingTopics = await getActive()
    // `getActive()`, NOT `getActiveTopicSnapshots()`: that snapshot type is
    // { id, factId, weight, highPriority } and carries no `text` at all.
    .then((rows) => rows.map((r) => r.text).filter(Boolean))
    .catch((err: unknown) => {
      logger.warn('[topic-gen] active-topic read failed', { factId, error: String(err) });
      return [] as string[];
    });
  const declinedTopics = await getDeclinedTopicTexts().catch((err: unknown) => {
    logger.warn('[topic-gen] declined-topic read failed', { factId, error: String(err) });
    return [] as string[];
  });
  return { existingTopics, declinedTopics };
}

/**
 * The SKILL-GUIDED path: one terminal call whose whole system prompt is the
 * composed guideline for the kind the chat turn chose. Cloud only -- the
 * on-device path keeps the shipped prompt, because the harness's model port is
 * a cloud completion and the local engine has its own.
 */
async function runSkillGuided(
  payload: TopicGenPayload,
  otherFacts: string[],
): Promise<{ topics: string[]; dropped: { veto: number; filter: number } }> {
  const { existingTopics, declinedTopics } = await readExclusionsNow(payload.factId);

  const out = await generateViaSkill({
    fact: { statement: payload.factStatement },
    skillId: payload.skillId,
    otherFacts,
    existingTopics,
    declinedTopics,
    model: SMALL_MODEL,
    deps: {
      callModel: async (req) => {
        const started = Date.now();
        const content = await cloudComplete(
          {
            systemPrompt: req.systemPrompt,
            prompt: req.messages[0]?.content ?? '',
            model: req.model,
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
  return { topics: out.topics, dropped: out.dropped };
}

export async function handleTopicGenJob(
  payload: TopicGenPayload,
): Promise<TopicGenResult> {
  const allFacts = await getFacts();
  const { userLocation, otherFacts } = buildTopicGenContext(allFacts, payload.factId);

  // SKILL-GUIDED when the chat turn named a guideline AND this is the cloud
  // path. A payload with no skillId is a job from an older bundle, and it takes
  // the shipped path below unchanged.
  if (payload.skillId && payload.useCloud) {
    try {
      const { topics } = await runSkillGuided(payload, otherFacts);
      if (topics.length === 0) {
        await failTopicGeneration(payload.factId, 'Topic generation returned no usable topics');
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

  logger.debug('[topic-gen] starting', {
    factId: payload.factId,
    useCloud: payload.useCloud ?? false,
    mode: payload.mode ?? 'replace',
    otherFactCount: otherFacts.length,
  });

  const realTopics = await generateTopicsForFact({
    factStatement: payload.factStatement,
    userLocation,
    otherFacts,
    useCloud: payload.useCloud ?? false,
    totalCount: payload.totalCount,
    excludeTopics: payload.excludeTopics,
  });

  logger.debug('[topic-gen] generated', {
    factId: payload.factId,
    realCount: realTopics.length,
  });

  if (realTopics.length === 0) {
    return { topics: [] };
  }

  if (payload.mode === 'append') {
    const fact = allFacts.find((f) => f.id === payload.factId);
    const existing = fact?.metadata?.topics ?? [];
    await updateFact(payload.factId, {
      metadata: {
        ...(fact?.metadata ?? {}),
        topics: mergeTopicsAppend(existing, realTopics),
      },
    });
  } else {
    await updateFact(payload.factId, { metadata: { topics: realTopics } });
  }
  // Wave 11 gap-fix: mint `topics` rows alongside the legacy metadata dual-write
  // so on-device-generated topics reach the wave-7 feed retrieval. Deduped per
  // fact, so this is safe across regeneration + append runs.
  await syncLlmTopicsForFact(payload.factId, realTopics).catch((err: unknown) =>
    logger.warn('[topic-gen] topic-row minting failed', {
      factId: payload.factId,
      error: String(err),
    }),
  );
  useFloatingChatStore.getState().notifyFactMutation();
  return { topics: realTopics };
}
