// Shared Tool Handlers — Used by both on-device LLM and cloud inference chat paths.
// Extracted from on-device-chat-agent.ts so both paths share identical tool execution logic.

import {
  deleteFact,
  getFacts,
  updateFact,
} from '../database/services/fact-service';
import { getSetting } from '../database/services/setting-service';
import { AccountService } from '../account-service';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { useUserStore } from '../stores/user-store';
import { ProcessingMode } from '../generated/graphql-types';
import { enqueueJob, hasPendingJob } from '../database/services/inference-job-service';
import { inferenceQueue } from '../inference/InferenceQueue';
import { cloudComplete, cloudBatchComplete, HEDGE_DELAY_MS } from '../llm/cloudComplete';
import logger from '../logger';
import {
  filterFactChoiceGroups,
  normalizeStatement,
  type FactEntry,
} from '@/lib/news-harness/persona-management/fact-rules';
import { generateTopicsForFactsBatch } from '@/lib/news-harness/persona-management/topic-generation';
import { factChoiceGroupId } from './fact-choice-resolution';
import { buildCloudBatchCallsForFact } from '../mera-protocol/topic-generation-service';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import { getActive, syncLlmTopicsForFact } from '../database/services/topic-service';

/**
 * Topics proposed per fact accepted IN CHAT. A ceiling, not a quota: "up to 4,
 * fewer when the fact supports fewer" — a residence fact earns 3-4, a hobby 1-2.
 *
 * The shipped default was 10, and branch (a-1) of the topic-gen prompt then
 * spent 2 of those on a mandated transport topic and a mandated
 * country-services topic, with filler making up much of the rest ("Hoorn
 * safety", "Hoorn community events" on the device). Capping alone is not the
 * whole fix — the prompt's residence rule has to relax in the same unit, or the
 * mandated pair becomes 2 of 4 instead of 2 of 10.
 */
const CHAT_TOPIC_CEILING = 4;

/** How many other facts the combo half may see. See the buildCalls comment. */
const MAX_OTHER_FACTS_IN_COMBO = 8;

// MAX_FACT_LENGTH's canonical home is the harness fact-rules module; re-exported
// here so existing importers of it from tool-handlers keep working.
export { MAX_FACT_LENGTH } from '@/lib/news-harness/persona-management/fact-rules';

/** How many sections one `explainMera` call may return.
 *
 *  A 3-section answer is already the single largest entry the CLOUD history
 *  budget will carry, so a model asking for all eight is capped rather than
 *  refused: an error there would burn a whole round trip to teach the model
 *  something the first three sections already answer. */
const MAX_EXPLAINER_SECTIONS = 3;

/**
 * `explainMera` — returns Mera's own reference documentation for the model to
 * answer from, so a question about privacy, encryption, the licence or the
 * known gaps is answered from sourced text instead of from memory.
 *
 * Pure read: no database, no network, no side effects. The ~15KB prose module
 * is `require`d LAZILY here (mirroring PersonaUpdateAgent.loadKnownPublicationNames)
 * so it never enters app startup evaluation — it is only ever needed on a turn
 * where the user actually asked.
 *
 * An unknown id returns `{ error, availableTopics }` rather than a partial
 * answer or an empty list: the model can then retry with a real id, which is
 * strictly better than it inventing a guarantee to fill the gap. That is also
 * why a missing/empty `topics` is an error and not a silent default.
 */
export async function handleExplainMera(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { MERA_EXPLAINER_SECTIONS } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./mera-explainer-content') as typeof import('./mera-explainer-content');
  const availableTopics = Object.keys(MERA_EXPLAINER_SECTIONS);

  const requested = args.topics;
  if (!Array.isArray(requested) || requested.length === 0) {
    return {
      error: 'topics must be a non-empty array of topic ids',
      availableTopics,
    };
  }

  const capped = requested.slice(0, MAX_EXPLAINER_SECTIONS);
  const unknown = capped.filter(
    (t) => typeof t !== 'string' || !availableTopics.includes(t),
  );
  if (unknown.length > 0) {
    return {
      error: `Unknown topic(s): ${unknown.map((t) => String(t)).join(', ')}`,
      availableTopics,
    };
  }

  // De-duplicated, order preserved: a repeated id would otherwise pay for the
  // same section twice out of a budget where these are the largest entries.
  const seen = new Set<string>();
  const sections = (capped as string[])
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
    .map((topic) => ({
      topic,
      text: MERA_EXPLAINER_SECTIONS[topic as keyof typeof MERA_EXPLAINER_SECTIONS],
    }));

  return { sections };
}

/** Resolves userId from Zustand store (warm) or WatermelonDB (cold). */
async function getStoredUserId(): Promise<string | null> {
  let userId = useUserStore.getState().userId;
  if (!userId) {
    userId = await getSetting('cached_user_id');
  }
  return userId;
}

