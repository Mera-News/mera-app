// Shared Tool Handlers — Used by both on-device LLM and cloud inference chat paths.
// Extracted from on-device-chat-agent.ts so both paths share identical tool execution logic.

import {
  addFact,
  deleteFact,
  getFacts,
  updateFact,
  getCoveredAttributeKeys,
  getQuestionnaireLevel,
  setQuestionnaireLevel,
} from '../database/services/fact-service';
import { getSetting, setSetting } from '../database/services/setting-service';
import { AccountService } from '../account-service';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { useUserStore } from '../stores/user-store';
import { ProcessingMode } from '../generated/graphql-types';
import { enqueueJob, hasPendingJob } from '../database/services/inference-job-service';
import { inferenceQueue } from '../inference/InferenceQueue';
import { getAttributeKeysForLevel, TOTAL_LEVELS, buildAttributeTextToIdMap } from '../mera-protocol/questionnaire-data';
import { cloudBatchComplete, type BatchCompletionResult } from '../llm/cloudComplete';
import {
  buildCloudBatchCallsForFact,
  mergeRealOutputsForFact,
} from '../mera-protocol/topic-generation-service';
import type { BatchCall } from '../llm/types';
import logger from '../logger';

export const MAX_FACT_LENGTH = 200;

/** Resolves userId from Zustand store (warm) or WatermelonDB (cold). */
async function getStoredUserId(): Promise<string | null> {
  let userId = useUserStore.getState().userId;
  if (!userId) {
    userId = await getSetting('cached_user_id');
  }
  return userId;
}

/** A fact entry from the LLM — either a plain string (legacy) or object with questionnaire metadata. */
type FactEntry = string | {
  statement: string;
  questionnaire_level?: number;
  questionnaire_level_category?: string;
  questionnaire_attribute?: string;
};

function normalizeFactEntry(entry: FactEntry): {
  statement: string;
  questionnaire?: {
    level?: number;
    levelCategory?: string;
    attribute?: string;
  };
} {
  if (typeof entry === 'string') {
    return { statement: entry };
  }
  return {
    statement: entry.statement ?? '',
    questionnaire: (entry.questionnaire_level || entry.questionnaire_level_category || entry.questionnaire_attribute)
      ? {
          level: entry.questionnaire_level,
          levelCategory: entry.questionnaire_level_category,
          attribute: entry.questionnaire_attribute,
        }
      : undefined,
  };
}

/** Saves extracted facts to local DB, immediately generates topics and submits to server. */
export async function handleSaveExtractedFacts(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const facts = args.extracted_user_information as FactEntry[] | undefined;

  let factsSaved = 0;
  const savedFactEntries: Array<{ id: string; statement: string }> = [];

  if (Array.isArray(facts) && facts.length > 0) {
    // Load existing facts for dedup — local LLMs often re-emit known facts
    const existingFacts = await getFacts();
    const normalizeStatement = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const existingStatements = new Set(existingFacts.map(f => normalizeStatement(f.statement)));

    for (const factEntry of facts) {
      const { statement, questionnaire } = normalizeFactEntry(factEntry);
      const trimmed = statement.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_FACT_LENGTH) {
        logger.warn('Rejected fact exceeding max length', {
          length: trimmed.length,
          preview: trimmed.substring(0, 80),
        });
        continue;
      }

      // Skip meta-conversational facts (LLM hallucinating actions as facts)
      const lower = trimmed.toLowerCase();
      if (/^user\s+(is|wants?|asked?|greeted|said|requested)\b/.test(lower) ||
          /\b(setting up|update|updating|set up)\s+(persona|profile|preferences)\b/.test(lower)) {
        logger.debug('Rejected meta-conversational fact', { statement: trimmed });
        continue;
      }

      // Skip duplicate facts
      if (existingStatements.has(normalizeStatement(trimmed))) {
        continue;
      }

      // Save fact locally (Rule #1: facts never leave the device)
      const savedFact = await addFact(trimmed, undefined, questionnaire);
      factsSaved++;
      savedFactEntries.push({ id: savedFact.id, statement: trimmed });
    }

    // Notify once after all facts are saved (avoids WatermelonDB cache race from per-fact notifications)
    useFloatingChatStore.getState().notifyFactMutation();

    // Generate topics for all new facts
    triggerTopicGeneration(savedFactEntries);
  }

  return {
    success: true,
    factsSaved,
    savedFacts: savedFactEntries,
  };
}

/**
 * Kicks off topic generation for newly-saved facts. Cloud mode issues one
 * batch call; on-device mode enqueues an individual job per fact for
 * sequential llama.rn access. Fire-and-forget — errors are logged, never
 * thrown. Shared by chat fact-saving and the proposal executor.
 */
