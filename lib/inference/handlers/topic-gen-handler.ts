// Handler for topic_gen jobs — runs three sibling prompts (fact-only, combo,
// noise) in parallel on cloud or sequentially on-device, then submits both
// real and noisy texts in ONE SubmitUserTopics mutation. The response is
// partitioned by text-match: real entries write `fact_topic_links`, noisy
// entries write `noisy_user_topics` keyed by fact_id so they share the same
// lifecycle (delete fact → cascade-drops noisy rows via destroyCascade).

import { buildAttributeTextToIdMap } from '../../mera-protocol/questionnaire-data';
import {
  getFacts,
  replaceFactTopicLinks,
  updateFact,
} from '../../database/services/fact-service';
import { getSetting } from '../../database/services/setting-service';
import { submitTopicsToServer } from '../../mera-protocol/interest-submission-service';
import { generateTopicsAndNoiseForFact } from '../../mera-protocol/topic-generation-service';
import { insertNoisyTopics } from '../../database/services/noisy-user-topic-service';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { useChatPopupStore } from '../../stores/chat-popup-store';
import { useUserStore } from '../../stores/user-store';
import logger from '../../logger';

export interface TopicGenPayload {
  factId: string;
  factStatement: string;
  userId?: string;
  /** If true, use cloud engine. If false (or undefined), use local. */
  useCloud?: boolean;
}

export interface TopicGenResult {
  topics: string[];
  submitted: boolean;
}

/** Resolves userId from payload (legacy jobs), Zustand store, or WatermelonDB. */
async function resolveUserId(payload: TopicGenPayload): Promise<string | null> {
  if (payload.userId) return payload.userId;
  const storeId = useUserStore.getState().userId;
  if (storeId) return storeId;
  return getSetting('cached_user_id');
}

export async function handleTopicGenJob(
  payload: TopicGenPayload,
): Promise<TopicGenResult> {
  // Fetch user's own location for geographic anchoring (only primary residence)
  const allFacts = await getFacts();
  const attrTextToId = buildAttributeTextToIdMap();
  const userOwnLocationIds = new Set(['q1_location', 'q4_neighborhood']);
  const userLocation = allFacts.find((f) => {
    if (f.id === payload.factId) return false;
    if (!f.questionnaireAttribute) return false;
    const attrId = attrTextToId.get(f.questionnaireAttribute);
    return attrId !== undefined && userOwnLocationIds.has(attrId);
  });

  const otherFacts = allFacts
    .filter((f) => f.id !== payload.factId && f.id !== userLocation?.id)
    .map((f) => f.statement);

  const injectNoise = useMeraProtocolStore.getState().injectNoise;
  logger.debug('[topic-gen] starting', {
    factId: payload.factId,
    useCloud: payload.useCloud ?? false,
    otherFactCount: otherFacts.length,
    injectNoise,
  });

  const { realTopics, noisyTexts, noisyDecoyFact } =
    await generateTopicsAndNoiseForFact({
      factStatement: payload.factStatement,
      userLocation: userLocation?.statement ?? null,
      otherFacts,
      useCloud: payload.useCloud ?? false,
      includeNoise: injectNoise,
    });

  logger.debug('[topic-gen] generated', {
    factId: payload.factId,
    realCount: realTopics.length,
    noisyCount: noisyTexts.length,
    noisyDecoyFact,
  });

  if (realTopics.length === 0) {
    return { topics: [], submitted: false };
  }

  // Stage real topics in fact metadata for the UI progress ratio.
  await updateFact(payload.factId, { metadata: { topics: realTopics } });

  const userId = await resolveUserId(payload);
  if (!userId) {
    logger.warn('[topic-gen] No userId available — skipping server submission');
    useChatPopupStore.getState().notifyFactMutation();
    return { topics: realTopics, submitted: false };
  }

  try {
    // Submit real + noisy in a SINGLE mutation. Server doesn't distinguish;
    // we partition the response by text-match against the noisy set.
    const noisySet = new Set(noisyTexts.map((t) => t.toLowerCase().trim()));
    const submitted = await submitTopicsToServer(userId, [
      ...realTopics.map((text) => ({ text, sourceFactLocalId: payload.factId })),
      ...noisyTexts.map((text) => ({ text, sourceFactLocalId: payload.factId })),
    ]);

    // Dedupe per (text-half, topicId). A topicId that comes back from BOTH a
    // real and a noisy entry (server-side semantic dedup) is treated as real
    // so we can't accidentally tag a useful cluster as noise.
    const realTopicIds = new Set<string>();
    const linksToWrite: { serverTopicId: string; topicText: string }[] = [];
    const noisyByTopicId = new Map<string, { text: string }>();
    for (const entry of submitted) {
      if (!entry.topicId) continue;
      const isNoise = noisySet.has(entry.text.toLowerCase().trim());
      if (isNoise) {
        if (!noisyByTopicId.has(entry.topicId)) {
          noisyByTopicId.set(entry.topicId, { text: entry.text });
        }
        continue;
      }
      if (realTopicIds.has(entry.topicId)) continue;
      realTopicIds.add(entry.topicId);
      linksToWrite.push({ serverTopicId: entry.topicId, topicText: entry.text });
    }
    await replaceFactTopicLinks(payload.factId, linksToWrite);

    const noisyInserts = [...noisyByTopicId.entries()]
      .filter(([topicId]) => !realTopicIds.has(topicId))
      .map(([topicId, e]) => ({
        serverTopicId: topicId,
        factId: payload.factId,
        newsTopicText: e.text,
        // Persist the decoy persona-fact (Step A of the noise prompt) so the
        // persona-tab debug switch can show what fake user spawned the batch.
        // Falls back to the real fact statement when the model omitted the
        // decoy_fact field (legacy or malformed response).
        parentTopicText: noisyDecoyFact ?? payload.factStatement,
      }));
    if (noisyInserts.length > 0) {
      const personaId = useUserStore.getState().userPersona?._id ?? userId;
      await insertNoisyTopics(personaId, noisyInserts);
    }

    // Shrink fact.metadata.topics to the unique, linked real set so the UI's
    // progress ratio (linked / metadata.topics) converges.
    await updateFact(payload.factId, {
      metadata: { topics: linksToWrite.map((l) => l.topicText) },
    });

    await useUserStore.getState().fetchUserPersona(userId, true);
  } catch (err) {
    logger.error(
      '[topic-gen] failed to submit topics / persist fact_topic_links',
      err,
      { factId: payload.factId, userId },
    );
    const errMsg = err instanceof Error ? err.message : String(err);
    await updateFact(payload.factId, {
      metadata: { topicGenError: [errMsg || 'Failed to link topics'] },
    }).catch((updateErr) =>
      logger.error(
        '[topic-gen] failed to persist topicGenError after submission failure',
        updateErr,
        { factId: payload.factId },
      ),
    );
  }

  useChatPopupStore.getState().notifyFactMutation();
  return { topics: realTopics, submitted: realTopics.length > 0 };
}
