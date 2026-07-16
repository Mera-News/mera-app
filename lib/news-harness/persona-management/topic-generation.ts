// news-harness — pure topic-generation builders + a port-based batch flow.
//
// The pure builders (buildBaseUserPrompt, splitCount, buildCloudBatchCallsForFact,
// mergeRealOutputsForFact, mergeTopicsAppend, parseTopicsFromOutput) were moved
// verbatim from lib/mera-protocol/topic-generation-service.ts. The old file now
// re-exports them (injecting the app logger / prompt constants at the seam so its
// frozen tests keep passing).
//
// generateTopicsForFactsBatch reproduces the cloud batch flow that used to live
// in lib/chat-tools/tool-handlers.ts::batchGenerateTopics, but through ports so
// it never touches WatermelonDB, the cloud client, or the floating-chat store.

import {
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  sanitizeForPrompt,
} from '../prompts/prompts';
import { buildAttributeTextToIdMap } from '../prompts/questionnaire-data';
import { DEFAULT_HARNESS_CONFIG, type TopicGenConfig } from '../core/config';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import type { LlmPort, PersonaStorePort } from '../core/ports';
import type { BatchCall } from '../core/types';

export interface RealTopicGenInputs {
  factStatement: string;
  userLocation: string | null;
  otherFacts: string[];
  useCloud: boolean;
  totalCount?: number;
  /** Existing topics the model must not regenerate (used by "generate more"). */
  excludeTopics?: string[];
}

const TOPIC_CFG = DEFAULT_HARNESS_CONFIG.topicGen;
const DEFAULT_TOTAL_CLOUD = TOPIC_CFG.totalCloud;

/** Optional system-prompt override so the old-path wrapper can inject the
 *  prompt constants from its (test-mockable) `./prompts` import. Defaults to the
 *  real harness prompts for the production batch flow. */
export interface TopicGenSystemPrompts {
  factOnly: string;
  combo: string;
}

export function buildBaseUserPrompt(
  inputs: Pick<
    RealTopicGenInputs,
    'factStatement' | 'userLocation' | 'otherFacts' | 'excludeTopics'
  >,
  includeOthers: boolean,
): string {
  let prompt = `Fact: "${sanitizeForPrompt(inputs.factStatement)}"`;
  if (inputs.userLocation) {
    prompt += `\nUser location: ${sanitizeForPrompt(inputs.userLocation)}`;
  }
  if (includeOthers && inputs.otherFacts.length > 0) {
    prompt += `\nOther user facts:\n${inputs.otherFacts
      .map((s) => `- ${sanitizeForPrompt(s)}`)
      .join('\n')}`;
  }
  if (inputs.excludeTopics && inputs.excludeTopics.length > 0) {
    prompt += `\nDo NOT repeat these existing topics:\n${inputs.excludeTopics
      .map((s) => `- ${sanitizeForPrompt(s)}`)
      .join('\n')}`;
  }
  return prompt;
}

export function splitCount(
  total: number,
  hasOthers: boolean,
): { factOnly: number; combo: number } {
  if (!hasOthers) return { factOnly: total, combo: 0 };
  // 2026-07-16: bias ~60/40 toward fact-only. Fact-only anchored topics
  // (home/city/family) were the best feed-worthy performers in the prod
  // baseline, while the combo path produced most of the wasted-quota noise
  // (country-level fact-bleed, near-synonym variants). At total=10 → 6/4.
  const combo = Math.floor(total * 0.4);
  const factOnly = total - combo;
  return { factOnly, combo };
}

/**
 * Build the up-to-2 real BatchCall entries for one fact: factOnly (always) +
 * combo (when other facts exist).
 */
export function buildCloudBatchCallsForFact(
  inputs: Omit<RealTopicGenInputs, 'useCloud'>,
  idPrefix: string,
  systemPrompts: TopicGenSystemPrompts = {
    factOnly: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    combo: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  },
): BatchCall[] {
  const total = inputs.totalCount ?? DEFAULT_TOTAL_CLOUD;
  const hasOthers = inputs.otherFacts.length > 0;
  const { factOnly: factOnlyCount, combo: comboCount } = splitCount(
    total,
    hasOthers,
  );
  const calls: BatchCall[] = [];
  if (factOnlyCount > 0) {
    calls.push({
      id: `${idPrefix}:factOnly`,
      system: systemPrompts.factOnly,
      prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
      temperature: 0.3,
      maxTokens: Math.max(400, factOnlyCount * 30),
    });
  }
  if (comboCount > 0 && hasOthers) {
    calls.push({
      id: `${idPrefix}:combo`,
      system: systemPrompts.combo,
      prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
      temperature: 0.3,
      maxTokens: Math.max(400, comboCount * 30),
    });
  }
  return calls;
}

/**
 * Merge the raw factOnly + combo outputs for a single fact into a deduped
 * real-topic list. Order: factOnly first, then combo, deduped case-insensitively.
 */