/**
 * OFFERS extracted facts for the user to confirm. Writes NOTHING.
 *
 * This used to save every fact and fire topic generation before it returned, so
 * the "Topics I'll track" card was an undo, not a confirmation. That is how
 * "I'm interested in sporting football club" became the saved fact "Interested
 * in sporting a football club" — one inserted article decided that `sporting`
 * was a verb, and topic generation then had no entity to anchor to and fell back
 * to the user's city.
 *
 * Now it returns `pendingFacts` and stops. `commitFactChoices` (fact-commit.ts)
 * does the writing, once the user taps a reading on a FactChoiceCard.
 *
 * `factsSaved: 0` in the returned shape is LOAD-BEARING, not decoration.
 * `deriveThreadItems.deriveCard` falls back to reading this tool's INPUT when
 * `savedFacts` is absent, so without an explicit zero every staged turn would
 * render a "Saved to your persona" card listing candidate statements that were
 * never saved — a lie on the exact surface this change exists to make honest.
 */
export async function handleSaveExtractedFacts(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const facts = args.extracted_user_information as FactEntry[] | undefined;

  if (!Array.isArray(facts) || facts.length === 0) {
    return {
      success: true,
      staged: true,
      factsSaved: 0,
      savedFacts: [],
      conflicts: [],
      groupResolutions: {},
      pendingFacts: [],
    };
  }

  // Load existing facts for dedup — local LLMs often re-emit known facts, and a
  // reading that duplicates one is dropped from the CARD rather than offered and
  // then refused after the tap.
  const existingFacts = await getFacts();
  const existingStatements = existingFacts.map((f) => normalizeStatement(f.statement));

  // The accept/reject DECISIONS stay the harness's pure fact-rules; this handler
  // keeps the side effects, which are now logging and nothing else.
  const { groups, rejected } = filterFactChoiceGroups(facts, existingStatements);

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

  logger.debug('[saveExtractedFacts] staged', {
    groups: groups.length,
    options: groups.map((g) => g.options.length),
  });

  return {
    success: true,
    staged: true,
    factsSaved: 0,
    savedFacts: [],
    conflicts: [],
    // `groupResolutions` is a SCHEMA MARKER written at staging time, NOT "has
    // anyone committed yet". Its PRESENCE is what tells deriveThreadItems that
    // this blob is group-shaped, so both legacy readers (deriveCard's aggregate
    // fact-card and savedFactsWithIds) can be gated on its absence and a
    // pre-change persisted result keeps rendering exactly as it does today.
    // Writing it empty here rather than on first commit means the marker exists
    // for the whole pending window, including a turn nobody ever answers.
    groupResolutions: {},
    pendingFacts: groups.map((g, index) => ({
      index,
      // Stamped now so identity is decided by the staging side once, rather
      // than recomputed at every render from whatever survived validation.
      groupId: factChoiceGroupId(index, g.options),
      options: g.options,
      questionnaireAttribute: g.questionnaire?.attribute ?? null,
    })),
  };
}

/**
 * factIds with a CLOUD topic-generation batch in flight.
 *
 * The local branch is deduped by `hasPendingJob('topic_gen', ...)` against the
 * inference_jobs table, but the cloud branch has no such record — so before this
 * set, a double-tapped Retry (TopicPlanCard) fired two concurrent
 * `cloudBatchComplete` calls for the same fact. Module-level because the guard
 * has to hold across every caller, not per component instance.
 */
const inFlightCloudTopicGen = new Set<string>();

/** Claim the entries not already in flight (synchronously, so two callers in the
 *  same tick cannot both win). Returns only the entries this caller owns. */
function claimTopicGen(
  entries: Array<{ id: string; statement: string }>,
): Array<{ id: string; statement: string }> {
  const claimed = entries.filter((e) => !inFlightCloudTopicGen.has(e.id));
  for (const e of claimed) inFlightCloudTopicGen.add(e.id);
  return claimed;
}

/** True while a cloud topic-generation batch is running for this fact. */
export function isTopicGenerationInFlight(factId: string): boolean {
  return inFlightCloudTopicGen.has(factId);
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
  void startTopicGeneration(savedFactEntries);
}

/**
 * Awaitable form of {@link triggerTopicGeneration}. Same behaviour, but the
 * promise settles when generation does, so a UI retry can keep its button
 * disabled for the real duration instead of guessing. Never rejects.
 */
