// Handler for topic_gen jobs — runs fact-only + combo prompts (parallel on
// cloud, sequential on-device) then submits the real topic texts to the server
// via SubmitUserTopics. Server response writes `fact_topic_links`.

import { buildAttributeTextToIdMap } from '../../mera-protocol/questionnaire-data';
import {
  getFacts,
  replaceFactTopicLinks,
  updateFact,
} from '../../database/services/fact-service';
import { getSetting } from '../../database/services/setting-service';
import { submitTopicsToServer } from '../../mera-protocol/interest-submission-service';
import { generateTopicsForFact } from '../../mera-protocol/topic-generation-service';
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

  logger.debug('[topic-gen] starting', {
    factId: payload.factId,
    useCloud: payload.useCloud ?? false,
    otherFactCount: otherFacts.length,
  });

  const realTopics = await generateTopicsForFact({
    factStatement: payload.factStatement,
    userLocation: userLocation?.statement ?? null,
    otherFacts,
    useCloud: payload.useCloud ?? false,
  });

  logger.debug('[topic-gen] generated', {
    factId: payload.factId,
    realCount: realTopics.length,
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
    const submitted = await submitTopicsToServer(userId, [
      ...realTopics.map((text) => ({ text, sourceFactLocalId: payload.factId })),
    ]);

    const linksToWrite: { serverTopicId: string; topicText: string }[] = [];
    for (const entry of submitted) {
      if (!entry.topicId) continue;
      linksToWrite.push({ serverTopicId: entry.topicId, topicText: entry.text });
    }
    await replaceFactTopicLinks(payload.factId, linksToWrite);

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
