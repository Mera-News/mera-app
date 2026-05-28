// Topic Generation Service — Real-topic generation + entity-swap decoy pass
// for a single fact. Two stages:
//   1. Real:  Fact-only (+ Combo when other facts exist) — parallel cloud
//             batch or sequential on-device.
//   2. Decoy: Entity-swap pass over the merged real topics — one extra LLM
//             call per fact. Caller batches these together.
// Caller submits real + decoy in ONE SubmitUserTopics mutation. Server
// response is partitioned by text-match against the per-fact decoy set.

import logger from '../logger';
import {
  cloudBatchComplete,
  type BatchCompletionResult,
} from '../llm/cloudComplete';
import type { BatchCall } from '../llm/types';
import { completeLocal } from '../llm/completeLocal';
import {
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
  sanitizeForPrompt,
} from './prompts';
import {
  buildSwapUserPrompt,
  parseSwapOutput,
  swapEntitiesForFact,
  swapMaxTokensFor,
  swapSystemPromptFor,
} from './noise-generation-service';

/**
 * Generates topic strings from a single user fact, fact-only path.
 * Thin wrapper kept for non-handler callers that don't have user-location
 * or other-fact context.
 */
export async function generateTopicsFromFact(
  factStatement: string,
): Promise<string[]> {
  const output = await completeLocal({
    systemPrompt: LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
    prompt: `Fact: "${sanitizeForPrompt(factStatement)}"\nGenerate 14 topics.`,
    maxTokens: 400,
    temperature: 0.3,
    responseFormat: 'json',
    enableThinking: true,
  });
  return parseTopicsFromOutput(output, factStatement);
}

export interface RealTopicGenInputs {
  factStatement: string;
  userLocation: string | null;
  otherFacts: string[];
  useCloud: boolean;
  totalCount?: number;
}

const DEFAULT_TOTAL_CLOUD = 16;
const DEFAULT_TOTAL_LOCAL = 14;

function buildBaseUserPrompt(
  inputs: Pick<RealTopicGenInputs, 'factStatement' | 'userLocation' | 'otherFacts'>,
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
  return prompt;
}

function splitCount(total: number, hasOthers: boolean): { factOnly: number; combo: number } {
  if (!hasOthers) return { factOnly: total, combo: 0 };
  const factOnly = Math.floor(total / 2);
  const combo = total - factOnly;
  return { factOnly, combo };
}

/**
 * Build the up-to-2 real BatchCall entries for one fact: factOnly (always) +
 * combo (when other facts exist). Decoy generation is a SEPARATE second-stage
 * batch — see `buildSwapBatchCallForFact`.
 */
export function buildCloudBatchCallsForFact(
  inputs: Omit<RealTopicGenInputs, 'useCloud'>,
  idPrefix: string,
): BatchCall[] {
  const total = inputs.totalCount ?? DEFAULT_TOTAL_CLOUD;
  const hasOthers = inputs.otherFacts.length > 0;
  const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, hasOthers);
  const calls: BatchCall[] = [];
  if (factOnlyCount > 0) {
    calls.push({
      id: `${idPrefix}:factOnly`,
      system: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
      prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
      temperature: 0.3,
      maxTokens: Math.max(400, factOnlyCount * 30),
    });
  }
  if (comboCount > 0 && hasOthers) {
    calls.push({
      id: `${idPrefix}:combo`,
      system: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
      prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
      temperature: 0.3,
      maxTokens: Math.max(400, comboCount * 30),
    });
  }
  return calls;
}

/**
 * Build the entity-swap BatchCall for one fact. Run as the second-stage batch
 * after real topics are merged.
 */
export function buildSwapBatchCallForFact(
  factStatement: string,
  realTopics: string[],
  idPrefix: string,
): BatchCall {
  return {
    id: `${idPrefix}:swap`,
    system: swapSystemPromptFor(true),
    prompt: buildSwapUserPrompt({ factStatement, realTopics }),
    temperature: 0.3,
    maxTokens: swapMaxTokensFor(realTopics.length),
  };
}

/**
 * Merge the raw factOnly + combo outputs for a single fact into a deduped
 * real-topic list. Order: factOnly first, then combo, deduped
 * case-insensitively.
 */