export async function startTopicGeneration(
  savedFactEntries: Array<{ id: string; statement: string }>,
): Promise<void> {
  if (savedFactEntries.length === 0) return;

  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  if (useCloud) {
    // Cloud path: single batch call for all facts, minus any already running.
    const entries = claimTopicGen(savedFactEntries);
    if (entries.length === 0) return;
    try {
      await batchGenerateTopics(entries);
    } catch (err: unknown) {
      logger.warn('[saveExtractedFacts] Batch topic gen failed', { error: String(err) });
      // The harness catches a batch-call throw and writes topicGenError itself,
      // but a throw from anywhere else (call building, fact reads, metadata
      // writes) escapes it — and a fact with neither topics nor an error leaves
      // TopicPlanCard spinning forever. Record the failure so the card settles.
      await markTopicGenFailed(entries, err);
    } finally {
      for (const e of entries) inFlightCloudTopicGen.delete(e.id);
    }
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

/** Read one fact's current metadata (empty object if it can't be read). */
async function readFactMetadata(factId: string): Promise<Record<string, string[]>> {
  const facts = await getFacts();
  return facts.find((f) => f.id === factId)?.metadata ?? {};
}

/**
 * Records a topic-generation failure the harness didn't record itself, so the
 * fact carries the same `topicGenError` marker every reader already understands
 * (TopicPlanCard, FactAccordion, PersonaL1MeraProtocol).
 */
async function markTopicGenFailed(
  entries: Array<{ id: string; statement: string }>,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  for (const entry of entries) {
    try {
      const metadata = await readFactMetadata(entry.id);
      await updateFact(entry.id, { metadata: { ...metadata, topicGenError: [message] } });
    } catch (writeErr: unknown) {
      logger.warn('[topicGen] Failed to record topicGenError', {
        factId: entry.id,
        error: String(writeErr),
      });
    }
  }
  useFloatingChatStore.getState().notifyFactMutation();
}

/** Drops the stored `topicGenError` so the fact leaves the failed state. */
async function clearTopicGenError(factId: string): Promise<void> {
  const metadata = await readFactMetadata(factId);
  if (!metadata.topicGenError) return;
  const { topicGenError: _dropped, ...rest } = metadata;
  await updateFact(factId, { metadata: rest });
  useFloatingChatStore.getState().notifyFactMutation();
}

/**
 * User-initiated retry of topic generation for ONE fact (TopicPlanCard's failed
 * state). Clears the recorded error, then re-runs the SAME path
 * `startTopicGeneration` uses — no duplicated batch call, and the cloud in-flight
 * claim is what actually makes a double-fire impossible (it is synchronous, so
 * the second of two same-tick retries finds the fact claimed and drops out).
 * Never rejects.
 */
export async function retryTopicGeneration(
  factId: string,
  factStatement: string,
): Promise<void> {
  if (inFlightCloudTopicGen.has(factId)) return; // fast path: already running
  try {
    await clearTopicGenError(factId);
  } catch (err: unknown) {
    logger.warn('[topicGen] Failed to clear topicGenError before retry', {
      factId,
      error: String(err),
    });
  }
  await startTopicGeneration([{ id: factId, statement: factStatement }]);
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
  // Existing topic texts, read ONCE for the whole batch: this is a table scan
  // and the exclude list is identical for every call in it.
  //
  // `getActive()`, NOT `getActiveTopicSnapshots()` — that snapshot type is
  // { id, factId, weight, highPriority } and carries no `text` at all; it
  // exists for the feed's fact-sectioned selector, not for prompt input.
  //
  // Best-effort. A failed topics read must not fail topic generation: the worst
  // case of an empty list is exactly the behaviour that shipped before this,
  // which is a safe direction to degrade in, unlike throwing.
  let existingTopicTexts: string[] = [];
  try {
    existingTopicTexts = (await getActive()).map((t) => t.text);
  } catch (err: unknown) {
    logger.warn('[topicGen] could not read existing topics for exclusion', {
      error: String(err),
    });
  }

  await generateTopicsForFactsBatch(
    {
      llm: {
        // Hedged: this batch runs inside a live chat turn, so a cold primary is
        // dead air the user sits through. The single `complete` below is a
        // background touch-up and stays un-hedged.
        batchComplete: (calls, opts) =>
          cloudBatchComplete(calls, opts?.model, {
            hedgeAfterMs: HEDGE_DELAY_MS,
            lane: 'interactive',
          }),
        complete: (req) => cloudComplete(req, { lane: 'interactive' }),
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
      // call-building seam (prompt constants + mocks) on the call path, and
      // shape its inputs here — all three fields are ones the harness builder
      // already reads and the batch flow simply never set.
      buildCalls: (inputs, idPrefix) =>
        buildCloudBatchCallsForFact(
          {
            ...inputs,
            // A CEILING for a fact accepted in chat, not a quota. Deliberately
            // NOT DEFAULT_HARNESS_CONFIG.topicGen.totalCloud (10), which still
            // governs the "generate more" top-up: proposing and topping up
            // answer different questions, and one number for both either floods
            // a first acceptance or starves a deliberate top-up.
            totalCount: CHAT_TOPIC_CEILING,
            // Bounded because the combo prompt's own stated failure mode is
            // padding: the more unrelated facts it sees, the harder it reaches
            // for a combination that does not exist. Newest-first, since
            // getFacts() sorts created_at DESC, so this keeps what the user
            // most recently said and drops the long tail.
            otherFacts: inputs.otherFacts.slice(0, MAX_OTHER_FACTS_IN_COMBO),
            // The whole point of this change. buildBaseUserPrompt has always had
            // an excludeTopics branch ("Do NOT repeat these existing topics")
            // and the production batch path never filled it, so every fact was
            // generated against a model that could not see the topics the user
            // already had. Only the "generate more" path was passing it.
            excludeTopics: existingTopicTexts,
          },
          idPrefix,
        ),
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
