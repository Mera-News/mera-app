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
import { getSetting } from '../database/services/setting-service';
import { AccountService } from '../account-service';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { useUserStore } from '../stores/user-store';
import { ProcessingMode } from '../generated/graphql-types';
import { enqueueJob, hasPendingJob } from '../database/services/inference-job-service';
import { inferenceQueue } from '../inference/InferenceQueue';
import { getAttributeKeysForLevel, TOTAL_LEVELS } from '../mera-protocol/questionnaire-data';
import { cloudComplete, cloudBatchComplete } from '../llm/cloudComplete';
import logger from '../logger';
import {
  filterNewFacts,
  normalizeStatement,
  type FactEntry,
} from '@/lib/news-harness/persona-management/fact-rules';
import { generateTopicsForFactsBatch } from '@/lib/news-harness/persona-management/topic-generation';
import { detectFactConflicts } from '@/lib/news-harness/persona-management/fact-conflict';
import { buildCloudBatchCallsForFact } from '../mera-protocol/topic-generation-service';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import { syncLlmTopicsForFact } from '../database/services/topic-service';

// MAX_FACT_LENGTH's canonical home is the harness fact-rules module; re-exported
// here so existing importers of it from tool-handlers keep working.
export { MAX_FACT_LENGTH } from '@/lib/news-harness/persona-management/fact-rules';

/** Resolves userId from Zustand store (warm) or WatermelonDB (cold). */
async function getStoredUserId(): Promise<string | null> {
  let userId = useUserStore.getState().userId;
  if (!userId) {
    userId = await getSetting('cached_user_id');
  }
  return userId;
}