export function triggerTopicGeneration(
  savedFactEntries: Array<{ id: string; statement: string }>,
): void {
  if (savedFactEntries.length === 0) return;

  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  if (useCloud) {
    // Cloud path: single batch call for all facts
    batchGenerateTopics(savedFactEntries).catch((err: unknown) =>
      logger.warn('[saveExtractedFacts] Batch topic gen failed', { error: String(err) }),
    );
  } else {
    // Local path: enqueue individual jobs for sequential llama.rn access
    for (const entry of savedFactEntries) {
      hasPendingJob('topic_gen', 'factId', entry.id).then((exists) => {
        if (!exists) {
          enqueueJob('topic_gen', {
            factId: entry.id,
            factStatement: entry.statement,
            useCloud: false,
          }).then(() => inferenceQueue.notify());
        }
      }).catch((err: unknown) => logger.warn('Failed to enqueue topic gen', { error: String(err) }));
    }
  }
}

/**
 * Batch-generates real topics for all facts in ONE cloud API call.
 * Each fact contributes up to 2 BatchCall entries (fact-only + combo).
 * Generated topics are saved to fact.metadata.topics locally.
 */
async function batchGenerateTopics(
  factEntries: Array<{ id: string; statement: string }>,
): Promise<void> {
  logger.debug('[topic-gen-batch] starting', { factCount: factEntries.length });

  const allFacts = await getFacts();
  const attrTextToId = buildAttributeTextToIdMap();
  const userOwnLocationIds = new Set(['q1_location', 'q4_neighborhood']);
  const userLocation = allFacts.find((f) => {
    if (!f.questionnaireAttribute) return false;
    const attrId = attrTextToId.get(f.questionnaireAttribute);
    return attrId !== undefined && userOwnLocationIds.has(attrId);
  });

  const realCalls: BatchCall[] = [];
  for (const entry of factEntries) {
    const otherFacts = allFacts
      .filter((f) => f.id !== entry.id && f.id !== userLocation?.id)
      .map((f) => f.statement);
    realCalls.push(
      ...buildCloudBatchCallsForFact(
        {
          factStatement: entry.statement,
          userLocation: userLocation?.statement ?? null,
          otherFacts,
        },
        entry.id,
      ),
    );
  }

  logger.debug('[topic-gen-batch] calling batch-infer', {
    callCount: realCalls.length,
    factCount: factEntries.length,
  });
  let realResults: BatchCompletionResult[];
  try {
    realResults = await cloudBatchComplete(realCalls);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('[topic-gen-batch] cloud batch threw', { error: errMsg });
    for (const entry of factEntries) {
      await updateFact(entry.id, { metadata: { topicGenError: [errMsg] } });
    }
    useFloatingChatStore.getState().notifyFactMutation();
    return;
  }
  logger.debug('[topic-gen-batch] response', { resultCount: realResults.length });

  // Re-key results into per-fact (factOnly, combo) buckets.
  type RealBucket = {
    factOnly: string | null;
    combo: string | null;
    halfErrors: string[];
  };
  const realOutputsByFactId = new Map<string, RealBucket>();
  for (const result of realResults) {
    const sep = result.id.lastIndexOf(':');
    if (sep === -1) {
      logger.warn('[topic-gen-batch] unexpected result id', { id: result.id });
      continue;
    }
    const factId = result.id.slice(0, sep);
    const half = result.id.slice(sep + 1) as 'factOnly' | 'combo';
    const bucket: RealBucket = realOutputsByFactId.get(factId) ?? {
      factOnly: null,
      combo: null,
      halfErrors: [],
    };
    if (result.error) {
      bucket.halfErrors.push(`${half}: ${result.error}`);
      logger.warn('[topic-gen-batch] half failed', { factId, half, error: result.error });
    } else {
      bucket[half] = result.output;
    }
    realOutputsByFactId.set(factId, bucket);
  }

  // Merge real topics per fact.
  for (const entry of factEntries) {
    const bucket = realOutputsByFactId.get(entry.id);
    if (!bucket) {
      await updateFact(entry.id, {
        metadata: { topicGenError: ['No topic-gen result returned'] },
      });
      continue;
    }
    const real = mergeRealOutputsForFact(bucket.factOnly, bucket.combo, entry.statement);
    if (real.length === 0) {
      const errMsg =
        bucket.halfErrors.length > 0
          ? bucket.halfErrors.join('; ')
          : 'Topic generation returned no usable topics';
      logger.warn('[topic-gen-batch] no topics parsed', { factId: entry.id });
      await updateFact(entry.id, { metadata: { topicGenError: [errMsg] } });
      continue;
    }
    await updateFact(entry.id, { metadata: { topics: real } });
  }

  useFloatingChatStore.getState().notifyFactMutation();
  logger.debug('[topic-gen-batch] done');
}

