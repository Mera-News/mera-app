// Handler for topic_gen jobs: ISOLATED topics for one fact (ux2 F1), through
// the skill core on cloud and the local engine on device. Combination topics
// come only from the deferred pass (topic-combo-handler.ts), cloud only.

import { getFacts } from '../../database/services/fact-service';
import { enqueueJob } from '../../database/services/inference-job-service';
import { generateTopicsForFact } from '../../mera-protocol/topic-generation-service';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { getByFact, normalizeTopicText } from '../../database/services/topic-service';
import { getAllDeclinedNormalizedTexts } from '../../database/services/topic-decline-service';
import {
  completeTopicGeneration,
  failTopicGeneration,
  markTopicGenerationSettled,
  noteUnreadableLadder,
  settleEmptyTopicGeneration,
} from '../../database/services/topic-generation-status-service';
import { describeFactPlaces } from '../../news-harness/persona-management/fact-places';
import { generateTopicsForFact as generateViaSkill, topicSkillForAttribute } from '@/lib/mera-harness';
import { flushRemovedFacts } from '../../chat-session/chat-session';
import { resolveEmptyChatFact } from '../../chat-session/fact-removal';
import { cloudComplete } from '../../llm/cloudComplete';
import { isOnDeviceMode } from '../../llm/on-device-gate';
import { isOnDeviceDeferrable } from '../job-defer';
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
  /** A scheduled retry of an empty fact: nobody is waiting, so it shows nothing
   *  and an error here changes nothing. */
  background?: boolean;
}

export type TopicGenOutcome = 'added' | 'nothing-new' | 'empty' | 'error';