export function mergeRealOutputsForFact(
  factOnlyOutput: string | null,
  comboOutput: string | null,
  factStatement: string,
  logger: HarnessLogger = NOOP_LOGGER,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [factOnlyOutput, comboOutput]) {
    if (!raw) continue;
    for (const t of parseTopicsFromOutput(raw, factStatement, logger)) {
      const key = t.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Append newly generated topics onto an existing list, deduped
 * case-insensitively (existing order preserved, new topics appended).
 */
export function mergeTopicsAppend(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase().trim()));
  const out = [...existing];
  for (const t of incoming) {
    const key = t.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function parseTopicsFromOutput(
  output: string,
  factStatement: string,
  logger: HarnessLogger = NOOP_LOGGER,
): string[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
        .map((s) => s.trim())
        .slice(0, 20);
    }
  } catch {
    const arrayMatch = output.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const extracted: unknown = JSON.parse(arrayMatch[0]);
        if (Array.isArray(extracted)) {
          return extracted
            .filter(
              (item): item is string =>
                typeof item === 'string' && item.trim().length > 0,
            )
            .map((s) => s.trim())
            .slice(0, 20);
        }
      } catch {
        // Fall through
      }
    }
  }

  logger.warn('Topic generation: failed to parse output', { output, factStatement });
  return [];
}

// ---------------------------------------------------------------------------
// Port-based batch flow (reproduces tool-handlers::batchGenerateTopics)
// ---------------------------------------------------------------------------

/** Fact ids whose questionnaire attribute marks them as the USER's own location. */
const USER_OWN_LOCATION_ATTR_IDS = new Set(['q1_location', 'q4_neighborhood']);

/**
 * Batch-generates real topics for all facts in ONE cloud API call. Each fact
 * contributes up to 2 BatchCall entries (fact-only + combo). Generated topics are
 * saved to fact.metadata.topics (or fact.metadata.topicGenError) via the persona
 * store port. Does NOT notify the chat store — the caller does that.
 */
export async function generateTopicsForFactsBatch(
  ports: {
    llm: LlmPort;
    personaStore: PersonaStorePort;
    logger?: HarnessLogger;
    /** Optional call-builder override. Defaults to the harness
     *  buildCloudBatchCallsForFact with the config's system prompts. The app
     *  adapter injects its own so the (test-mockable) old-path builder stays on
     *  the call path. */
    buildCalls?: (
      inputs: Omit<RealTopicGenInputs, 'useCloud'>,
      idPrefix: string,
    ) => BatchCall[];
  },
  factEntries: { id: string; statement: string }[],
  config: TopicGenConfig = TOPIC_CFG,
): Promise<void> {
  const logger = ports.logger ?? NOOP_LOGGER;
  const systemPrompts: TopicGenSystemPrompts = {
    factOnly: config.factOnlySystemPrompt,
    combo: config.comboSystemPrompt,
  };
  const buildCalls =
    ports.buildCalls ??
    ((inputs, idPrefix) =>
      buildCloudBatchCallsForFact(inputs, idPrefix, systemPrompts));
  logger.debug('[topic-gen-batch] starting', { factCount: factEntries.length });

  const allFacts = await ports.personaStore.getFacts();
  const attrTextToId = buildAttributeTextToIdMap();
  const userLocation = allFacts.find((f) => {
    if (!f.questionnaireAttribute) return false;
    const attrId = attrTextToId.get(f.questionnaireAttribute);
    return attrId !== undefined && USER_OWN_LOCATION_ATTR_IDS.has(attrId);
  });

  const realCalls: BatchCall[] = [];
  for (const entry of factEntries) {
    const otherFacts = allFacts
      .filter((f) => f.id !== entry.id && f.id !== userLocation?.id)
      .map((f) => f.statement);
    realCalls.push(
      ...buildCalls(
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

  let realResults;
  try {
    realResults = await ports.llm.batchComplete(realCalls);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('[topic-gen-batch] cloud batch threw', { error: errMsg });
    for (const entry of factEntries) {
      await ports.personaStore.updateFactMetadata(entry.id, {
        topicGenError: [errMsg],
      });
    }
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
      logger.warn('[topic-gen-batch] half failed', {
        factId,
        half,
        error: result.error,
      });
    } else {
      bucket[half] = result.output;
    }
    realOutputsByFactId.set(factId, bucket);
  }

  // Merge real topics per fact.
  for (const entry of factEntries) {
    const bucket = realOutputsByFactId.get(entry.id);
    if (!bucket) {
      await ports.personaStore.updateFactMetadata(entry.id, {
        topicGenError: ['No topic-gen result returned'],
      });
      continue;
    }
    const real = mergeRealOutputsForFact(
      bucket.factOnly,
      bucket.combo,
      entry.statement,
      logger,
    );
    if (real.length === 0) {
      const errMsg =
        bucket.halfErrors.length > 0
          ? bucket.halfErrors.join('; ')
          : 'Topic generation returned no usable topics';
      logger.warn('[topic-gen-batch] no topics parsed', { factId: entry.id });
      await ports.personaStore.updateFactMetadata(entry.id, {
        topicGenError: [errMsg],
      });
      continue;
    }
    await ports.personaStore.updateFactMetadata(entry.id, { topics: real });
  }

  logger.debug('[topic-gen-batch] done');
}