/** Updates user language config immediately on the server (settings, not PII). */
export async function handleUpdateUserConfig(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const languageCodes = args.language_codes as string[] | undefined;

  if (!Array.isArray(languageCodes)) {
    return { success: true, message: 'No config fields provided' };
  }

  const config = { language_codes: languageCodes };

  // Immediate fire-and-forget server update
  const userId = await getStoredUserId();
  if (userId) {
    AccountService.updateUserConfig(userId, config)
      .catch(err => logger.warn('[updateUserConfig] Server update failed', { error: String(err) }));
  } else {
    logger.warn('[updateUserConfig] No userId available — skipping server update');
  }

  return {
    success: true,
    language_codes: config.language_codes,
  };
}

/**
 * Deletes facts from local DB by their local IDs.
 * Supports fallback matching by statement text — the small on-device LLM
 * sometimes provides the fact text instead of the UUID from [brackets].
 */
export async function handleDeleteUserFacts(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const factIds = args.fact_ids as string[] | undefined;

  if (!Array.isArray(factIds) || factIds.length === 0) {
    return { error: 'fact_ids must be a non-empty array' };
  }

  // Resolve all facts to delete (by ID, attribute key, or statement text)
  const allFacts = await getFacts();
  const factsByAttrMap = new Map(
    allFacts
      .filter(f => f.questionnaireAttribute)
      .map(f => [f.questionnaireAttribute!.toLowerCase().trim(), f]),
  );
  const factsByIdMap = new Map(allFacts.map(f => [f.id, f]));
  const factsByTextMap = new Map(allFacts.map(f => [f.statement.toLowerCase().trim(), f]));

  const factsToDelete: typeof allFacts = [];
  const seenIds = new Set<string>();
  for (const rawId of factIds) {
    const trimmed = rawId.trim().replace(/^\[|\]$/g, '');
    const fact =
      factsByAttrMap.get(trimmed.toLowerCase())
      ?? factsByIdMap.get(trimmed)
      ?? factsByTextMap.get(trimmed.toLowerCase());

    if (!fact) {
      logger.warn('[deleteUserFacts] Fact not found', { input: trimmed });
      continue;
    }
    if (!seenIds.has(fact.id)) {
      seenIds.add(fact.id);
      factsToDelete.push(fact);
    }
  }

  if (factsToDelete.length === 0) {
    return { success: true, deletedCount: 0, deletedStatements: [] };
  }

  // Snapshot statements before deletion so fact cards can render what was removed.
  const deletedStatements = factsToDelete.map((fact) => fact.statement);

  let deletedCount = 0;
  for (const fact of factsToDelete) {
    await deleteFact(fact.id);
    deletedCount++;
  }
  useFloatingChatStore.getState().notifyFactMutation();

  return { success: true, deletedCount, deletedStatements };
}

/** Advances questionnaire to the next level. */
export async function handleAdvanceQuestionnaireLevel(): Promise<Record<string, unknown>> {
  const currentLevel = await getQuestionnaireLevel();
  if (currentLevel >= TOTAL_LEVELS) {
    return {
      success: true,
      level: currentLevel,
      message: 'Already at the final level. All questionnaire topics have been covered.',
    };
  }

  // Prevent advancing if no facts gathered for the current level
  const coveredAttributes = await getCoveredAttributeKeys();
  const currentKeys = getAttributeKeysForLevel(currentLevel);
  const anyCovered = currentKeys.some((key) => coveredAttributes.has(key));
  if (!anyCovered) {
    return {
      success: false,
      level: currentLevel,
      message: 'Cannot advance — no facts gathered for current level yet.',
    };
  }

  const nextLevel = currentLevel + 1;
  await setQuestionnaireLevel(nextLevel);

  return {
    success: true,
    previousLevel: currentLevel,
    level: nextLevel,
    totalLevels: TOTAL_LEVELS,
    message: `Advanced to level ${nextLevel} of ${TOTAL_LEVELS}. The next set of topics will be loaded in the next response.`,
  };
}

/** Tracks warning count locally. Blocks chat if warnings reach 3. */
export async function handleIssueWarning(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = (args.reason as string) ?? 'No reason provided';
  const currentCount = parseInt(await getSetting('llm_warning_count') ?? '0', 10);
  const newCount = currentCount + 1;
  await setSetting('llm_warning_count', String(newCount));

  logger.warn('[issueWarning] Warning issued', { reason, warningCount: newCount });

  if (newCount >= 3) {
    return {
      blocked: true,
      warningCount: newCount,
      message: 'User has been blocked due to repeated warnings.',
    };
  }

  return {
    blocked: false,
    warningCount: newCount,
    message: `Warning ${newCount}/3 issued: ${reason}`,
  };
}
