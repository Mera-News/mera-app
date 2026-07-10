// Handler for topic_gen jobs — runs fact-only + combo prompts (parallel on
// cloud, sequential on-device) and saves the resulting topic texts to the fact.

import { buildAttributeTextToIdMap } from '../../mera-protocol/questionnaire-data';
import {
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import {
  generateTopicsForFact,
  mergeTopicsAppend,
} from '../../mera-protocol/topic-generation-service';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import logger from '../../logger';
import type { Fact } from '../../mera-protocol-toolkit/types';

export interface TopicGenPayload {
  factId: string;
  factStatement: string;
  useCloud?: boolean;
  /** 'append' merges results into existing topics; default replaces them. */
  mode?: 'replace' | 'append';
  totalCount?: number;
  excludeTopics?: string[];
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
  const attrTextToId = buildAttributeTextToIdMap();
  const userOwnLocationIds = new Set(['q1_location', 'q4_neighborhood']);
  const userLocation = allFacts.find((f) => {
    if (f.id === factId) return false;
    if (!f.questionnaireAttribute) return false;
    const attrId = attrTextToId.get(f.questionnaireAttribute);
    return attrId !== undefined && userOwnLocationIds.has(attrId);
  });

  const otherFacts = allFacts
    .filter((f) => f.id !== factId && f.id !== userLocation?.id)
    .map((f) => f.statement);

  return { userLocation: userLocation?.statement ?? null, otherFacts };
}

export async function handleTopicGenJob(
  payload: TopicGenPayload,
): Promise<TopicGenResult> {
  const allFacts = await getFacts();
  const { userLocation, otherFacts } = buildTopicGenContext(allFacts, payload.factId);

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
  useFloatingChatStore.getState().notifyFactMutation();
  return { topics: realTopics };
}
