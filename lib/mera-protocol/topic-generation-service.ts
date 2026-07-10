// Topic Generation Service — Real-topic generation for a single fact.
// Two sub-prompts per fact: fact-only + combo (when other facts exist).
// Cloud: parallel batch. On-device: sequential calls.

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
  /** Existing topics the model must not regenerate (used by "generate more"). */
  excludeTopics?: string[];
}

const DEFAULT_TOTAL_CLOUD = 16;
const DEFAULT_TOTAL_LOCAL = 14;

function buildBaseUserPrompt(
  inputs: Pick<RealTopicGenInputs, 'factStatement' | 'userLocation' | 'otherFacts' | 'excludeTopics'>,
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
 * End-to-end real topic generation for a SINGLE fact. Used by the single-
 * fact handler (topic-gen-handler). The multi-fact batch path in
 * tool-handlers uses the lower-level builders directly to share batches.
 *
 * Cloud → two parallel batch calls (factOnly + combo). Local → sequential.
 */
export async function generateTopicsForFact(
  inputs: RealTopicGenInputs,
): Promise<string[]> {
  const total =
    inputs.totalCount ?? (inputs.useCloud ? DEFAULT_TOTAL_CLOUD : DEFAULT_TOTAL_LOCAL);
  const hasOthers = inputs.otherFacts.length > 0;
  const { factOnly: factOnlyCount, combo: comboCount } = splitCount(total, hasOthers);

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

  return mergeRealOutputsForFact(factOnlyOutput, comboOutput, inputs.factStatement);
}

/**
 * Append newly generated topics onto an existing list, deduped
 * case-insensitively (existing order preserved, new topics appended).
 * Used by the "generate more topics" flow.
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

/** Back-compat alias used by generateTopicsFromFact (local-only path). */
export async function generateRealTopicsForFact(
  inputs: RealTopicGenInputs,
): Promise<string[]> {
  return generateTopicsForFact(inputs);
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