export interface TopicGenResult {
  topics: string[];
  outcome: TopicGenOutcome;
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
  /** Any row at all, of any status: "empty" means none. A failed read says yes,
   *  so a bad read can never put a fact on the road to removal. */
  hasAnyTopics: boolean;
  declined: Set<string>;
}> {
  const rows = await getByFact(factId).catch((err: unknown) => {
    logger.warn('[topic-gen] own-topic read failed', { factId, error: String(err) });
    return null;
  });
  const ownTopics = (rows ?? [])
    // NOT combo rows (ux2 F6): they name OTHER facts' subjects, and an
    // isolated call shown them drifts onto those subjects.
    .filter((r) => r.status === 'active' && r.provenance !== 'combo')
    .map((r) => r.text)
    .filter(Boolean);
  const declined = await getAllDeclinedNormalizedTexts().catch((err: unknown) => {
    logger.warn('[topic-gen] declined-topic read failed', { factId, error: String(err) });
    return new Set<string>();
  });
  return { ownTopics, hasAnyTopics: rows === null || rows.length > 0, declined };
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

class UnreadableAnswerError extends Error {}

/** The model answered, in a form no parser reads. Unlike a transport failure a
 *  retry costs model calls, so these are the errors that are counted. */
function isUnreadableAnswer(err: unknown): boolean {
  return err instanceof UnreadableAnswerError || (err as { code?: unknown } | null)?.code === 'ERR_STRUCTURED_OUTPUT';
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
): Promise<{ topics: string[]; dropped: { veto: number; filter: number } }> {
  const out = await generateViaSkill({
    // Places are read from the fact now, never from the job payload.
    fact: {
      statement: fact.statement,
      questionnaireAttribute: fact.questionnaireAttribute ?? null,
      ...(describeFactPlaces(fact) ? { places: describeFactPlaces(fact)! } : {}),
    },
    skillId: payload.skillId ?? topicSkillForAttribute(fact.questionnaireAttribute),
    existingTopics: ownTopics,
    declinedTopics: [...declined],
    model: SMALL_MODEL,
    append: payload.mode === 'append',
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
  if (out.malformed) throw new UnreadableAnswerError('Topic generation returned an unreadable answer');
  return { topics: out.topics, dropped: out.dropped };
}

/** What a run reports. Never the statement or a topic text: both are persona content. */
function topicGenFailureContext(payload: TopicGenPayload, fact: Fact): Record<string, unknown> {
  return {
    skillId: payload.skillId ?? topicSkillForAttribute(fact.questionnaireAttribute),
    attribute: fact.questionnaireAttribute ?? null,
  };
}

/** Stale means the fact was reworded or deleted while the ladder ran. */
async function currentStatement(factId: string): Promise<string | null> {
  return (await getFacts()).find((f) => f.id === factId)?.statement ?? null;
}

export async function handleTopicGenJob(payload: TopicGenPayload): Promise<TopicGenResult> {
  try {
    return await runTopicGen(payload);
  } finally {
    // The last job of a batch fires it, so several empty facts make one reply.
    await flushRemovedFacts(payload.factId).catch((err: unknown) => {
      logger.warn('[topic-gen] removal note did not fire', { error: String(err) });
    });
  }
}

async function runTopicGen(payload: TopicGenPayload): Promise<TopicGenResult> {
  const allFacts = await getFacts();
  const fact = allFacts.find((f) => f.id === payload.factId);
  // Deleted before its job ran: nothing to generate for and nothing to settle.
  if (!fact) return { topics: [], outcome: 'nothing-new' };
  const { ownTopics, hasAnyTopics, declined } = await readExclusionsNow(payload.factId);
  const append = payload.mode === 'append';
  const background = payload.background === true;

  let generated: string[];
  let dropped = { veto: 0, filter: 0 };
  try {
    // A job queued in cloud mode runs the on-device branch if the mode has since changed.
    if (payload.useCloud && !(await isOnDeviceMode())) {
      const run = await runSkillGuided(payload, fact, ownTopics, declined);
      generated = run.topics;
      dropped = run.dropped;
    } else {
      // ON-DEVICE: the local engine's own prompt, isolated the same way. No
      // location line and no other facts: a location drawn from ANOTHER fact
      // anchored a non-place fact to it, which is a combination, and on-device
      // mode has no combination pass (owner decision).
      generated = await generateTopicsForFact({
        factStatement: fact.statement,
        userLocation: null,
        otherFacts: [],
        useCloud: false,
        totalCount: payload.totalCount,
        excludeTopics: [...ownTopics, ...declined],
      });
    }
  } catch (err: unknown) {
    if (isOnDeviceDeferrable(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[topic-gen] run failed', { factId: payload.factId, message });
    // Generate more and a scheduled retry change nothing: the fact's topics and
    // its status are not this run's to touch, and an error is never an empty.
    if (!append && !background) {
      // captureException, not captureMessage: its classifier keeps a dead
      // session, offline or a missing credential out of Sentry.
      logger.captureException(err, {
        level: 'warning',
        fingerprint: ['topic-gen-failed', 'threw'],
        tags: { service: 'topic-gen' },
        extra: topicGenFailureContext(payload, fact),
      });
      await failTopicGeneration(payload.factId, message);
    }
    if (background && isUnreadableAnswer(err)) await noteUnreadableLadder(payload.factId);
    return { topics: [], outcome: 'error' };
  }

  const statement = await currentStatement(payload.factId);
  if (statement !== fact.statement) {
    // The answer is about words the fact no longer says. A first run owes the
    // new wording its own run; the job that asked for it was deduped behind this one.
    if (statement !== null && !append && !background) {
      await enqueueJob('topic_gen', { ...payload, factStatement: statement });
    }
    return { topics: [], outcome: 'nothing-new' };
  }

  const topics = freshTopics(generated, ownTopics, declined);
  // Persona content, so DEBUG only: console under EXPO_PUBLIC_VERBOSE_LOGS, a breadcrumb in dev builds, nothing in prod.
  logger.debug('[topic-gen] generated', { fact: fact.statement, returned: generated, kept: topics });
  if (topics.length > 0) {
    await completeTopicGeneration(payload.factId, topics);
    useFloatingChatStore.getState().notifyFactMutation();
    return { topics, outcome: 'added' };
  }

  if (append) {
    await settleEmptyTopicGeneration(payload.factId, fact.statement, { onlyIfClockRunning: true });
    return { topics: [], outcome: 'nothing-new' };
  }
  if (hasAnyTopics) {
    await markTopicGenerationSettled([payload.factId]);
    return { topics: [], outcome: 'nothing-new' };
  }
  // No capture: an empty answer is a normal state now. The split still reads
  // from a breadcrumb: "the model said nothing" against "a filter ate everything".
  logger.warn('[topic-gen] settled empty', {
    ...topicGenFailureContext(payload, fact),
    coreReturned: generated.length,
    veto: dropped.veto,
    filter: dropped.filter,
  });
  await settleEmptyTopicGeneration(payload.factId, fact.statement, { background });
  if (!background) await resolveEmptyChatFact(payload.factId, fact.statement);
  useFloatingChatStore.getState().notifyFactMutation();
  return { topics: [], outcome: 'empty' };
}