/** Saves extracted facts to local DB, immediately generates topics and submits to server. */
export async function handleSaveExtractedFacts(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const facts = args.extracted_user_information as FactEntry[] | undefined;

  let factsSaved = 0;
  const savedFactEntries: Array<{ id: string; statement: string }> = [];
  // Enriched with the questionnaire attribute so save-time conflict detection can
  // match on the attribute key (see detectFactConflicts).
  const savedFactsForConflict: Array<{
    id: string;
    statement: string;
    questionnaireAttribute?: string | null;
  }> = [];
  let conflicts: ReturnType<typeof detectFactConflicts> = [];

  if (Array.isArray(facts) && facts.length > 0) {
    // Load existing facts for dedup — local LLMs often re-emit known facts.
    const existingFacts = await getFacts();
    const existingStatements = existingFacts.map((f) => normalizeStatement(f.statement));

    // The accept/reject DECISIONS are the harness's pure fact-rules; this handler
    // keeps the side effects (logging, DB writes, notify, topic-gen trigger).
    const { accepted, rejected } = filterNewFacts(facts, existingStatements);

    for (const r of rejected) {
      if (r.reason === 'too-long') {
        logger.warn('Rejected fact exceeding max length', {
          length: r.statement.length,
          preview: r.statement.substring(0, 80),
        });
      } else if (r.reason === 'meta') {
        logger.debug('Rejected meta-conversational fact', { statement: r.statement });
      }
    }

    for (const a of accepted) {
      // Save fact locally (Rule #1: facts never leave the device)
      const savedFact = await addFact(a.statement, undefined, a.questionnaire);
      factsSaved++;
      savedFactEntries.push({ id: savedFact.id, statement: a.statement });
      savedFactsForConflict.push({
        id: savedFact.id,
        statement: a.statement,
        questionnaireAttribute: a.questionnaire?.attribute ?? null,
      });
    }

    // Save-time conflict detection (U-B1) — deterministic, no LLM call. Compares
    // the just-saved facts against the PRE-existing bank so the chat can surface a
    // ConflictResolutionCard when the user seems to be correcting an earlier fact.
    conflicts = detectFactConflicts(
      savedFactsForConflict,
      existingFacts.map((f) => ({
        id: f.id,
        statement: f.statement,
        questionnaireAttribute: f.questionnaireAttribute ?? null,
      })),
    );

    // Notify once after all facts are saved (avoids WatermelonDB cache race from per-fact notifications)
    useFloatingChatStore.getState().notifyFactMutation();

    // Generate topics for all new facts
    triggerTopicGeneration(savedFactEntries);
  }

  return {
    success: true,
    factsSaved,
    savedFacts: savedFactEntries,
    conflicts,
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
 * Batch-generates real topics for all facts in ONE cloud API call. Thin adapter
 * over the harness `generateTopicsForFactsBatch`: builds the LLM + persona-store
 * ports from `cloudBatchComplete` + the fact-service, runs the harness flow, then
 * notifies the chat store. The harness owns the location lookup, call building,
 * result decoding, and metadata writes; observable behaviour is unchanged.
 */
async function batchGenerateTopics(
  factEntries: Array<{ id: string; statement: string }>,
): Promise<void> {
  await generateTopicsForFactsBatch(
    {
      llm: {
        batchComplete: (calls, opts) => cloudBatchComplete(calls, opts?.model),
        complete: (req) => cloudComplete(req),
      },
      personaStore: {
        getFacts: () => getFacts(),
        updateFactMetadata: async (id, metadata) => {
          // Legacy dual-write: keep the fact.metadata.topics string list exactly
          // as before (older code paths + the config panel still read it).
          await updateFact(id, { metadata });
          // Wave 11 gap-fix: ALSO mint `topics` rows so generated topics reach the
          // wave-7 feed retrieval (which reads the topics TABLE, not metadata).
          // Deduped per fact so re-generation never duplicates.
          if (Array.isArray(metadata.topics) && metadata.topics.length > 0) {
            await syncLlmTopicsForFact(id, metadata.topics).catch((err: unknown) =>
              logger.warn('[saveExtractedFacts] topic-row minting failed', {
                factId: id,
                error: String(err),
              }),
            );
          }
        },
      },
      logger: appHarnessLogger,
      // Inject the topic-generation-service builder so the app keeps a single
      // call-building seam (prompt constants + mocks) on the call path.
      buildCalls: buildCloudBatchCallsForFact,
    },
    factEntries,
  );

  useFloatingChatStore.getState().notifyFactMutation();
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

/**
 * Issues a server-authoritative LLM warning. The server increments
 * llmWarningCount and blocks the user at count >= 3. On success we sync the
 * returned persona into the user store + WatermelonDB so the local cache (and
 * the config-panel banner) stay authoritative across restarts.
 *
 * Fails OPEN: a network hiccup returns blocked:false so a transient error never
 * wrongly locks a user out of the chat.
 */
export async function handleIssueWarning(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = (args.reason as string) ?? 'No reason provided';
  const userId = await getStoredUserId();

  if (!userId) {
    logger.warn('[issueWarning] No userId available — failing open', { reason });
    return {
      blocked: false,
      warningCount: 0,
      message: `Warning issued: ${reason}`,
    };
  }

  try {
    const persona = await AccountService.issueLlmWarning(userId, reason);

    // Sync the authoritative persona into the reactive store (config-panel
    // banner updates live) and persist to WatermelonDB (survives restart).
    useUserStore.getState().setUserPersona(persona);

    logger.warn('[issueWarning] Warning issued', {
      reason,
      warningCount: persona.llmWarningCount,
      blocked: persona.blockedByLlm,
    });

    if (persona.blockedByLlm) {
      return {
        blocked: true,
        warningCount: persona.llmWarningCount,
        message:
          persona.blockedByLlmReason ??
          'User has been blocked due to repeated warnings.',
      };
    }

    return {
      blocked: false,
      warningCount: persona.llmWarningCount,
      message: `Warning ${persona.llmWarningCount}/3 issued: ${reason}`,
    };
  } catch (error) {
    // Fail open — never block a user because of a transient network error.
    logger.captureException(error, {
      tags: { service: 'tool-handlers', method: 'handleIssueWarning' },
      extra: { userId },
    });
    return {
      blocked: false,
      warningCount: 0,
      message: `Warning issued: ${reason}`,
    };
  }
}