export function mergeRealOutputsForFact(
  factOnlyOutput: string | null,
  comboOutput: string | null,
  factStatement: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [factOnlyOutput, comboOutput]) {
    if (!raw) continue;
    for (const t of parseTopicsFromOutput(raw, factStatement)) {
      const key = t.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Drop any decoy topic that collides with a real topic (case-insensitive) so
 * the post-submission text-match partition stays clean.
 */
export function filterDecoysAgainstReal(
  decoyTopics: string[],
  realTopics: string[],
): string[] {
  const realSet = new Set(realTopics.map((t) => t.toLowerCase().trim()));
  return decoyTopics.filter((t) => !realSet.has(t.toLowerCase().trim()));
}

export interface GeneratedTopicsForFact {
  realTopics: string[];
  noisyTexts: string[];
  /** Decoy persona-fact (entity-swapped version of the user's Fact). null
   *  when swap wasn't requested or failed. */
  noisyDecoyFact: string | null;
}

/**
 * End-to-end real + decoy generation for a SINGLE fact. Used by the single-
 * fact handler (topic-gen-handler). The multi-fact batch path in
 * tool-handlers uses the lower-level builders directly to share batches.
 *
 * Cloud → two parallel batches (real, then swap). Local → sequential calls.
 */
export async function generateTopicsAndNoiseForFact(
  inputs: RealTopicGenInputs & { includeNoise: boolean },
): Promise<GeneratedTopicsForFact> {
  const total =
    inputs.totalCount ?? (inputs.useCloud ? DEFAULT_TOTAL_CLOUD : DEFAULT_TOTAL_LOCAL);
  const hasOthers = inputs.otherFacts.length > 0;
  const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, hasOthers);

  // -- Stage 1: real topics ------------------------------------------------
  let factOnlyOutput: string | null = null;
  let comboOutput: string | null = null;

  try {
    if (inputs.useCloud) {
      const calls: BatchCall[] = [];
      if (factOnlyCount > 0) {
        calls.push({
          id: 'factOnly',
          system: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
          prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
          temperature: 0.3,
          maxTokens: Math.max(400, factOnlyCount * 30),
        });
      }
      if (comboCount > 0 && hasOthers) {
        calls.push({
          id: 'combo',
          system: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
          prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
          temperature: 0.3,
          maxTokens: Math.max(400, comboCount * 30),
        });
      }
      if (calls.length > 0) {
        const results = (await cloudBatchComplete(calls)) as BatchCompletionResult[];
        for (const r of results) {
          if (r.error) {
            logger.warn('[topic-gen] cloud half failed', { half: r.id, error: r.error });
            continue;
          }
          if (r.id === 'factOnly') factOnlyOutput = r.output;
          else if (r.id === 'combo') comboOutput = r.output;
        }
      }
    } else {
      if (factOnlyCount > 0) {
        try {
          factOnlyOutput = await completeLocal({
            systemPrompt: LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
            prompt: `${buildBaseUserPrompt(inputs, false)}\nGenerate ${factOnlyCount} topics.`,
            maxTokens: Math.max(400, factOnlyCount * 30),
            temperature: 0.3,
            responseFormat: 'json',
            enableThinking: true,
          });
        } catch (err) {
          logger.warn('[topic-gen] local factOnly failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (comboCount > 0 && hasOthers) {
        try {
          comboOutput = await completeLocal({
            systemPrompt: LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
            prompt: `${buildBaseUserPrompt(inputs, true)}\nGenerate ${comboCount} topics.`,
            maxTokens: Math.max(400, comboCount * 30),
            temperature: 0.3,
            responseFormat: 'json',
            enableThinking: true,
          });
        } catch (err) {
          logger.warn('[topic-gen] local combo failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[topic-gen] real-stage failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const realTopics = mergeRealOutputsForFact(factOnlyOutput, comboOutput, inputs.factStatement);

  // -- Stage 2: entity-swap decoy -----------------------------------------
  if (!inputs.includeNoise || realTopics.length === 0) {
    return { realTopics, noisyTexts: [], noisyDecoyFact: null };
  }

  const swap = await swapEntitiesForFact({
    factStatement: inputs.factStatement,
    realTopics,
    useCloud: inputs.useCloud,
  });

  const noisyTexts = filterDecoysAgainstReal(swap.topics, realTopics);
  return { realTopics, noisyTexts, noisyDecoyFact: swap.decoyFact };
}

/** Back-compat: real topics only. */
export async function generateRealTopicsForFact(
  inputs: RealTopicGenInputs,
): Promise<string[]> {
  const { realTopics } = await generateTopicsAndNoiseForFact({
    ...inputs,
    includeNoise: false,
  });
  return realTopics;
}

export function parseTopicsFromOutput(output: string, factStatement: string): string[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
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
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
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

/** Re-export so callers that previously imported merge helpers don't break. */
export { parseSwapOutput };
