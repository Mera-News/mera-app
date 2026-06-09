// Handler for topic_gen jobs — runs fact-only + combo prompts (parallel on
// cloud, sequential on-device) and saves the resulting topic texts to the fact.

import { buildAttributeTextToIdMap } from '../../mera-protocol/questionnaire-data';
import {
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import { generateTopicsForFact } from '../../mera-protocol/topic-generation-service';
import { useChatPopupStore } from '../../stores/chat-popup-store';
import logger from '../../logger';

export interface TopicGenPayload {
  factId: string;
  factStatement: string;
  useCloud?: boolean;
}

export interface TopicGenResult {
  topics: string[];
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
    return { topics: [] };
  }

  await updateFact(payload.factId, { metadata: { topics: realTopics } });
  useChatPopupStore.getState().notifyFactMutation();
  return { topics: realTopics };
}
